import test from "node:test";
import assert from "node:assert/strict";
import { convertRequest } from "../src/kiro/converter.ts";
import type { MessagesRequest } from "../src/kiro/types.ts";
import {
  calculateTotalContextTokens,
  estimateTokens,
} from "../src/kiro/token.ts";
import { extractSessionId, mapModel } from "../src/kiro/utils.ts";
import {
  CacheSimulator,
  InMemoryCacheStore,
  MockClock,
  computePrefixHash,
  CACHE_KEY_PREFIX,
} from "../src/kiro/cache-simulation.ts";
import { calculateClaudeCost } from "../src/usage/pricing.ts";
import KiroApiProviderHandler, { stripBillingHeaderCch } from "../src/kiro/handler.ts";
import { successfulKiroStream } from "./helpers.ts";

const user = (content: any) => ({ role: "user", content });
const assistant = (content: any) => ({ role: "assistant", content });

test("conversation conversion preserves consecutive turns, tools and attachments", () => {
  const request: any = {
    model: "claude-sonnet-4.5",
    system: "Follow instructions",
    messages: [
      user("Read both files."),
      assistant([
        {
          type: "tool_use",
          id: "one",
          name: "Read",
          input: { file_path: "/tmp/one" },
        },
      ]),
      assistant([
        {
          type: "tool_use",
          id: "two",
          name: "Read",
          input: { file_path: "/tmp/two" },
        },
      ]),
      user([{ type: "tool_result", tool_use_id: "one", content: "first" }]),
      user([{ type: "tool_result", tool_use_id: "two", content: "second" }]),
      user("Compare these attachments."),
      user([
        {
          type: "image",
          source: { type: "base64", media_type: "image/png", data: "aW1hZ2U=" },
        },
      ]),
      user([
        {
          type: "document",
          title: "example.pdf",
          source: {
            type: "base64",
            media_type: "application/pdf",
            data: "JVBERi0=",
          },
        },
      ]),
    ],
  };
  const original = structuredClone(request);
  const state = convertRequest(request).conversationState;
  // Real turns only: user, merged assistant tool calls. No synthetic system pair.
  assert.equal(state.history?.length, 2);
  assert.equal(
    (state.history![0] as any).userInputMessage.content,
    "Follow instructions\n\nRead both files.",
  );
  assert.equal(
    state.currentMessage.userInputMessage.content,
    "Compare these attachments.",
  );
  assert.deepEqual(state.currentMessage.userInputMessage.images, [
    { format: "png", source: { bytes: "aW1hZ2U=" } },
  ]);
  assert.deepEqual(state.currentMessage.userInputMessage.documents, [
    { format: "pdf", name: "example", source: { bytes: "JVBERi0=" } },
  ]);
  assert.equal(
    state.currentMessage.userInputMessage.userInputMessageContext?.toolResults
      ?.length,
    2,
  );
  assert.deepEqual(request, original);
});

test("model names are translated, never swapped for another model", () => {
  // Same model, Kiro's dotted ID format; date suffixes dropped.
  assert.equal(mapModel("claude-opus-4-6-20260101"), "claude-opus-4.6");
  assert.equal(mapModel("claude-opus-4.6"), "claude-opus-4.6");
  assert.equal(mapModel("claude-sonnet-4-5"), "claude-sonnet-4.5");
  assert.equal(mapModel("claude-opus-5-5"), "claude-opus-5.5");
  assert.equal(mapModel("claude-sonnet-5-5"), "claude-sonnet-5.5");
  assert.equal(mapModel("claude-haiku-4-5-20251001"), "claude-haiku-4.5");
  // No downgrade: Opus stays Opus, Haiku 5.5 stays Haiku 5.5, Fable passes through.
  assert.equal(mapModel("claude-haiku-5-5"), "claude-haiku-5.5");
  assert.equal(mapModel("claude-fable-5-1"), "claude-fable-5.1");
  // Explicit experimental models and the "!" escape hatch.
  assert.equal(mapModel("claude-opus-4-8-20260529", ["claude-opus-4.8"]), "claude-opus-4.8");
  assert.equal(mapModel("!claude-opus-4.7"), "!claude-opus-4.7");
});

test("cache simulation finds longest prefixes and honors TTL", async () => {
  const clock = new MockClock(0);
  const store = new InMemoryCacheStore(clock);
  const simulator = new CacheSimulator(store, 30_000);
  const first = [user("hello")];
  const key = CACHE_KEY_PREFIX + computePrefixHash("system", first);
  await store.set(key, 100, 30_000);
  assert.equal(await store.get(key), 100);
  clock.advance(10_000);
  const hit = await simulator.simulate(
    "system",
    [user("hello"), assistant("hi"), user("next")],
    250,
  );
  assert.equal(hit, 100);
  const fresh = new CacheSimulator(new InMemoryCacheStore(clock), 30_000);
  clock.advance(31_000);
  const miss = await fresh.simulate(
    "system",
    [user("hello"), assistant("hi"), user("next")],
    250,
  );
  assert.equal(miss, 0);
});

test("token windows, CJK estimates and Claude pricing match expected formulas", () => {
  assert.equal(calculateTotalContextTokens(10, "claude-sonnet-4.5"), 20_000);
  assert.equal(calculateTotalContextTokens(10, "claude-opus-5.5"), 100_000);
  assert.equal(estimateTokens("abcd"), 2);
  assert.equal(estimateTokens("你好"), 3);
  const cost = calculateClaudeCost("claude-sonnet-4.5", {
    input_tokens: 1_000_000,
    output_tokens: 1_000_000,
    cache_read_input_tokens: 1_000_000,
    cache_creation_input_tokens: 1_000_000,
  });
  assert.equal(cost.total_cost_usd, 22.05);
});

test("event-stream response becomes an Anthropic message with usage and credits", async () => {
  const handler = new KiroApiProviderHandler(
    new CacheSimulator(new InMemoryCacheStore(new MockClock(0))),
  );
  const request: any = {
    model: "claude-sonnet-4.5",
    messages: [user("hello")],
  };
  const modified: any = {
    conversationState: {
      currentMessage: { userInputMessage: { modelId: "claude-sonnet-4.5" } },
    },
  };
  const result = await handler.transformResponseBody(
    200,
    successfulKiroStream("Hello", 0.5),
    request,
    modified,
  );
  const body: any = result.body;
  assert.equal(body.type, "message");
  assert.equal(body.content[0].text, "Hello");
  assert.equal(
    body.usage.input_tokens +
      body.usage.cache_creation_input_tokens +
      body.usage.cache_read_input_tokens +
      body.usage.output_tokens,
    2000,
  );
  assert.equal(result.headers?.["x-kiro-credit-consumption"], "0.5");
  assert.ok(Number(result.headers?.["x-cost-usd"]) > 0);
});

test("requests carry no injected instructions or synthetic turns", () => {
  const request: MessagesRequest = {
    model: "claude-opus-4-6",
    system: [{ text: "You are a helpful assistant." }],
    thinking: { type: "enabled", budget_tokens: 2000 },
    tools: [
      { name: "Write", description: "Write a file.", input_schema: { type: "object", properties: {} } },
      { name: "Edit", description: "Edit a file.", input_schema: { type: "object", properties: {} } },
    ],
    messages: [
      { role: "user", content: "First question" },
      { role: "assistant", content: "First answer" },
      { role: "user", content: "Second question" },
    ],
  };
  const state = convertRequest(request).conversationState;
  const wire = JSON.stringify(state);
  assert.doesNotMatch(wire, /I will follow these instructions/);
  assert.doesNotMatch(wire, /comply silently|MUST only write the first 50 lines|MUST split it into multiple Edit calls/);
  const [tWrite, tEdit] = state.currentMessage.userInputMessage.userInputMessageContext!.tools!;
  assert.equal(tWrite.toolSpecification.description, "Write a file.");
  assert.equal(tEdit.toolSpecification.description, "Edit a file.");
  // History is exactly the real turns; the system prompt and thinking tags lead the first one.
  assert.equal(state.history!.length, 2);
  const first = (state.history![0] as any).userInputMessage.content;
  assert.match(first, /^<thinking_mode>enabled<\/thinking_mode><max_thinking_length>2000<\/max_thinking_length>\n\nYou are a helpful assistant\.\n\nFirst question$/);
  assert.equal((state.history![1] as any).assistantResponseMessage.content, "First answer");
  assert.equal(state.currentMessage.userInputMessage.content, "Second question");
});

test("a single-turn request puts the system prompt in the current message", () => {
  const state = convertRequest({ model: "claude-sonnet-4-5", system: "Be brief.", messages: [{ role: "user", content: "Hi" }] }).conversationState;
  assert.equal(state.history, undefined);
  assert.equal(state.currentMessage.userInputMessage.content, "Be brief.\n\nHi");
});

test("cache simulation stores every turn for five minutes", async () => {
  const clock = new MockClock(0);
  const simulator = new CacheSimulator(new InMemoryCacheStore(clock));
  const turn = (n: number) => Array.from({ length: n }, (_, i) => ({ role: i % 2 ? "assistant" : "user", content: `m${i}` })) as MessagesRequest["messages"];
  for (let run = 0; run < 20; run++) {
    const sim = new CacheSimulator(new InMemoryCacheStore(new MockClock(0)));
    await sim.simulate("sys", turn(1), 1000, "s");
    assert.equal(await sim.simulate("sys", turn(3), 1500, "s"), 1000, "every turn is stored");
  }
  await simulator.simulate("sys", turn(1), 1000, "s");
  clock.advance(4 * 60 * 1000 + 59_000);
  assert.equal(await simulator.simulate("sys", turn(3), 1500, "s"), 1000, "still cached just under 5 minutes");
  clock.advance(5 * 60 * 1000 + 1000);
  assert.equal(await simulator.simulate("sys", turn(5), 2000, "s"), 0, "expired after 5 minutes");
});

test("the changing cch value is stripped from Claude Code's billing header", async () => {
  const header = (cch: string) => `x-anthropic-billing-header: cc_version=2.1.287; cc_entrypoint=cli; cch=${cch};\nYou are Claude Code.`;
  const request = (cch: string) => ({
    model: "claude-sonnet-4-5",
    system: [{ text: header(cch) }],
    messages: [{ role: "user", content: "hi" }],
  }) as MessagesRequest;
  const one = request("a1b2c"), two = request("f9e8d");
  stripBillingHeaderCch(one);
  stripBillingHeaderCch(two);
  const text = (r: MessagesRequest) => (r.system as Array<{ text: string }>)[0].text;
  assert.equal(text(one), "x-anthropic-billing-header: cc_version=2.1.287; cc_entrypoint=cli;\nYou are Claude Code.");
  assert.equal(text(one), text(two), "different cch, same prompt after stripping");
  const plain = { model: "x", system: "No header here; cch=1", messages: [] } as unknown as MessagesRequest;
  stripBillingHeaderCch(plain);
  assert.equal(plain.system, "No header here; cch=1", "only the billing header line is touched");
});

test("session ids are read from both user_id formats", () => {
  const id = "5b61aed7-21e9-4949-a517-0123456789ab";
  assert.equal(extractSessionId(JSON.stringify({ device_id: "d".repeat(64), account_uuid: "", session_id: id })), id);
  assert.equal(extractSessionId(`user_${"a".repeat(64)}_account__session_${id}`), id);
  assert.equal(extractSessionId('{"session_id":"not-a-uuid"}'), null);
  assert.equal(extractSessionId("no session here"), null);
});
