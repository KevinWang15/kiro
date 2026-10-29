import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { convertRequest } from "../src/kiro/converter.ts";
import KiroApiProviderHandler from "../src/kiro/handler.ts";
import type { MessagesRequest } from "../src/kiro/types.ts";
import { eventFrame } from "./helpers.ts";

const longName = "mcp__plugin_cloudflare_cloudflare-docs__search_cloudflare_documentation";
function requestFor(name: string): MessagesRequest {
  return {
    model: "claude-opus-5.5",
    messages: [{ role: "user", content: "Use the test tool." }],
    tools: [{ name, input_schema: { type: "object", properties: {} } }],
  };
}
function wireName(request: MessagesRequest): string {
  return convertRequest(request, { isPremium: true }).conversationState
    .currentMessage.userInputMessage.userInputMessageContext!.tools![0]
    .toolSpecification.name;
}
function toolStream(name: string): Buffer {
  return Buffer.concat([
    eventFrame({ name, toolUseId: "call-one", input: '{"q":', stop: false }),
    eventFrame({ name, toolUseId: "call-one", input: '"test"}', stop: true }),
    eventFrame({ contextUsagePercentage: 1 }),
  ]);
}

test("tool names preserve short names and safely distinguish long MCP names", () => {
  assert.equal(wireName(requestFor("Bash")), "Bash");
  assert.equal(wireName(requestFor("T".repeat(64))), "T".repeat(64));
  const request = requestFor(longName);
  const original = structuredClone(request);
  const converted = convertRequest(request, { isPremium: true });
  const spec = converted.conversationState.currentMessage.userInputMessage
    .userInputMessageContext!.tools![0].toolSpecification;
  assert.match(spec.name, /^[A-Za-z0-9_-]{1,64}$/);
  // Readable: the alias keeps the original prefix plus a short hash.
  assert.equal(spec.name.length, 64);
  assert.ok(spec.name.startsWith(longName.slice(0, 55)));
  assert.match(spec.name, /_[0-9a-f]{8}$/);
  assert.notEqual(spec.name, wireName(requestFor(`${longName}_other`)));
  assert.equal(spec.name, wireName(request));
  assert.ok(spec.description.trim());
  assert.ok(spec.description.startsWith(`Client tool name: ${longName}\n`));
  assert.deepEqual(request, original);
});

test("only names Kiro rejects are aliased", () => {
  // Kiro accepts [A-Za-z0-9_-]{1,64}; hyphenated MCP names pass through.
  for (const name of ["mcp__chrome-devtools__take_screenshot", "-ab", "1ab", "x", "a".repeat(64)])
    assert.equal(wireName(requestFor(name)), name);
  assert.notEqual(wireName(requestFor("a".repeat(65))), "a".repeat(65));
  for (const name of ["a:b", "a/b", "a b"]) {
    const alias = wireName(requestFor(name));
    assert.notEqual(alias, name);
    assert.match(alias, /^[A-Za-z0-9_-]{1,64}$/);
  }
});

test("aliases cannot collide with a valid tool name declared by the client", () => {
  const hash = createHash("sha256").update(longName).digest("hex").slice(0, 8);
  const alias = `${longName.slice(0, 55)}_${hash}`;
  const request = requestFor(longName);
  request.tools!.push({ name: alias, description: "An independent tool" });
  const tools = convertRequest(request).conversationState.currentMessage
    .userInputMessage.userInputMessageContext!.tools!;
  assert.notEqual(tools[0].toolSpecification.name, alias);
  assert.equal(tools[1].toolSpecification.name, alias);
});

test("resumed history and current definitions use the same alias without changing tool IDs", () => {
  const request = requestFor(longName);
  request.messages.push(
    { role: "assistant", content: [{ type: "tool_use", name: longName, id: "original-id", input: { q: "test" } }] },
    { role: "user", content: [{ type: "tool_result", tool_use_id: "original-id", content: "result" }] },
  );
  const state = convertRequest(request).conversationState;
  const assistant = state.history!.find((m) => "assistantResponseMessage" in m)! as any;
  assert.equal(assistant.assistantResponseMessage.toolUses[0].name, wireName(request));
  assert.equal(assistant.assistantResponseMessage.toolUses[0].toolUseId, "original-id");
  assert.equal(state.currentMessage.userInputMessage.userInputMessageContext!.toolResults![0].toolUseId, "original-id");

  // A tool no longer declared by the client still needs an aliased placeholder.
  request.tools = [];
  const resumed = convertRequest(request).conversationState;
  const history = resumed.history!.find((m) => "assistantResponseMessage" in m)! as any;
  assert.equal(history.assistantResponseMessage.toolUses[0].name,
    resumed.currentMessage.userInputMessage.userInputMessageContext!.tools![0].toolSpecification.name);
  assert.ok(resumed.currentMessage.userInputMessage.userInputMessageContext!.tools![0]
    .toolSpecification.description.includes(longName));
});

test("same-description aliased tools retain their distinct client names within description limits", () => {
  const request = requestFor(`${longName}_alpha`);
  request.tools![0].description = "Identical description";
  request.tools!.push({ name: `${longName}_beta`, description: "Identical description" });
  const tools = convertRequest(request).conversationState.currentMessage
    .userInputMessage.userInputMessageContext!.tools!;
  assert.ok(tools[0].toolSpecification.description.includes(`${longName}_alpha`));
  assert.ok(tools[1].toolSpecification.description.includes(`${longName}_beta`));
  request.tools![0].description = "😀".repeat(6000);
  const spec = convertRequest(request).conversationState.currentMessage
    .userInputMessage.userInputMessageContext!.tools![0].toolSpecification;
  assert.ok(spec.description.length <= 10000);
  assert.ok(spec.description.includes(`${longName}_alpha`));
  assert.ok(!/[\uD800-\uDBFF]$/.test(spec.description));
});

for (const mode of ["json", "buffered SSE", "live SSE"] as const) {
  test(`tool names and JSON arguments round-trip through ${mode}`, async () => {
    const request = requestFor(longName);
    request.stream = mode !== "json";
    const modified = convertRequest(request, { isPremium: true });
    const bytes = toolStream(wireName(request));
    const handler = new KiroApiProviderHandler();
    if (mode === "json") {
      const result = await handler.transformResponseBody(200, bytes, request, modified);
      const body = result.body as any;
      const tool = body.content.find((b: any) => b.type === "tool_use");
      assert.equal(tool.name, longName);
      assert.equal(tool.id, "call-one");
      assert.deepEqual(tool.input, { q: "test" });
      assert.equal(body.stop_reason, "tool_use");
    } else {
      let text = "";
      if (mode === "buffered SSE") {
        text = (await handler.transformResponseBody(200, bytes, request, modified)).body as string;
      } else {
        async function* chunks() {
          for (let i = 0; i < bytes.length; i += 7) yield bytes.subarray(i, i + 7);
        }
        await handler.streamResponse(chunks(), request, modified, { onChunk: (chunk) => { text += chunk; } });
      }
      const events = text.split("\n").filter((line) => line.startsWith("data: ")).map((line) => JSON.parse(line.slice(6)));
      const tool = events.find((event) => event.content_block?.type === "tool_use").content_block;
      assert.equal(tool.name, longName);
      assert.equal(tool.id, "call-one");
      const input = events.filter((event) => event.delta?.type === "input_json_delta").map((event) => event.delta.partial_json).join("");
      assert.deepEqual(JSON.parse(input), { q: "test" });
      assert.ok(events.some((event) => event.delta?.stop_reason === "tool_use"));
    }
  });
}
