import test from "node:test";
import assert from "node:assert/strict";
import { convertRequest } from "../src/kiro/converter.ts";
import { estimateInputTokens } from "../src/kiro/token.ts";
import type { MessagesRequest } from "../src/kiro/types.ts";

const longName = "mcp__compat__read_only_probe_with_a_name_that_exceeds_sixty_four_characters";
function discoveredToolRequest(): MessagesRequest {
  return {
    model: "claude-opus-5.5",
    tools: [
      { name: "ToolSearch", description: "Find tools", input_schema: { type: "object" } },
      { name: "WebFetch", description: "Fetch a public URL", input_schema: { type: "object", properties: { url: { type: "string" } } }, defer_loading: true },
      { name: longName, description: "A discovered read-only tool", input_schema: { type: "object", properties: { marker: { type: "string" } } }, defer_loading: true },
    ],
    messages: [
      { role: "user", content: "Find read-only tools" },
      { role: "assistant", content: [{ type: "tool_use", id: "search-one", name: "ToolSearch", input: { query: "read" } }] },
      { role: "user", content: [{ type: "tool_result", tool_use_id: "search-one", content: [
        { type: "tool_reference", tool_name: "WebFetch" },
        { type: "tool_reference", tool_name: longName },
        { type: "text", text: "Two tools discovered." },
      ] }] },
    ],
  };
}

test("ToolSearch results preserve references and use the same wire names as discovered definitions", () => {
  const request = discoveredToolRequest();
  const original = structuredClone(request);
  const state = convertRequest(request, { isPremium: true }).conversationState;
  const context = state.currentMessage.userInputMessage.userInputMessageContext!;
  const text = context.toolResults![0].content[0].text!;
  assert.ok(typeof text === "string");
  const lines = text.split("\n");
  assert.deepEqual(JSON.parse(lines[0]), { type: "tool_reference", tool_name: "WebFetch" });
  assert.deepEqual(JSON.parse(lines[1]), { type: "tool_reference", tool_name: context.tools![2].toolSpecification.name });
  assert.match(JSON.parse(lines[1]).tool_name, /^[A-Za-z0-9_-]{1,64}$/);
  assert.equal(lines[2], "Two tools discovered.");
  assert.deepEqual(context.tools![2].toolSpecification.inputSchema.json, request.tools![2].input_schema);
  assert.deepEqual(request, original);
});

test("discovery references remain in resumed history through the subsequent tool-result round", () => {
  const request = discoveredToolRequest();
  request.messages.push(
    { role: "assistant", content: [{ type: "tool_use", id: "probe-one", name: longName, input: { marker: "ping" } }] },
    { role: "user", content: [{ type: "tool_result", tool_use_id: "probe-one", content: "pong" }] },
  );
  const state = convertRequest(request).conversationState;
  const searchResult = state.history!.flatMap((message) => "userInputMessage" in message
    ? message.userInputMessage.userInputMessageContext?.toolResults || [] : [])
    .find((result) => result.toolUseId === "search-one")!;
  const alias = state.currentMessage.userInputMessage.userInputMessageContext!.tools![2].toolSpecification.name;
  const searchText = searchResult.content[0].text;
  assert.ok(typeof searchText === "string");
  assert.ok(searchText.includes(JSON.stringify({ type: "tool_reference", tool_name: alias })));
  const calls = state.history!.flatMap((message) => "assistantResponseMessage" in message
    ? message.assistantResponseMessage.toolUses || [] : []);
  assert.equal(calls.find((call) => call.toolUseId === "probe-one")!.name, alias);
  assert.equal(state.currentMessage.userInputMessage.userInputMessageContext!.toolResults![0].toolUseId, "probe-one");
});

test("unresolved and standalone references stay visible without inventing tool definitions", () => {
  const request: MessagesRequest = { model: "claude-opus-5.5", messages: [
    { role: "user", content: [{ type: "tool_reference", tool_name: "NotDeclared" }] },
  ] };
  const input = convertRequest(request).conversationState.currentMessage.userInputMessage;
  assert.deepEqual(JSON.parse(input.content), { type: "tool_reference", tool_name: "NotDeclared" });
  assert.equal(input.userInputMessageContext?.tools, undefined);
  assert.ok(estimateInputTokens(undefined, request.messages, []) > 1);
  const nested = discoveredToolRequest();
  const withoutReferences = structuredClone(nested);
  (withoutReferences.messages[2].content as any)[0].content = [];
  assert.ok(estimateInputTokens(undefined, nested.messages, nested.tools)
    > estimateInputTokens(undefined, withoutReferences.messages, withoutReferences.tools));
});
