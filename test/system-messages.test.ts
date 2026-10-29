import test from "node:test";
import assert from "node:assert/strict";
import { convertRequest } from "../src/kiro/converter.ts";
import type { MessagesRequest } from "../src/kiro/types.ts";

function convert(messages: MessagesRequest["messages"]) {
  const request: MessagesRequest = { model: "claude-opus-5.5", messages };
  const original = structuredClone(request);
  const state = convertRequest(request, { isPremium: true }).conversationState;
  assert.deepEqual(request, original);
  return state;
}

test("a system entry between user messages is folded into the next one", () => {
  const state = convert([
    { role: "user", content: "Do the task." },
    { role: "system", content: [{ type: "text", text: "# Environment\ncwd: /work" }] },
    { role: "user", content: "Second message." },
  ]);
  assert.equal(
    state.currentMessage.userInputMessage.content,
    "Do the task.\n<system-reminder>\n# Environment\ncwd: /work\n</system-reminder>\nSecond message.",
  );
});

test("trailing system entries attach to the current user turn after its tool results", () => {
  const state = convert([
    { role: "user", content: "Find tools" },
    { role: "assistant", content: [{ type: "tool_use", id: "t1", name: "Lookup", input: {} }] },
    { role: "user", content: [{ type: "tool_result", tool_use_id: "t1", content: "found" }] },
    { role: "system", content: "<total_tokens>100 tokens left</total_tokens>" },
  ]);
  const current = state.currentMessage.userInputMessage;
  assert.equal(current.content, "<system-reminder>\n<total_tokens>100 tokens left</total_tokens>\n</system-reminder>");
  assert.equal(current.userInputMessageContext!.toolResults![0].toolUseId, "t1");
});

test("system entries between turns stay in history in their original position", () => {
  const state = convert([
    { role: "user", content: "One" },
    { role: "assistant", content: "Reply one" },
    { role: "system", content: [{ type: "text", text: "Deferred tools: mcp__a__b" }] },
    { role: "user", content: "Two" },
    { role: "assistant", content: "Reply two" },
    { role: "user", content: "Three" },
  ]);
  const users = state.history!.filter((m) => "userInputMessage" in m).map((m: any) => m.userInputMessage.content);
  assert.ok(users.includes("<system-reminder>\nDeferred tools: mcp__a__b\n</system-reminder>\nTwo"));
  assert.equal(state.currentMessage.userInputMessage.content, "Three");
});

test("a system entry after a user message stays in that turn, not the next one", () => {
  // Claude Code's real shape: user, system, assistant, user, system, ...
  const state = convert([
    { role: "user", content: "One" },
    { role: "system", content: "budget A" },
    { role: "assistant", content: "Reply one" },
    { role: "user", content: "Two" },
    { role: "system", content: "budget B" },
  ]);
  const users = state.history!.filter((m) => "userInputMessage" in m).map((m: any) => m.userInputMessage.content);
  assert.ok(users.includes("One\n<system-reminder>\nbudget A\n</system-reminder>"));
  assert.equal(state.currentMessage.userInputMessage.content, "Two\n<system-reminder>\nbudget B\n</system-reminder>");
});

test("a system entry after a trailing assistant prefill does not change the current turn", () => {
  const state = convert([
    { role: "user", content: "Question" },
    { role: "assistant", content: "Prefill" },
    { role: "system", content: "late context" },
  ]);
  assert.equal(state.currentMessage.userInputMessage.content, "Question\n<system-reminder>\nlate context\n</system-reminder>");
});

test("empty system entries are dropped and nothing else changes", () => {
  const state = convert([
    { role: "user", content: "Hello" },
    { role: "system", content: [] },
  ]);
  assert.equal(state.currentMessage.userInputMessage.content, "Hello");
});
