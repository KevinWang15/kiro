import test from "node:test";
import assert from "node:assert/strict";
import { Readable } from "node:stream";
import axios, { type AxiosAdapter, type InternalAxiosRequestConfig } from "axios";
import { AppDatabase } from "../src/db.ts";
import { createServerContext } from "../src/server.ts";
import KiroApiProviderHandler from "../src/kiro/handler.ts";
import { callWebSearchMcpWithConfig } from "../src/kiro/mcp-shim.ts";
import { fetchKiroUsageLimits } from "../src/accounts/usage-service.ts";
import type { ProviderExtraConfig } from "../src/kiro/provider.ts";
import type { MessagesRequest } from "../src/kiro/types.ts";
import { BUILDER_ID_PROFILE_ARN, SOCIAL_PROFILE_ARN } from "../src/kiro/profile.ts";
import { successfulKiroStream } from "./helpers.ts";

const realArn = "arn:aws:codewhisperer:eu-central-1:123456789012:profile/REAL";
const request: MessagesRequest = {
  model: "claude-haiku-4-5",
  messages: [{ role: "user", content: "Reply OK" }],
};
const mcpResponse = {
  id: "test",
  jsonrpc: "2.0",
  result: {
    is_error: false,
    content: [{ type: "text", text: JSON.stringify({ results: [], totalResults: 0 }) }],
  },
};

function useAdapter(t: test.TestContext, adapter: AxiosAdapter): void {
  const previous = axios.defaults.adapter;
  axios.defaults.adapter = adapter;
  t.after(() => { axios.defaults.adapter = previous; });
}

const streamingCases: Array<[string, ProviderExtraConfig | null | undefined, string | undefined]> = [
  ["missing config", null, BUILDER_ID_PROFILE_ARN],
  ["undefined config", undefined, BUILDER_ID_PROFILE_ARN],
  ["legacy OAuth", {}, BUILDER_ID_PROFILE_ARN],
  ["Builder ID", { provider: "BuilderId" }, BUILDER_ID_PROFILE_ARN],
  ["empty ARN", { profileArn: "" }, BUILDER_ID_PROFILE_ARN],
  ["blank ARN", { profileArn: "  " }, BUILDER_ID_PROFILE_ARN],
  ["configured ARN", { provider: "BuilderId", profileArn: realArn }, realArn],
  ["configured placeholder", { profileArn: BUILDER_ID_PROFILE_ARN }, BUILDER_ID_PROFILE_ARN],
  ["social with configured ARN", { provider: "Github", profileArn: realArn }, realArn],
  ["legacy ARN alias", { profile_arn: realArn }, realArn],
  ["empty ARN with alias", { profileArn: "", profile_arn: realArn }, realArn],
  ["blank ARN with alias", { profileArn: "  ", profile_arn: realArn }, realArn],
  ["primary ARN takes precedence", { profileArn: realArn, profile_arn: SOCIAL_PROFILE_ARN }, realArn],
  ["GitHub", { provider: "Github" }, SOCIAL_PROFILE_ARN],
  ["Google with case and whitespace", { provider: " google " }, SOCIAL_PROFILE_ARN],
  ["social auth with case and whitespace", { authMethod: " SOCIAL " }, SOCIAL_PROFILE_ARN],
  ["API key", { authMethod: "api_key" }, undefined],
  ["API key alias", { authMethod: " APIKEY " }, undefined],
  ["legacy API key value", { kiroApiKey: "ksk_test" }, undefined],
  ["API key overrides social default", { authMethod: "api_key", provider: "Github" }, undefined],
  ["API key with configured ARN", { authMethod: "api_key", profileArn: realArn }, realArn],
];

for (const [label, credentials, expected] of streamingCases) {
  test(`outgoing inference and MCP profile: ${label}`, async (t) => {
    const original = structuredClone(credentials);
    const handler = new KiroApiProviderHandler();
    const body = handler.transformRequestBody(structuredClone(request), credentials);
    assert.equal(body.profileArn, expected);
    assert.equal(Object.hasOwn(body, "profileArn"), expected !== undefined);
    assert.deepEqual(credentials, original);

    let sent: InternalAxiosRequestConfig | undefined;
    useAdapter(t, async (config) => {
      sent = config;
      return { config, data: mcpResponse, status: 200, statusText: "OK", headers: {} };
    });
    const mcpConfig = { accessToken: "test-access", ...(credentials ?? {}) };
    const originalMcp = structuredClone(mcpConfig);
    const result = await callWebSearchMcpWithConfig("test", mcpConfig);
    assert.equal(result.error, undefined);
    assert.ok(sent?.url?.endsWith("/mcp"));
    assert.equal(sent.headers.get("x-amzn-kiro-profile-arn"), expected);
    assert.equal(sent.headers.has("x-amzn-kiro-profile-arn"), expected !== undefined);
    assert.deepEqual(mcpConfig, originalMcp);
  });
}

const usageCases: Array<[string, ProviderExtraConfig, string | undefined]> = [
  ["missing OAuth profile", { provider: "BuilderId" }, undefined],
  ["empty profile", { profileArn: "" }, undefined],
  ["blank profile", { profileArn: "  " }, undefined],
  ["Builder ID placeholder", { provider: "BuilderId", profileArn: BUILDER_ID_PROFILE_ARN }, undefined],
  ["placeholder alias", { profile_arn: BUILDER_ID_PROFILE_ARN }, undefined],
  ["shared social profile", { provider: "Github", profileArn: SOCIAL_PROFILE_ARN }, SOCIAL_PROFILE_ARN],
  ["configured real profile", { provider: "ExternalIdp", profileArn: realArn }, realArn],
  ["configured real alias", { provider: "ExternalIdp", profile_arn: realArn }, realArn],
  ["blank primary with real alias", { profileArn: "  ", profile_arn: realArn }, realArn],
  ["API key without profile", { authMethod: "api_key" }, undefined],
  ["API key with real profile", { authMethod: "api_key", profileArn: realArn }, realArn],
  ["API key with placeholder", { authMethod: "api_key", profileArn: BUILDER_ID_PROFILE_ARN }, undefined],
];

for (const [label, credentials, expected] of usageCases) {
  test(`usage query profile: ${label}`, async (t) => {
    const original = structuredClone(credentials);
    const requests: InternalAxiosRequestConfig[] = [];
    useAdapter(t, async (config) => {
      requests.push(config);
      if (config.method === "post") {
        // Exercise the existing CBOR-to-REST fallback without external calls.
        return { config, data: Buffer.alloc(0), status: 503, statusText: "Unavailable", headers: {} };
      }
      return {
        config,
        status: 200,
        statusText: "OK",
        headers: {},
        data: {
          subscriptionInfo: { subscriptionTitle: "Pro" },
          usageBreakdownList: [{ currentUsage: 10, usageLimit: 100 }],
        },
      };
    });
    const result = await fetchKiroUsageLimits("test-access", credentials, null);
    assert.equal(result?.remaining, 90);
    const rest = requests.find((config) => config.method === "get");
    assert.ok(rest?.url);
    const url = new URL(rest.url);
    assert.equal(url.pathname, "/getUsageLimits");
    assert.equal(url.searchParams.get("profileArn"), expected ?? null);
    assert.deepEqual(credentials, original);
    for (const cbor of requests.filter((config) => config.method === "post")) {
      assert.equal(cbor.headers.has("x-amzn-kiro-profile-arn"), false);
    }
  });
}

test("pooled inference and web search apply profiles without changing stored credentials", async (t) => {
  const requests: InternalAxiosRequestConfig[] = [];
  useAdapter(t, async (config) => {
    requests.push(config);
    return {
      config,
      data: config.url?.endsWith("/mcp")
        ? mcpResponse
        : Readable.from([successfulKiroStream("OK")]),
      status: 200,
      statusText: "OK",
      headers: {},
    };
  });
  for (const [credentials, expected] of [
    [{ provider: "BuilderId" }, BUILDER_ID_PROFILE_ARN],
    [{ provider: "Github" }, SOCIAL_PROFILE_ARN],
    [{ profileArn: "  ", profile_arn: realArn }, realArn],
    [{ authMethod: "api_key" }, undefined],
    [{ kiroApiKey: "ksk_test" }, undefined],
  ] as Array<[ProviderExtraConfig, string | undefined]>) {
    const database = new AppDatabase(":memory:");
    try {
      const context = createServerContext(database);
      const account = context.accounts.create({ credentials: { accessToken: "test-access", ...credentials } });
      const stored = account.credentials;
      const start = requests.length;
      const inference = await context.pool.call(structuredClone(request));
      assert.equal(inference.success, true);
      const sent = JSON.parse(requests[start].data);
      assert.equal(sent.profileArn, expected);
      assert.equal(Object.hasOwn(sent, "profileArn"), expected !== undefined);
      const search = await context.pool.call({ ...structuredClone(request), tools: [{ name: "web_search" }] });
      assert.equal(search.success, true);
      assert.ok(requests[start + 1].url?.endsWith("/mcp"));
      assert.equal(requests[start + 1].headers.get("x-amzn-kiro-profile-arn"), expected);
      assert.equal(context.accounts.get(account.id)!.credentials, stored);
    } finally {
      database.close();
    }
  }
});
