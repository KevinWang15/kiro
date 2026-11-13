import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { AppDatabase } from "../src/db.ts";
import { convertRequest } from "../src/kiro/converter.ts";
import KiroApiProviderHandler from "../src/kiro/handler.ts";
import { SqliteReasoningReplayStore } from "../src/kiro/reasoning-replay.ts";
import type { ContentBlock, MessagesRequest } from "../src/kiro/types.ts";
import { eventFrame, meteringFrame, reasoningFrame } from "./helpers.ts";

const request = (display?: string): MessagesRequest => ({
  model: "claude-opus-5-5",
  thinking: { type: "adaptive", budget_tokens: 1024, ...(display ? { display } : {}) },
  messages: [{ role: "user", content: "Question" }],
});

async function reply(
  handler: KiroApiProviderHandler,
  req: MessagesRequest,
  frames: Buffer[],
  stream: boolean,
): Promise<ContentBlock[]> {
  const upstream = handler.transformRequestBody(req, null);
  if (!stream) {
    const result = await handler.transformResponseBody(200, Buffer.concat(frames), req, upstream);
    return (result.body as { content: ContentBlock[] }).content;
  }
  let sse = "";
  async function* chunks() {
    // Split transport frames too, independently of model text deltas.
    for (const frame of frames)
      for (let i = 0; i < frame.length; i += 7) yield frame.subarray(i, i + 7);
  }
  await handler.streamResponse(chunks(), { ...req, stream: true }, upstream, {
    onChunk: (chunk) => { sse += chunk; },
  });
  const blocks: ContentBlock[] = [];
  const toolJson = new Map<number, string>();
  for (const line of sse.split("\n").filter((line) => line.startsWith("data: "))) {
    const event = JSON.parse(line.slice(6));
    if (event.type === "content_block_start") blocks[event.index] = event.content_block;
    if (event.type === "content_block_delta") {
      const block = blocks[event.index];
      const delta = event.delta;
      if (delta.type === "thinking_delta") block.thinking += delta.thinking;
      if (delta.type === "signature_delta") block.signature += delta.signature;
      if (delta.type === "text_delta") block.text += delta.text;
      if (delta.type === "input_json_delta")
        toolJson.set(event.index, (toolJson.get(event.index) ?? "") + delta.partial_json);
    }
    if (event.type === "content_block_stop" && blocks[event.index].type === "tool_use")
      blocks[event.index].input = JSON.parse(toolJson.get(event.index) || "{}");
  }
  return blocks;
}

function replay(handler: KiroApiProviderHandler, req: MessagesRequest, content: ContentBlock[]) {
  const followup: MessagesRequest = {
    ...req,
    messages: [
      ...req.messages,
      { role: "assistant", content },
      { role: "user", content: "Continue" },
    ],
  };
  const original = structuredClone(followup);
  const state = handler.transformRequestBody(followup, null).conversationState;
  assert.deepEqual(followup, original);
  return state.history!.flatMap((message) =>
    "assistantResponseMessage" in message ? [message.assistantResponseMessage] : [],
  );
}

for (const stream of [false, true]) {
  for (const display of [undefined, "omitted", "summarized"]) {
    test(`signed reasoning survives response/replay (${stream ? "SSE" : "JSON"}, ${display ?? "default"})`, async () => {
      const handler = new KiroApiProviderHandler();
      const req = request(display);
      const raw = "First step.\n  第二步 🐈";
      const content = await reply(handler, req, [
        reasoningFrame({ text: "First step.\n" }),
        reasoningFrame({ text: "  第二步 🐈", signature: "EXACT_SIGNATURE" }),
        eventFrame({ content: "Answer" }), meteringFrame(),
      ], stream);
      assert.deepEqual(content, [
        { type: "thinking", thinking: display === "summarized" ? raw : "", signature: "EXACT_SIGNATURE" },
        { type: "text", text: "Answer" },
      ]);
      assert.deepEqual(replay(handler, req, content), [{
        content: "Answer",
        reasoningContent: { reasoningText: { text: raw, signature: "EXACT_SIGNATURE" } },
      }]);
    });
  }

  test(`reasoning/text/tool boundaries and signatures survive ${stream ? "SSE" : "JSON"} and replay`, async () => {
    const handler = new KiroApiProviderHandler();
    const req = request("summarized");
    const content = await reply(handler, req, [
      eventFrame({ content: "Before." }),
      reasoningFrame({ text: "Reason one" }), reasoningFrame({ signature: "SIG1" }),
      eventFrame({ content: "Middle." }),
      eventFrame({ name: "Lookup", toolUseId: "lookup1", input: '{"query":', stop: false }),
      eventFrame({ name: "Lookup", toolUseId: "lookup1", input: '"x"}', stop: true }),
      reasoningFrame({ text: "Reason two" }), reasoningFrame({ signature: "SIG2" }),
      eventFrame({ content: "After." }), meteringFrame(),
    ], stream);
    assert.deepEqual(content, [
      { type: "text", text: "Before." },
      { type: "thinking", thinking: "Reason one", signature: "SIG1" },
      { type: "text", text: "Middle." },
      { type: "tool_use", id: "lookup1", name: "Lookup", input: { query: "x" } },
      { type: "thinking", thinking: "Reason two", signature: "SIG2" },
      { type: "text", text: "After." },
    ]);
    const followup: MessagesRequest = {
      ...req,
      messages: [...req.messages, { role: "assistant", content }, {
        role: "user", content: [{ type: "tool_result", tool_use_id: "lookup1", content: "result" }],
      }],
    };
    const state = handler.transformRequestBody(followup, null).conversationState;
    assert.deepEqual(state.history!.slice(1), [
      { assistantResponseMessage: { content: "Before." } },
      { assistantResponseMessage: {
        content: "Middle.",
        reasoningContent: { reasoningText: { text: "Reason one", signature: "SIG1" } },
        toolUses: [{ toolUseId: "lookup1", name: "Lookup", input: { query: "x" } }],
      } },
      { assistantResponseMessage: {
        content: "After.",
        reasoningContent: { reasoningText: { text: "Reason two", signature: "SIG2" } },
      } },
    ]);
  });

  test(`redacted reasoning round-trips through ${stream ? "SSE" : "JSON"} as opaque native data`, async () => {
    const handler = new KiroApiProviderHandler();
    const req = request();
    const content = await reply(handler, req, [
      reasoningFrame({ text: "Signed", signature: "S" }),
      reasoningFrame({ redactedContent: "AAECA/8=" }),
      eventFrame({ content: "Answer" }), meteringFrame(),
    ], stream);
    assert.deepEqual(content, [
      { type: "thinking", thinking: "", signature: "S" },
      { type: "redacted_thinking", data: "AAECA/8=" },
      { type: "text", text: "Answer" },
    ]);
    assert.deepEqual(replay(handler, req, content), [
      { content: "", reasoningContent: { reasoningText: { text: "Signed", signature: "S" } } },
      { content: "Answer", reasoningContent: { redactedContent: "AAECA/8=" } },
    ]);
  });
}

test("omitted reasoning survives a database close/reopen and a new handler", async () => {
  const directory = mkdtempSync(join(tmpdir(), "kiro-reasoning-"));
  let database: AppDatabase | undefined;
  try {
    const filename = join(directory, "kiro.db");
    database = new AppDatabase(filename);
    const first = new KiroApiProviderHandler(undefined, new SqliteReasoningReplayStore(database));
    const req = request();
    const content = await reply(first, req, [
      reasoningFrame({ text: "Keep exactly this\n", signature: "PERSISTENT_SIG" }),
      eventFrame({ content: "Answer" }), meteringFrame(),
    ], true);
    database.close();
    database = new AppDatabase(filename);
    const resumed = new KiroApiProviderHandler(undefined, new SqliteReasoningReplayStore(database));
    // A later signature-only response must not overwrite the saved full text.
    await reply(resumed, req, [reasoningFrame({ signature: "PERSISTENT_SIG" }), meteringFrame()], false);
    assert.deepEqual(replay(resumed, req, content), [{
      content: "Answer",
      reasoningContent: { reasoningText: { text: "Keep exactly this\n", signature: "PERSISTENT_SIG" } },
    }]);
  } finally {
    database?.close();
    rmSync(directory, { recursive: true, force: true });
  }
});

test("omitted reasoning is saved before its signature is sent to the client", async () => {
  const handler = new KiroApiProviderHandler();
  const req = request();
  let checked = false;
  async function* chunks() {
    yield reasoningFrame({ text: "Ready for replay", signature: "EARLY_SIG" });
    yield eventFrame({ content: "Answer" });
    yield meteringFrame();
  }
  await handler.streamResponse(chunks(), req, handler.transformRequestBody(req, null), {
    onChunk: (chunk) => {
      if (!chunk.includes('"type":"signature_delta"')) return;
      checked = true;
      assert.deepEqual(replay(handler, req, [
        { type: "thinking", thinking: "", signature: "EARLY_SIG" },
      ]), [{
        content: "",
        reasoningContent: { reasoningText: { text: "Ready for replay", signature: "EARLY_SIG" } },
      }]);
    },
  });
  assert.ok(checked);
});

test("signature-only blocks from older sessions are preserved even without saved text", () => {
  assert.deepEqual(replay(new KiroApiProviderHandler(), request(), [
    { type: "thinking", thinking: "", signature: "OLD_SIGNATURE" },
    { type: "text", text: "Answer" },
  ]), [{ content: "Answer", reasoningContent: { reasoningText: { text: "", signature: "OLD_SIGNATURE" } } }]);
});

test("unsigned thinking keeps its position relative to text and tool calls", () => {
  const req: MessagesRequest = {
    model: "claude-sonnet-4-5",
    messages: [
      { role: "user", content: "Question" },
      { role: "assistant", content: [
        { type: "text", text: "Before." },
        { type: "thinking", thinking: "Reason one" },
        { type: "text", text: "Middle." },
        { type: "tool_use", id: "t", name: "Lookup", input: {} },
        { type: "thinking", thinking: "Reason two" },
        { type: "text", text: "After." },
      ] },
      { role: "user", content: [{ type: "tool_result", tool_use_id: "t", content: "result" }] },
    ],
  };
  assert.deepEqual(convertRequest(req).conversationState.history!.slice(1), [
    { assistantResponseMessage: {
      content: "Before.<thinking>Reason one</thinking>\n\nMiddle.",
      toolUses: [{ toolUseId: "t", name: "Lookup", input: {} }],
    } },
    { assistantResponseMessage: { content: "<thinking>Reason two</thinking>\n\nAfter." } },
  ]);
});

test("trailing assistant text and reasoning are retained for continuation without mutating the request", () => {
  const req: MessagesRequest = {
    ...request(), system: "Instructions",
    messages: [
      { role: "user", content: "Question" },
      { role: "assistant", content: [
        { type: "thinking", thinking: "Signed reasoning", signature: "SIG" },
        { type: "text", text: "Partial answer" },
      ] },
      { role: "assistant", content: [{ type: "thinking", thinking: "Unfinished reasoning" }] },
    ],
  };
  const original = structuredClone(req);
  const state = convertRequest(req).conversationState;
  assert.deepEqual(req, original);
  assert.equal(state.currentMessage.userInputMessage.content, "");
  assert.match((state.history![0] as { userInputMessage: { content: string } }).userInputMessage.content, /Instructions\n\nQuestion$/);
  assert.deepEqual(state.history!.slice(1), [{ assistantResponseMessage: {
    content: "Partial answer\n\n<thinking>Unfinished reasoning</thinking>",
    reasoningContent: { reasoningText: { text: "Signed reasoning", signature: "SIG" } },
  } }]);
});
