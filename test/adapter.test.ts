import test from "node:test";
import assert from "node:assert/strict";
import { convertRequest } from "../src/kiro/converter.js";
import {
  calculateTotalContextTokens,
  estimateTokens,
} from "../src/kiro/token.js";
import { mapModel } from "../src/kiro/utils.js";
import {
  CacheSimulator,
  InMemoryCacheStore,
  MockClock,
  computePrefixHash,
  CACHE_KEY_PREFIX,
} from "../src/kiro/cache-simulation.js";
import { calculateClaudeCost } from "../src/usage/pricing.js";
import KiroApiProviderHandler from "../src/kiro/handler.js";
import { successfulKiroStream } from "./helpers.js";

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
  const state = convertRequest(request, { isPremium: true }).conversationState;
  assert.equal(state.history?.length, 4);
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

test("model routing applies premium and experimental mappings", () => {
  assert.equal(mapModel("claude-opus-4.6", false), "claude-sonnet-4.5");
  assert.equal(mapModel("claude-opus-4.6", true), "claude-opus-4.6");
  assert.equal(
    mapModel("claude-opus-4-8-20260529", true, ["claude-opus-4.8"]),
    "claude-opus-4.8",
  );
  assert.equal(mapModel("!claude-opus-4.7", false), "!claude-opus-4.7");
  assert.equal(mapModel("claude-haiku-5.5", true), "claude-haiku-4.5");
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
