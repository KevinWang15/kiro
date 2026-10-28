import test from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { AddressInfo } from "node:net";
import { AppDatabase } from "../src/db.js";
import { createServerContext } from "../src/server.js";
import { config } from "../src/config.js";
import { successfulKiroStream } from "./helpers.js";

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
  assert.equal(
    inferenceBodies[0].conversationState.currentMessage.userInputMessage
      .modelId,
    "claude-haiku-4.5",
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
    "claude-haiku-4-5-20251001",
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
