import test from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { parseCredentialInput } from "../src/accounts/credential-input.ts";
import {
  normalizeKiroExtraConfigAliases,
  TokenManager,
} from "../src/accounts/token-manager.ts";
import {
  aggregateUsage,
  canFetchKiroUsage,
  shouldUseCborApi,
} from "../src/accounts/usage-service.ts";
import { AppDatabase } from "../src/db.ts";
import { AccountRepository } from "../src/accounts/repository.ts";
import { ProxyRepository } from "../src/accounts/proxies.ts";

function fakeJwt(payload: Record<string, unknown>): string {
  const encoded = Buffer.from(JSON.stringify(payload)).toString("base64url");
  return `header.${encoded}.signature`;
}

test("credential input handles nested exports, raw keys and generated API-key JSON", () => {
  const nested = parseCredentialInput(
    JSON.stringify({
      accounts: [
        {
          email: "user@example.invalid",
          idp: "github.com",
          credentials: { refresh_token: "refresh", expiresAt: 1781202488018 },
        },
      ],
    }),
  );
  assert.equal(nested.length, 1);
  assert.equal(nested[0].canonical.provider, "Github");
  assert.equal(nested[0].canonical.refreshToken, "refresh");
  const raw = parseCredentialInput("ksk_test_key");
  assert.equal(raw[0].canonical.authMethod, "api_key");
  assert.equal(raw[0].canonical.accessToken, "ksk_test_key");
  const generated = parseCredentialInput(
    JSON.stringify({
      apiKey: "ksk_generated",
      extraConfig: JSON.stringify({
        authMethod: "api_key",
        runtimeRegion: "eu-central-1",
      }),
    }),
  );
  assert.equal(generated[0].canonical.runtimeRegion, "eu-central-1");
});

test("external IdP aliases and Microsoft metadata are inferred", () => {
  const accessToken = fakeJwt({
    iss: "https://login.microsoftonline.com/tenant/v2.0",
    aud: "client",
    scp: "codewhisperer:conversations",
  });
  const normalized = normalizeKiroExtraConfigAliases({
    access_token: accessToken,
    refresh_token: "refresh",
    auth_method: "external_idp",
    provider: "ExternalIdp",
    client_id: "client",
  });
  assert.equal(
    normalized.tokenEndpoint,
    "https://login.microsoftonline.com/tenant/oauth2/v2.0/token",
  );
  assert.equal(
    normalized.scopes,
    "api://client/codewhisperer:conversations offline_access",
  );
});

test("external IdP conversion performs a real local token request", async (t) => {
  let form = "";
  const server = http.createServer((req, res) => {
    let body = "";
    req.on("data", (chunk) => (body += chunk));
    req.on("end", () => {
      form = body;
      res.writeHead(200, { "content-type": "application/json" });
      res.end(
        JSON.stringify({
          access_token: "fresh-access",
          refresh_token: "fresh-refresh",
          expires_in: 1800,
        }),
      );
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(() => server.close());
  const address = server.address() as any;
  const database = new AppDatabase(":memory:");
  t.after(() => database.close());
  const manager = new TokenManager(
    new AccountRepository(database),
    new ProxyRepository(database),
  );
  const converted = await manager.convertCredential({
    provider: "ExternalIdp",
    authMethod: "external_idp",
    refreshToken: "old-refresh",
    clientId: "client",
    tokenEndpoint: `http://127.0.0.1:${address.port}/token`,
  });
  assert.equal(converted.accessToken, "fresh-access");
  assert.equal(converted.refreshToken, "fresh-refresh");
  const params = new URLSearchParams(form);
  assert.equal(params.get("grant_type"), "refresh_token");
  assert.equal(params.get("refresh_token"), "old-refresh");
});

test("usage aggregation includes active trial and bonuses", () => {
  const status = aggregateUsage({
    subscriptionInfo: { subscriptionTitle: "Pro" },
    usageBreakdownList: [
      {
        currentUsage: 10,
        currentUsageWithPrecision: 10.25,
        usageLimit: 100,
        usageLimitWithPrecision: 100.5,
        nextDateReset: 1800000000,
        freeTrialInfo: {
          currentUsage: 1,
          currentUsageWithPrecision: 1.25,
          usageLimit: 10,
          usageLimitWithPrecision: 10.5,
          freeTrialStatus: "ACTIVE",
        },
        bonuses: [{ currentUsage: 2, usageLimit: 20, status: "ACTIVE" }],
      },
    ],
  });
  assert.equal(status.currentUsage, 13.5);
  assert.equal(status.usageLimit, 131);
  assert.equal(status.remaining, 117.5);
  assert.equal(status.subscriptionTitle, "Pro");
  assert.equal(shouldUseCborApi({ provider: "Google" }), true);
  assert.equal(shouldUseCborApi({ authMethod: "api_key" }), false);
  assert.equal(canFetchKiroUsage("key", { authMethod: "api_key" }), true);
});

test("reset dates are read as seconds or milliseconds", async () => {
  const { resetDateFrom } = await import("../src/accounts/usage-service.ts");
  assert.equal(resetDateFrom(1800000000), "2027-01-15T08:00:00.000Z");
  assert.equal(resetDateFrom(1793491200000), "2026-11-01T00:00:00.000Z");
  assert.equal(resetDateFrom(undefined), null);
  assert.equal(resetDateFrom(0), null);
});
