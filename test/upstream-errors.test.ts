import test from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { AppDatabase } from "../src/db.ts";
import { config } from "../src/config.ts";
import { createServerContext } from "../src/server.ts";
import { parseEventPayload } from "../src/kiro/parser.ts";
import type { MessagesRequest } from "../src/kiro/types.ts";
import { eventFrame } from "./helpers.ts";

async function listen(server: http.Server): Promise<string> {
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  return `http://127.0.0.1:${(server.address() as { port: number }).port}`;
}

async function harness(t: test.TestContext, body: Buffer | string | object, status = 200) {
  const logs: string[] = [];
  t.mock.method(console, "error", (...args: unknown[]) => { logs.push(args.join(" ")); });
  let calls = 0;
  const upstream = http.createServer((req, res) => {
    req.resume();
    req.on("end", () => {
      calls++;
      res.writeHead(status, {
        "content-type": status === 200 ? "application/vnd.amazon.eventstream" : "application/json",
        "x-amzn-requestid": "UPSTREAM_TEST_REQUEST_ID",
      });
      res.end(Buffer.isBuffer(body) || typeof body === "string" ? body : JSON.stringify(body));
    });
  });
  const previousUpstream = config.upstreamBaseUrl;
  config.upstreamBaseUrl = await listen(upstream);
  const database = new AppDatabase(":memory:");
  const context = createServerContext(database);
  const account = context.accounts.create({
    credentials: { authMethod: "api_key", accessToken: "DO_NOT_LOG_ACCESS_TOKEN" },
  });
  const app = http.createServer(context.app);
  const baseUrl = await listen(app);
  t.after(() => {
    config.upstreamBaseUrl = previousUpstream;
    for (const server of [upstream, app]) {
      server.closeAllConnections();
      server.close();
    }
    database.close();
  });
  return { logs, context, account, baseUrl, calls: () => calls };
}

function request(stream: boolean): MessagesRequest {
  return {
    model: "claude-opus-5-5",
    thinking: { type: "adaptive", budget_tokens: 1024 },
    stream,
    messages: [
      { role: "user", content: "DO_NOT_LOG_PROMPT" },
      { role: "assistant", content: [
        { type: "thinking", thinking: "", signature: "DO_NOT_LOG_SIGNATURE" },
        { type: "text", text: "DO_NOT_LOG_ASSISTANT_TEXT" },
      ] },
      { role: "user", content: "Continue" },
    ],
  };
}

async function send(baseUrl: string, stream: boolean) {
  const response = await fetch(`${baseUrl}/v1/messages`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(request(stream)),
  });
  const text = await response.text();
  if (response.headers.get("content-type")?.includes("text/event-stream")) {
    const events = text.split("\n").filter((line) => line.startsWith("data: "))
      .map((line) => JSON.parse(line.slice(6)));
    assert.ok(!events.some((event) => event.type === "message_stop"));
    return { response, body: events.find((event) => event.type === "error") };
  }
  return { response, body: JSON.parse(text) };
}

const refusal = {
  stopReason: "CONTENT_FILTERED",
  stopDetails: {
    refusal: {
      explanation: "The selected model cannot continue this conversation.",
      category: "TEST_REFUSAL_CATEGORY",
      recommendedModel: "claude-sonnet-5.5",
      additionalDetails: { reason: "TEST_UPSTREAM_REASON", path: "history[1]" },
    },
  },
};

for (const stream of [false, true]) {
  test(`original refusal metadata reaches the client and correlated logs (${stream ? "SSE" : "JSON"})`, async (t) => {
    const env = await harness(t, eventFrame(refusal, [
      { name: ":message-type", value: "event" },
      { name: ":event-type", value: "metadataEvent" },
    ]));
    const { response, body } = await send(env.baseUrl, stream);
    assert.equal(response.status, stream ? 200 : 403);
    assert.equal(body.type, "error");
    assert.equal(body.error.code, "CONTENT_FILTERED");
    assert.match(body.error.message, /The selected model cannot continue/);
    for (const detail of ["TEST_REFUSAL_CATEGORY", "TEST_UPSTREAM_REASON", "recommendedModel", "upstream_http=200", "UPSTREAM_TEST_REQUEST_ID"])
      assert.ok(body.error.message.includes(detail), detail);
    const diagnostics = body.error.upstream;
    assert.deepEqual(diagnostics.payload, refusal);
    assert.equal(diagnostics.source, "refusal");
    assert.equal(diagnostics.message_type, "event");
    assert.equal(diagnostics.event_type, "metadataEvent");
    assert.equal(diagnostics.upstream_status, 200);
    assert.equal(diagnostics.upstream_request_id, "UPSTREAM_TEST_REQUEST_ID");
    assert.equal(diagnostics.requested_model, "claude-opus-5-5");
    assert.equal(diagnostics.upstream_model, "claude-opus-5.5");
    assert.equal(diagnostics.replay.signed_thinking_blocks, 1);
    assert.equal(diagnostics.replay.replay_cache_misses, 1);
    assert.equal(diagnostics.replay.empty_native_reasoning_blocks, 1);
    assert.ok(body.error.message.includes(`diagnostic_id=${diagnostics.id}`));
    if (!stream) {
      assert.equal(response.headers.get("x-kiro-diagnostic-id"), diagnostics.id);
      assert.equal(response.headers.get("x-kiro-upstream-request-id"), "UPSTREAM_TEST_REQUEST_ID");
      assert.equal(response.headers.get("x-kiro-upstream-status"), "200");
    }
    assert.equal(env.logs.length, 1);
    assert.ok(env.logs[0].startsWith("[kiro-error] "));
    const logged = JSON.parse(env.logs[0].slice("[kiro-error] ".length));
    assert.equal(logged.id, diagnostics.id);
    assert.equal(logged.client_status, 403);
    assert.deepEqual(logged.payload, refusal);
    assert.deepEqual(logged.replay, diagnostics.replay);
    for (const secret of ["DO_NOT_LOG_ACCESS_TOKEN", "DO_NOT_LOG_PROMPT", "DO_NOT_LOG_SIGNATURE", "DO_NOT_LOG_ASSISTANT_TEXT"])
      assert.ok(!env.logs[0].includes(secret), secret);
    assert.equal(env.calls(), 1);
    assert.equal(env.context.accounts.get(env.account.id)!.autoDisabled, 0);
  });

  for (const kind of ["error", "exception"]) {
    test(`upstream ${kind} code and JSON payload survive ${stream ? "SSE" : "JSON"}`, async (t) => {
      const payload = {
        message: "The reasoning signature was invalid.",
        reason: "THINKING_SIGNATURE_INVALID",
        diagnosticPath: "conversationState.history[1].reasoningContent",
      };
      const code = kind === "error" ? "THINKING_SIGNATURE_INVALID" : "validationException";
      const env = await harness(t, eventFrame(payload, [
        { name: ":message-type", value: kind },
        { name: kind === "error" ? ":error-code" : ":exception-type", value: code },
      ]));
      const { response, body } = await send(env.baseUrl, stream);
      assert.equal(response.status, stream ? 200 : 502);
      assert.equal(body.error.code, code);
      assert.match(body.error.message, /THINKING_SIGNATURE_INVALID/);
      assert.match(body.error.message, /conversationState.history\[1\].reasoningContent/);
      assert.deepEqual(body.error.upstream.payload, payload);
      assert.equal(body.error.upstream.upstream_status, 200);
      assert.equal(body.error.upstream.source, kind);
      assert.equal(env.context.accounts.get(env.account.id)!.autoDisabled, 0);
      assert.equal(env.calls(), 1);
    });
  }

  test(`real HTTP errors retain status, request ID and original payload (stream requested: ${stream})`, async (t) => {
    const original = {
      message: "Invalid request: the signature is bound to a different conversation.",
      reason: "THINKING_SIGNATURE_INVALID",
      field: "history[1].reasoningContent",
    };
    const env = await harness(t, original, 400);
    const { response, body } = await send(env.baseUrl, stream);
    assert.equal(response.status, 400);
    assert.match(response.headers.get("content-type")!, /application\/json/);
    assert.equal(body.error.code, "THINKING_SIGNATURE_INVALID");
    assert.ok(body.error.message.startsWith(original.message));
    assert.deepEqual(body.error.upstream.payload, original);
    assert.equal(body.error.upstream.source, "http");
    assert.equal(body.error.upstream.upstream_status, 400);
    assert.equal(response.headers.get("x-kiro-diagnostic-id"), body.error.upstream.id);
    assert.equal(env.calls(), 1);
  });
}

test("plain-text HTTP errors preserve diagnostic details beyond the old 300-character cutoff", async (t) => {
  const original = "Provider error: " + "diagnostic context. ".repeat(40) + "ROOT_CAUSE_AT_END";
  const env = await harness(t, original, 400);
  const { response, body } = await send(env.baseUrl, false);
  assert.equal(response.status, 400);
  assert.ok(body.error.message.includes(original));
  assert.equal(body.error.upstream.payload, original);
  assert.ok(env.logs[0].includes("ROOT_CAUSE_AT_END"));
});

test("a CONTENT_FILTERED metadata event without a refusal object is reported instead of being lost", () => {
  const payload = { stopReason: "CONTENT_FILTERED", stopDetails: { providerReason: "TEST_REASON" } };
  const event = parseEventPayload(Buffer.from(JSON.stringify(payload)), new Map([[":event-type", "metadataEvent"]]));
  assert.equal(event?.type, "refusal");
  if (event?.type !== "refusal") throw new Error("Expected refusal");
  assert.equal(event.stopReason, "CONTENT_FILTERED");
  assert.deepEqual(event.upstream?.payload, payload);
});

test("missing upstream refusal reasons remain unknown instead of being guessed", () => {
  const payload = { stopDetails: { refusal: { explanation: "Provider declined" } } };
  const event = parseEventPayload(Buffer.from(JSON.stringify(payload)), new Map([[":event-type", "metadataEvent"]]));
  assert.equal(event?.type, "refusal");
  if (event?.type !== "refusal") throw new Error("Expected refusal");
  assert.equal(event.stopReason, "UNKNOWN_REFUSAL");
  assert.deepEqual(event.upstream?.payload, payload);
});

test("the reported REASONING_EXTRACTION refusal retains its original category in the CLI error", async (t) => {
  const original = {
    stopDetails: {
      refusal: {
        category: "REASONING_EXTRACTION",
        explanation: "The selected model cannot continue this conversation. Please select a different model, or start a new conversation, or rewind the current conversation to an earlier point and try a different approach.",
      },
    },
    stopReason: "CONTENT_FILTERED",
  };
  const env = await harness(t, eventFrame(original, [{ name: ":event-type", value: "metadataEvent" }]));
  const { body } = await send(env.baseUrl, true);
  assert.match(body.error.message, /REASONING_EXTRACTION/);
  assert.match(body.error.message, /upstream_http=200/);
  assert.deepEqual(body.error.upstream.payload, original);
  assert.doesNotMatch(body.error.message, /THINKING_SIGNATURE_INVALID/);
  assert.equal(env.calls(), 1);
});
