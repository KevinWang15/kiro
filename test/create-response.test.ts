import test from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { type AddressInfo } from "node:net";
import { AppDatabase } from "../src/db.ts";
import { createServerContext } from "../src/server.ts";
import { config } from "../src/config.ts";
import {
  CREATE_RESPONSE_FEATURE_KEY,
  CreateResponseDecoder,
  featureConfigKey,
  FEATURE_CONFIG_RETRY_MS,
  FEATURE_CONFIG_TTL_MS,
  modelApiFromFeatureConfig,
  ModelApiSelector,
  toCreateResponseRequest,
} from "../src/kiro/create-response.ts";
import type { KiroEvent, KiroRequest } from "../src/kiro/types.ts";
import { kiroModelList, successfulKiroStream } from "./helpers.ts";

const sse = (...events: unknown[]) =>
  events.map((event) => `event: x\ndata: ${JSON.stringify(event)}\n\n`).join("") + "data: [DONE]\n\n";

const completed = (credits = 0.0125, percentage = 2.5) => ({
  type: "response.completed",
  response: {
    status: "completed",
    usage: {
      "kiro:credits": { value: credits, unit: "credit", unit_plural: "credits" },
      "kiro:context_usage_percentage": percentage,
    },
  },
});

function decode(text: string, chunkSize = text.length): KiroEvent[] {
  const decoder = new CreateResponseDecoder();
  const bytes = Buffer.from(text);
  const events: KiroEvent[] = [];
  for (let offset = 0; offset < bytes.length; offset += chunkSize)
    events.push(...decoder.feed(bytes.subarray(offset, offset + chunkSize)));
  events.push(...decoder.finish());
  return events;
}

test("the create_response_api arm selects CreateResponse", () => {
  // The IDE's key: sha256 of its salt and the feature name.
  assert.equal(
    CREATE_RESPONSE_FEATURE_KEY,
    "8242f5d7e306898aef7ec21ccbe97fd8e9150efbe8f093b12c8dc8b7d46fb604",
  );
  assert.equal(modelApiFromFeatureConfig({ [CREATE_RESPONSE_FEATURE_KEY]: "create_response" }), "createResponse");
  assert.equal(modelApiFromFeatureConfig({ [CREATE_RESPONSE_FEATURE_KEY]: "control" }), "generateAssistantResponse");
  assert.equal(modelApiFromFeatureConfig({ [featureConfigKey("other")]: "create_response" }), "generateAssistantResponse");
  assert.equal(modelApiFromFeatureConfig({}), "generateAssistantResponse");
});

test("feature configuration is cached per sign-in and retried after a failure", async () => {
  let now = 1_000;
  const selector = new ModelApiSelector(() => now);
  const arm = { [CREATE_RESPONSE_FEATURE_KEY]: "create_response" };
  let loads = 0;
  const load = (result: Record<string, unknown> | Error) => async () => {
    loads++;
    if (result instanceof Error) throw result;
    return result;
  };

  assert.equal(await selector.select(1, "token-a", load(arm)), "createResponse");
  assert.equal(await selector.select(1, "token-a", load({})), "createResponse");
  assert.equal(loads, 1);

  // A failed refresh keeps the last configuration and retries a minute later.
  now += FEATURE_CONFIG_TTL_MS;
  const warn = console.warn;
  console.warn = () => {};
  try {
    assert.equal(await selector.select(1, "token-a", load(new Error("HTTP 500"))), "createResponse");
  } finally {
    console.warn = warn;
  }
  assert.equal(loads, 2);
  assert.equal(await selector.select(1, "token-a", load({})), "createResponse");
  assert.equal(loads, 2);
  now += FEATURE_CONFIG_RETRY_MS;
  assert.equal(await selector.select(1, "token-a", load({})), "generateAssistantResponse");
  assert.equal(loads, 3);

  // A new token is a new sign-in; an unreadable first read stays on the default.
  console.warn = () => {};
  try {
    assert.equal(await selector.select(1, "token-b", load(new Error("timeout"))), "generateAssistantResponse");
  } finally {
    console.warn = warn;
  }
  assert.equal(await selector.select(2, "token-c", load(arm)), "createResponse");
});

test("concurrent requests share one feature configuration read", async () => {
  const selector = new ModelApiSelector();
  let loads = 0;
  let release!: () => void;
  const gate = new Promise<void>((resolve) => (release = resolve));
  const load = async () => {
    loads++;
    await gate;
    return { [CREATE_RESPONSE_FEATURE_KEY]: "create_response" };
  };
  const pending = [selector.select(1, "t", load), selector.select(1, "t", load)];
  release();
  assert.deepEqual(await Promise.all(pending), ["createResponse", "createResponse"]);
  assert.equal(loads, 1);
});

test("a generateAssistantResponse request becomes the IDE's CreateResponse body", () => {
  const reasoningContent = { reasoningText: { text: "thought", signature: "SIG" } };
  const request: KiroRequest = {
    profileArn: "arn:aws:codewhisperer:us-east-1:1:profile/P",
    conversationState: {
      conversationId: "conv-1",
      agentTaskType: "vibe",
      chatTriggerType: "MANUAL",
      history: [
        { userInputMessage: { content: "system\n\nWeather?", modelId: "claude-opus-5.5", origin: "AI_EDITOR" } },
        {
          assistantResponseMessage: {
            content: "Checking.",
            reasoningContent,
            toolUses: [{ toolUseId: "tool-1", name: "get_weather", input: { city: "Paris" } }],
          },
        },
      ],
      currentMessage: {
        userInputMessage: {
          content: "Also this file",
          modelId: "claude-opus-5.5",
          origin: "AI_EDITOR",
          images: [{ format: "png", source: { bytes: "UE5H" } }],
          documents: [{ format: "pdf", name: "report", source: { bytes: "JVBE" } }],
          userInputMessageContext: {
            toolResults: [{ toolUseId: "tool-1", content: [{ text: "Sunny" }, { text: "31C" }], status: "success" }],
            tools: [{
              toolSpecification: {
                name: "get_weather",
                description: "Weather",
                inputSchema: { json: { type: "object" } },
              },
            }],
          },
        },
      },
    },
  };

  assert.deepEqual(toCreateResponseRequest(request), {
    model: "claude-opus-5.5",
    input: [
      { role: "user", content: "system\n\nWeather?" },
      { type: "reasoning", encrypted_content: JSON.stringify(reasoningContent) },
      { role: "assistant", content: "Checking." },
      { type: "function_call", call_id: "tool-1", name: "get_weather", arguments: '{"city":"Paris"}' },
      { type: "function_call_output", call_id: "tool-1", output: "Sunny\n31C" },
      {
        role: "user",
        content: [
          { type: "input_text", text: "Also this file" },
          { type: "input_image", image_url: "data:image/png;base64,UE5H" },
          { type: "input_file", filename: "report.pdf", file_data: "data:application/pdf;base64,JVBE" },
        ],
      },
    ],
    tools: [{ type: "function", name: "get_weather", description: "Weather", parameters: { type: "object" } }],
    stream: true,
    origin: "AI_EDITOR",
    profileArn: "arn:aws:codewhisperer:us-east-1:1:profile/P",
    metadata: { "kiro:agent_mode": "vibe", "kiro:conversation_id": "conv-1" },
  });
});

test("CreateResponse events decode into Kiro events across chunk boundaries", () => {
  const encrypted = JSON.stringify({ reasoningText: { text: "Let me think.", signature: "SIG-1" } });
  const stream = sse(
    { type: "response.created", response: { status: "in_progress" } },
    { type: "response.output_item.added", item: { type: "reasoning", id: "rs_1", encrypted_content: null } },
    { type: "response.reasoning_text.delta", item_id: "rs_1", delta: "Let me " },
    { type: "response.reasoning_text.delta", item_id: "rs_1", delta: "think." },
    { type: "response.output_item.done", item: { type: "reasoning", id: "rs_1", encrypted_content: encrypted } },
    { type: "response.output_text.delta", item_id: "msg_1", delta: "Héllo " },
    { type: "response.output_text.delta", item_id: "msg_1", delta: "there" },
    { type: "response.output_item.added", item: { type: "function_call", id: "fc_1", call_id: "tooluse_1", name: "get_weather" } },
    { type: "response.function_call_arguments.delta", item_id: "fc_1", delta: "" },
    { type: "response.function_call_arguments.delta", item_id: "fc_1", delta: '{"city"' },
    { type: "response.function_call_arguments.delta", item_id: "fc_1", delta: ': "Paris"}' },
    { type: "response.function_call_arguments.done", item_id: "fc_1", arguments: '{"city": "Paris"}' },
    { type: "response.output_item.done", item: { type: "function_call", id: "fc_1", call_id: "tooluse_1", name: "get_weather", arguments: '{"city": "Paris"}' } },
    completed(),
  );
  const expected: KiroEvent[] = [
    { type: "reasoning", text: "Let me " },
    { type: "reasoning", text: "think." },
    { type: "reasoning", text: "", signature: "SIG-1" },
    { type: "assistantResponse", content: "Héllo " },
    { type: "assistantResponse", content: "there" },
    { type: "toolUse", data: { toolUseId: "tooluse_1", name: "get_weather", input: "", stop: false } },
    { type: "toolUse", data: { toolUseId: "tooluse_1", name: "get_weather", input: '{"city"', stop: false } },
    { type: "toolUse", data: { toolUseId: "tooluse_1", name: "get_weather", input: ': "Paris"}', stop: false } },
    { type: "toolUse", data: { toolUseId: "tooluse_1", name: "get_weather", input: "", stop: true } },
    { type: "contextUsage", data: { percentage: 2.5 } },
    { type: "creditConsumption", data: { amount: 0.0125 } },
    { type: "responseEnd" },
  ];
  assert.deepEqual(decode(stream), expected);
  assert.deepEqual(decode(stream, 7), expected);
  assert.deepEqual(decode(stream.replace(/\n/g, "\r\n"), 3), expected);
});

test("CreateResponse reasoning sent only in the finished item and redacted reasoning are kept", () => {
  const events = decode(sse(
    { type: "response.output_item.done", item: { type: "reasoning", encrypted_content: JSON.stringify({ reasoningText: { text: "Unstreamed", signature: "S" } }) } },
    { type: "response.output_item.done", item: { type: "reasoning", encrypted_content: JSON.stringify({ redactedContent: "REDACTED" }) } },
    { type: "response.output_item.added", item: { type: "function_call", id: "fc_2", call_id: "call_2", name: "noop" } },
    { type: "response.output_item.done", item: { type: "function_call", id: "fc_2", call_id: "call_2", name: "noop", arguments: "{}" } },
    completed(),
  ));
  assert.deepEqual(events.slice(0, 4), [
    { type: "reasoning", text: "Unstreamed", signature: "S" },
    { type: "reasoning", text: "", redactedContent: "REDACTED" },
    { type: "toolUse", data: { toolUseId: "call_2", name: "noop", input: "", stop: false } },
    { type: "toolUse", data: { toolUseId: "call_2", name: "noop", input: "{}", stop: true } },
  ]);
});

test("CreateResponse failures and incomplete replies keep Kiro's details", () => {
  const failure = { type: "error", error: { type: "too_many_requests", code: "rate_limit_exceeded", message: "Too many requests" } };
  assert.deepEqual(decode(sse(failure)), [{
    type: "error",
    errorCode: "rate_limit_exceeded",
    errorMessage: "Too many requests",
    upstream: { eventType: "error", payload: failure },
  }]);

  const failed = { type: "response.failed", response: { error: { code: "server_error", message: "boom" } } };
  assert.deepEqual(decode(sse(failed)), [{
    type: "error", errorCode: "server_error", errorMessage: "boom", upstream: { eventType: "response.failed", payload: failed },
  }]);

  const filtered = decode(sse({ type: "response.incomplete", response: { status: "incomplete", incomplete_details: { reason: "content_filter" } } }));
  assert.equal(filtered.at(-1)?.type, "refusal");
  assert.equal((filtered.at(-1) as { stopReason: string }).stopReason, "CONTENT_FILTERED");

  const maxTokens = decode(sse({ type: "response.incomplete", response: { status: "incomplete", incomplete_details: { reason: "max_output_tokens" } } }));
  assert.deepEqual(maxTokens, [{ type: "responseEnd", stopReason: "max_tokens" }]);

  const unknown = decode(sse({ type: "response.incomplete", response: { status: "incomplete", incomplete_details: { reason: "compaction_required_for_model_handoff" } } }));
  assert.equal(unknown[0].type, "error");
  assert.equal((unknown[0] as { errorCode: string }).errorCode, "compaction_required_for_model_handoff");

  assert.throws(() => decode("data: {not json}\n\n"), /invalid JSON/);
});

async function listen(server: http.Server): Promise<string> {
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  return `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
}

async function harness(
  t: test.TestContext,
  arm: string | undefined,
  responses: string,
  // What ListAvailableModels answers; null for an HTTP 500.
  models: unknown = { models: [] },
) {
  const requests: Array<{ method: string; url: string; headers: http.IncomingHttpHeaders; body: any }> = [];
  const upstream = http.createServer((req, res) => {
    let body = "";
    req.on("data", (chunk) => (body += chunk));
    req.on("end", () => {
      requests.push({ method: req.method!, url: req.url!, headers: req.headers, body: body ? JSON.parse(body) : undefined });
      if (req.method === "GET" && req.url?.startsWith("/featureConfiguration")) {
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify({ configuration: arm ? { [CREATE_RESPONSE_FEATURE_KEY]: arm } : {} }));
      } else if (req.method === "GET" && req.url?.startsWith("/ListAvailableModels")) {
        res.writeHead(models === null ? 500 : 200, { "content-type": "application/json" });
        res.end(JSON.stringify(models ?? { message: "unavailable" }));
      } else if (req.method === "POST" && req.url === "/v1/responses") {
        res.writeHead(200, { "content-type": "text/event-stream", "x-amzn-requestid": "CR-REQUEST" });
        res.end(responses);
      } else if (req.method === "POST" && req.url === "/generateAssistantResponse") {
        res.writeHead(200, { "content-type": "application/vnd.amazon.eventstream" });
        res.end(successfulKiroStream("from generateAssistantResponse", 0.25));
      } else {
        res.writeHead(404).end();
      }
    });
  });
  const previous = config.upstreamBaseUrl;
  config.upstreamBaseUrl = await listen(upstream);
  const database = new AppDatabase(":memory:");
  const context = createServerContext(database);
  context.accounts.create({ credentials: { provider: "BuilderId", accessToken: "access-1", refreshToken: "refresh-1", expiresAt: new Date(Date.now() + 3_600_000).toISOString() } });
  const app = http.createServer(context.app);
  const baseUrl = await listen(app);
  t.after(() => {
    config.upstreamBaseUrl = previous;
    for (const server of [upstream, app]) {
      server.closeAllConnections();
      server.close();
    }
    database.close();
  });
  return { requests, baseUrl, database };
}

const message = (stream: boolean) => ({
  model: "claude-opus-5-5",
  stream,
  tools: [{ name: "get_weather", description: "Weather", input_schema: { type: "object" } }],
  messages: [{ role: "user", content: "Weather in Paris?" }],
});

test("an account in the CreateResponse arm is served through /v1/responses", async (t) => {
  const stream = sse(
    { type: "response.output_text.delta", delta: "Checking." },
    { type: "response.output_item.added", item: { type: "function_call", id: "fc_1", call_id: "tooluse_1", name: "get_weather" } },
    { type: "response.function_call_arguments.delta", item_id: "fc_1", delta: '{"city":"Paris"}' },
    { type: "response.function_call_arguments.done", item_id: "fc_1", arguments: '{"city":"Paris"}' },
    completed(0.5, 1),
  );
  const env = await harness(t, "create_response", stream);

  const sent = await fetch(`${env.baseUrl}/v1/messages`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(message(true)),
  });
  assert.equal(sent.status, 200);
  const events = (await sent.text()).split("\n").filter((line) => line.startsWith("data: ")).map((line) => JSON.parse(line.slice(6)));
  assert.ok(events.some((e) => e.type === "content_block_delta" && e.delta.text === "Checking."));
  assert.ok(events.some((e) => e.type === "content_block_start" && e.content_block.type === "tool_use" && e.content_block.id === "tooluse_1"));
  assert.equal(events.find((e) => e.type === "message_delta")?.delta.stop_reason, "tool_use");
  assert.equal(events.at(-1).type, "message_stop");

  const json = await fetch(`${env.baseUrl}/v1/messages`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(message(false)),
  });
  const body = await json.json();
  assert.equal(json.status, 200);
  assert.deepEqual(body.content.map((block: { type: string }) => block.type), ["text", "tool_use"]);
  assert.deepEqual(body.content[1].input, { city: "Paris" });

  // One feature read serves both requests; both go to /v1/responses.
  const features = env.requests.filter((r) => r.url.startsWith("/featureConfiguration"));
  assert.equal(features.length, 1);
  assert.match(features[0].url, /origin=AI_EDITOR/);
  assert.match(String(features[0].headers["user-agent"]), / KiroIDE-[^ ]+-KAS\/[\d.]+ acp-client\/kiro-ide$/);
  assert.equal(features[0].headers["x-amzn-kiro-profile-arn"], "arn:aws:codewhisperer:us-east-1:638616132270:profile/AAAACCCCXXXX");
  const chats = env.requests.filter((r) => r.method === "POST");
  assert.deepEqual(chats.map((r) => r.url), ["/v1/responses", "/v1/responses"]);
  assert.equal(chats[0].headers.authorization, "Bearer access-1");
  assert.equal(chats[0].headers["x-amzn-kiro-profile"], "arn:aws:codewhisperer:us-east-1:638616132270:profile/AAAACCCCXXXX");
  assert.equal(chats[0].body.stream, true);
  assert.deepEqual(chats[0].body.tools.map((tool: { name: string }) => tool.name), ["get_weather"]);

  // Kiro's credits are billed as on generateAssistantResponse.
  const logged = env.database.connection.prepare("SELECT statusCode, kiroCredits FROM request_logs ORDER BY id").all();
  assert.deepEqual(logged.map((row) => ({ ...row })), [{ statusCode: 200, kiroCredits: 0.5 }, { statusCode: 200, kiroCredits: 0.5 }]);
});

test("accounts outside the arm stay on generateAssistantResponse", async (t) => {
  const env = await harness(t, undefined, "");
  const response = await fetch(`${env.baseUrl}/v1/messages`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(message(false)),
  });
  assert.equal(response.status, 200);
  assert.equal((await response.json()).content[0].text, "from generateAssistantResponse");
  assert.deepEqual(env.requests.filter((r) => r.method === "POST").map((r) => r.url), ["/generateAssistantResponse"]);
});

test("a CreateResponse stream that ends without response.completed is reported as cut off", async (t) => {
  const env = await harness(t, "create_response", sse({ type: "response.output_text.delta", delta: "Half a re" }));
  t.mock.method(console, "error", () => {});
  const response = await fetch(`${env.baseUrl}/v1/messages`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(message(false)),
  });
  assert.equal(response.status, 502);
  assert.match((await response.json()).error.message, /closed the stream before finishing/);
});

const maxEffort = (stream = false) => ({
  model: "claude-fable-5-2",
  stream,
  thinking: { type: "adaptive" },
  output_config: { effort: "max" },
  messages: [{ role: "user", content: "Think it through." }],
});
const post = (baseUrl: string, body: unknown) =>
  fetch(`${baseUrl}/v1/messages`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
const TAG = "<thinking_mode>adaptive</thinking_mode><thinking_effort>max</thinking_effort>";

test("the effort reaches CreateResponse as a reasoning field", async (t) => {
  const env = await harness(t, "create_response", sse({ type: "response.output_text.delta", delta: "Done." }, completed()), kiroModelList);
  const logs: string[] = [];
  t.mock.method(console, "log", (line: string) => logs.push(line));
  assert.equal((await post(env.baseUrl, maxEffort())).status, 200);
  assert.equal((await post(env.baseUrl, { ...maxEffort(), output_config: { effort: "low" } })).status, 200);

  const chats = env.requests.filter((r) => r.url === "/v1/responses");
  assert.deepEqual(chats.map((r) => r.body.reasoning), [
    { type: "adaptive", effort: "max" },
    { type: "adaptive", effort: "low" },
  ]);
  assert.deepEqual(chats[0].body.input, [{ role: "user", content: "Think it through." }]);

  // One read of the account's model list serves both requests.
  const lists = env.requests.filter((r) => r.url.startsWith("/ListAvailableModels"));
  assert.equal(lists.length, 1);
  assert.match(lists[0].url, /origin=AI_EDITOR/);
  assert.equal(lists[0].headers.authorization, "Bearer access-1");

  const results = logs.filter((line) => line.startsWith("[route]") && line.includes('"event":"result"'));
  assert.deepEqual(results.map((line) => JSON.parse(line.slice("[route] ".length)).effort), ["max", "low"]);
});

test("the effort reaches generateAssistantResponse as additionalModelRequestFields", async (t) => {
  const env = await harness(t, undefined, "", kiroModelList);
  assert.equal((await post(env.baseUrl, maxEffort())).status, 200);
  const [chat] = env.requests.filter((r) => r.url === "/generateAssistantResponse");
  assert.deepEqual(chat.body.additionalModelRequestFields, {
    thinking: { type: "adaptive" },
    output_config: { effort: "max" },
  });
  assert.equal(chat.body.conversationState.currentMessage.userInputMessage.content, "Think it through.");
});

test("without a readable model list the request goes out as before", async (t) => {
  const env = await harness(t, "create_response", sse({ type: "response.output_text.delta", delta: "Done." }, completed()), null);
  const warnings: string[] = [];
  t.mock.method(console, "warn", (line: string) => warnings.push(line));
  assert.equal((await post(env.baseUrl, maxEffort())).status, 200);
  const [chat] = env.requests.filter((r) => r.url === "/v1/responses");
  assert.equal(Object.hasOwn(chat.body, "reasoning"), false);
  assert.deepEqual(chat.body.input, [{ role: "user", content: `${TAG}\n\nThink it through.` }]);
  assert.deepEqual(warnings, ["[kiro] model list for account 1 unavailable: ListAvailableModels returned HTTP 500"]);
});
