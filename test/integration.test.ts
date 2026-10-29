import test from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { type AddressInfo } from "node:net";
import { AppDatabase } from "../src/db.ts";
import { createServerContext } from "../src/server.ts";
import { config } from "../src/config.ts";
import { eventFrame, successfulKiroStream } from "./helpers.ts";

async function listen(server: http.Server): Promise<string> {
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  return `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
}

async function jsonRequest(url: string, options?: RequestInit) {
  const response = await fetch(url, {
    ...options,
    headers: {
      "content-type": "application/json",
      ...(options?.headers || {}),
    },
  });
  return { response, body: await response.json() };
}

async function createHarness(t: test.TestContext) {
  const inferenceBodies: any[] = [];
  const inferenceHeaders: any[] = [];
  const upstream = http.createServer((req, res) => {
    if (req.method === "GET" && req.url?.startsWith("/getUsageLimits")) {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(
        JSON.stringify({
          subscriptionInfo: { subscriptionTitle: "Kiro Pro" },
          usageBreakdownList: [
            {
              currentUsage: 10,
              currentUsageWithPrecision: 10,
              usageLimit: 100,
              usageLimitWithPrecision: 100,
              nextDateReset: 1800000000,
            },
          ],
        }),
      );
      return;
    }
    if (req.method === "POST" && req.url === "/generateAssistantResponse") {
      let body = "";
      req.on("data", (chunk) => (body += chunk));
      req.on("end", () => {
        inferenceBodies.push(JSON.parse(body));
        inferenceHeaders.push(req.headers);
        if (req.headers.authorization === "Bearer kiro-error") {
          res.writeHead(403, { "content-type": "application/json" });
          res.end(JSON.stringify({ message: "Due to suspicious activity, Kiro has paused this account. See https://app.kiro.dev/account/usage" }));
          return;
        }
        if (req.headers.authorization === "Bearer bad-key") {
          res.writeHead(402, { "content-type": "application/json" });
          res.end(
            JSON.stringify({
              reason: "MONTHLY_REQUEST_COUNT",
              message: "Quota exhausted",
            }),
          );
          return;
        }
        res.writeHead(200, {
          "content-type": "application/vnd.amazon.eventstream",
        });
        if (req.headers.authorization === "Bearer kiro-truncates") {
          // Kiro closing the stream mid-reply: content but no meteringEvent.
          res.end(Buffer.concat([eventFrame({ content: "Half a repl" }), eventFrame({ contextUsagePercentage: 90 })]));
          return;
        }
        res.end(successfulKiroStream("Hello from local Kiro", 0.25));
      });
      return;
    }
    res.writeHead(404).end();
  });
  const upstreamUrl = await listen(upstream);
  const previousUpstream = config.upstreamBaseUrl;
  config.upstreamBaseUrl = upstreamUrl;
  const database = new AppDatabase(":memory:");
  const appServer = http.createServer(createServerContext(database).app);
  const baseUrl = await listen(appServer);
  t.after(() => {
    config.upstreamBaseUrl = previousUpstream;
    upstream.closeAllConnections();
    upstream.close();
    appServer.closeAllConnections();
    appServer.close();
    database.close();
  });
  return { baseUrl, inferenceBodies, inferenceHeaders };
}

async function importAccount(baseUrl: string, key: string) {
  const { response, body } = await jsonRequest(
    `${baseUrl}/api/accounts/import`,
    {
      method: "POST",
      body: JSON.stringify({ text: key }),
    },
  );
  assert.equal(response.status, 200);
  assert.equal(body.created, 1);
  return body.accountIds[0];
}

async function sendMessage(
  baseUrl: string,
  model: string,
  headers: Record<string, string> = {},
) {
  return jsonRequest(`${baseUrl}/v1/messages`, {
    method: "POST",
    headers,
    body: JSON.stringify({
      model,
      messages: [{ role: "user", content: "hello" }],
    }),
  });
}

test("account management handles quota, usage, tests, and credential display", async (t) => {
  const { baseUrl, inferenceBodies } = await createHarness(t);
  const badId = await importAccount(baseUrl, "bad-key");
  const failed = await sendMessage(baseUrl, "claude-haiku-4.5");
  assert.equal(failed.response.status, 402);
  const disabled = await jsonRequest(`${baseUrl}/api/accounts`);
  assert.equal(disabled.body.accounts[0].autoDisabled, true);

  const goodId = await importAccount(baseUrl, "good-key");
  assert.notEqual(goodId, badId);
  const usage = await jsonRequest(`${baseUrl}/api/accounts/${goodId}/usage`, {
    method: "POST",
  });
  assert.equal(usage.body.statusInfo.remaining, 90);
  assert.equal(usage.body.statusInfo.subscriptionTitle, "Kiro Pro");

  const tested = await jsonRequest(`${baseUrl}/api/accounts/${goodId}/test`, {
    method: "POST",
    body: "{}",
  });
  assert.equal(tested.response.status, 200);
  assert.equal(tested.body.success, true);
  assert.equal(tested.body.responseContent, "Hello from local Kiro");
  assert.equal(
    inferenceBodies[1].conversationState.currentMessage.userInputMessage
      .modelId,
    "claude-haiku-4.5",
  );

  const listed = await jsonRequest(`${baseUrl}/api/accounts`);
  assert.equal(listed.body.accounts[0].maskedToken.includes("good-key"), false);
  const shown = await jsonRequest(`${baseUrl}/api/accounts/${goodId}`);
  assert.equal(shown.body.credentials.accessToken, "good-key");
  assert.equal(shown.body.usage.totalKiroCredits, 0.25);
});

test("messages and metrics preserve model mapping, headers, JSON, SSE, and aggregates", async (t) => {
  const { baseUrl, inferenceBodies, inferenceHeaders } = await createHarness(t);
  await importAccount(baseUrl, "good-key");
  const wildcard = await sendMessage(baseUrl, "claude-*", {
    "anthropic-beta": "tools-2024-05-16",
  });
  assert.equal(wildcard.response.status, 200);
  // No silent rewrite to another model: the requested name goes to Kiro.
  assert.equal(
    inferenceBodies[0].conversationState.currentMessage.userInputMessage
      .modelId,
    "claude-*",
  );
  assert.equal(inferenceHeaders[0]["anthropic-beta"], "tools-2024-05-16");

  const message = await sendMessage(baseUrl, "claude-sonnet-4.5");
  assert.equal(message.response.status, 200);
  assert.equal(message.body.type, "message");
  assert.equal(message.body.content[0].text, "Hello from local Kiro");
  assert.ok(message.body.usage.output_tokens > 0);

  const sse = await fetch(`${baseUrl}/v1/messages`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      model: "claude-sonnet-4.5",
      stream: true,
      messages: [{ role: "user", content: "hello again" }],
    }),
  });
  assert.equal(sse.status, 200);
  const sseText = await sse.text();
  assert.match(sseText, /event: message_start/);
  assert.match(sseText, /Hello from local Kiro/);
  assert.match(sseText, /event: message_stop/);

  const accountId = (await jsonRequest(`${baseUrl}/api/accounts`)).body
    .accounts[0].id;
  const shown = await jsonRequest(`${baseUrl}/api/accounts/${accountId}`);
  assert.equal(shown.body.usage.totalKiroCredits, 0.75);

  const end = Date.now();
  const query = `startTime=${encodeURIComponent(new Date(end - 3600000).toISOString())}&endTime=${encodeURIComponent(new Date(end + 1000).toISOString())}`;
  const metrics = await jsonRequest(
    `${baseUrl}/api/metrics/performance?${query}`,
  );
  assert.equal(metrics.body.totalRequests, 3);
  assert.equal(metrics.body.successRequests, 3);
  assert.equal(metrics.body.failedRequests, 0);
  assert.ok(metrics.body.totalCostUsd > 0);
  const series = await jsonRequest(
    `${baseUrl}/api/metrics/performance/timeseries?${query}`,
  );
  assert.equal(
    series.body.timeseries.reduce(
      (sum: number, point: any) => sum + point.totalRequests,
      0,
    ),
    3,
  );
  const models = await jsonRequest(
    `${baseUrl}/api/metrics/performance/models?${query}`,
  );
  assert.equal(models.body.models[0].model, "claude-sonnet-4.5");
  const modelCost = await jsonRequest(
    `${baseUrl}/api/metrics/performance/model-cost-timeseries?${query}`,
  );
  assert.deepEqual(modelCost.body.models, [
    "claude-*",
    "claude-sonnet-4.5",
  ]);

  const history = await jsonRequest(
    `${baseUrl}/api/history?${query}&limit=2&offset=0`,
  );
  assert.equal(history.body.total, 3);
  assert.equal(history.body.totalPages, 2);
  assert.equal(history.body.currentPage, 1);
  assert.equal(history.body.entries.length, 2);
  const latest = history.body.entries[0];
  assert.equal(latest.model, "claude-sonnet-4.5");
  assert.equal(latest.accountId, accountId);
  assert.ok(Number.isInteger(latest.id));
  assert.ok(latest.costUsd > 0);
  assert.ok(latest.cumulativeCostUsd > 0);
  assert.ok(latest.usage.output_tokens > 0);
  assert.ok(latest.cost.total_cost_usd > 0);
  assert.ok(latest.timing.total_time_ms >= 0);
  assert.equal(latest.kiroCredits, 0.25);
  const secondPage = await jsonRequest(
    `${baseUrl}/api/history?${query}&limit=2&offset=2`,
  );
  assert.equal(secondPage.body.entries.length, 1);
  assert.equal(secondPage.body.currentPage, 2);
  const aggregated = await jsonRequest(
    `${baseUrl}/api/history/aggregated?${query}`,
  );
  assert.ok(aggregated.body.totalSpent > 0);
  assert.equal(aggregated.body.interval, 600000);
  assert.ok(aggregated.body.buckets.length > 0);

  const admin = await fetch(`${baseUrl}/`);
  assert.equal(admin.status, 200);
  assert.match(await admin.text(), /Kiro account pool/);
  assert.equal(inferenceBodies.length, 3);
});

test("requested models reach Kiro unchanged, including Opus and Fable", async (t) => {
  const { baseUrl, inferenceBodies } = await createHarness(t);
  await importAccount(baseUrl, "good-key");
  for (const model of ["claude-opus-4-6", "claude-opus-5-5", "claude-fable-5-1", "claude-sonnet-5-5"]) {
    const result = await sendMessage(baseUrl, model);
    assert.equal(result.response.status, 200, model);
    assert.equal(result.body.model, model, "the response reports the model that was requested and served");
  }
  const sent = inferenceBodies.map((b) => b.conversationState.currentMessage.userInputMessage.modelId);
  assert.deepEqual(sent, ["claude-opus-4.6", "claude-opus-5.5", "claude-fable-5.1", "claude-sonnet-5.5"]);
});

test("Kiro errors are passed through unchanged, not cloaked", async (t) => {
  const { baseUrl } = await createHarness(t);
  await importAccount(baseUrl, "kiro-error");
  const result = await sendMessage(baseUrl, "claude-sonnet-4-5");
  assert.equal(result.response.status, 403);
  assert.match(JSON.stringify(result.body), /Due to suspicious activity, Kiro has paused this account/);
  assert.doesNotMatch(JSON.stringify(result.body), /temporary issues/);
});

test("a session sticks to one account across models; failures fail over", async (t) => {
  const { baseUrl, inferenceHeaders } = await createHarness(t);
  await importAccount(baseUrl, "good-key");
  await importAccount(baseUrl, "good-key-2");
  const send = (model: string, user: string) =>
    jsonRequest(`${baseUrl}/v1/messages`, {
      method: "POST",
      body: JSON.stringify({ model, metadata: { user_id: user }, messages: [{ role: "user", content: "hi" }] }),
    });
  for (const model of ["claude-opus-4-6", "claude-haiku-4-5", "claude-sonnet-4-5", "claude-opus-4-6"])
    assert.equal((await send(model, "user_x_account__session_11111111-1111-4111-8111-111111111111")).response.status, 200);
  const used = new Set(inferenceHeaders.map((h) => h.authorization));
  assert.equal(used.size, 1, "one session, one account, regardless of model");
});

test("when every account fails, the client gets the last real Kiro error", async (t) => {
  const { baseUrl } = await createHarness(t);
  await importAccount(baseUrl, "kiro-error");
  await importAccount(baseUrl, "bad-key");
  const result = await sendMessage(baseUrl, "claude-sonnet-4-5");
  assert.ok([402, 403].includes(result.response.status), String(result.response.status));
  assert.match(JSON.stringify(result.body), /Quota exhausted|suspicious activity/);
});

test("a reply Kiro cuts off (no metering event) is reported as an error, not end_turn", async (t) => {
  const { baseUrl } = await createHarness(t);
  await importAccount(baseUrl, "kiro-truncates");
  const json = await sendMessage(baseUrl, "claude-sonnet-4-6");
  assert.equal(json.response.status, 502);
  assert.equal(json.body.type, "error");
  assert.match(json.body.error.message, /closed the stream before finishing/);

  const response = await fetch(`${baseUrl}/v1/messages`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ model: "claude-sonnet-4-6", stream: true, messages: [{ role: "user", content: "hello" }] }),
  });
  const sse = await response.text();
  assert.match(sse, /Half a repl/);
  assert.doesNotMatch(sse, /end_turn|message_stop/);
  assert.match(sse, /event: error\ndata: \{"type":"error","error":\{"type":"overloaded_error","message":"Kiro closed the stream before finishing/);
});
