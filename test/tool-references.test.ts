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

function functionLines(text: string): any[] {
  return text.split("\n").filter((line) => line.startsWith("<function>"))
    .map((line) => JSON.parse(line.slice("<function>".length, -"</function>".length)));
}

test("ToolSearch results render discovered definitions in the <functions> format", () => {
  const request = discoveredToolRequest();
  const original = structuredClone(request);
  const state = convertRequest(request).conversationState;
  const context = state.currentMessage.userInputMessage.userInputMessageContext!;
  const text = context.toolResults![0].content[0].text!;
  assert.ok(typeof text === "string");
  const lines = text.split("\n");
  // Consecutive references share one <functions> block; trailing text survives.
  assert.equal(lines[0], "<functions>");
  assert.equal(lines[3], "</functions>");
  assert.equal(lines[4], "Two tools discovered.");
  const [webFetch, probe] = functionLines(text);
  assert.deepEqual(webFetch, { description: "Fetch a public URL", name: "WebFetch", parameters: request.tools![1].input_schema });
  assert.equal(probe.name, context.tools![2].toolSpecification.name);
  assert.match(probe.name, /^[A-Za-z0-9_-]{1,64}$/);
  assert.deepEqual(probe.parameters, request.tools![2].input_schema);
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
  assert.equal(functionLines(searchText)[1].name, alias);
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
  assert.equal(input.content, "Tool found: NotDeclared");
  assert.equal(input.userInputMessageContext?.tools, undefined);
  assert.ok(estimateInputTokens(undefined, request.messages, []) > 1);
  const nested = discoveredToolRequest();
  const withoutReferences = structuredClone(nested);
  (withoutReferences.messages[2].content as any)[0].content = [];
  assert.ok(estimateInputTokens(undefined, nested.messages, nested.tools)
    > estimateInputTokens(undefined, withoutReferences.messages, withoutReferences.tools));
  // Estimates count the expanded schema, not just the reference name.
  const bareTools = nested.tools!.map(({ input_schema, description, ...rest }) => rest);
  assert.ok(estimateInputTokens(undefined, nested.messages, nested.tools)
    - estimateInputTokens(undefined, withoutReferences.messages, nested.tools)
    > estimateInputTokens(undefined, nested.messages, bareTools)
    - estimateInputTokens(undefined, withoutReferences.messages, bareTools));
});
