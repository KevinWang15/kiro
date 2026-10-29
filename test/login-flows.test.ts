import test from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { type AddressInfo } from "node:net";
import { AppDatabase } from "../src/db.ts";
import { createServerContext } from "../src/server.ts";
import { config } from "../src/config.ts";

async function listen(server: http.Server): Promise<string> {
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  return `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
}

const readBody = (req: http.IncomingMessage) =>
  new Promise<string>((resolve) => {
    let body = "";
    req.on("data", (c) => (body += c));
    req.on("end", () => resolve(body));
  });

// One fake standing in for AWS OIDC, the Kiro auth service, CodeWhisperer
// profiles, an external IdP and the Kiro runtime (usage limits).
async function createHarness(t: test.TestContext) {
  const calls: Array<{ path: string; body: any }> = [];
  let devicePolls = 0;
  let fakeUrl = "";
  const fake = http.createServer(async (req, res) => {
    const raw = await readBody(req);
    let body: any = raw;
    try { body = JSON.parse(raw); } catch { body = Object.fromEntries(new URLSearchParams(raw)); }
    const path = (req.url || "").split("?")[0];
    calls.push({ path, body });
    const json = (status: number, data: unknown) => {
      res.writeHead(status, { "content-type": "application/json" });
      res.end(JSON.stringify(data));
    };
    if (path === "/oidc/client/register") return json(200, { clientId: "client-1", clientSecret: "secret-1" });
    if (path === "/oidc/device_authorization")
      return json(200, { deviceCode: "dev-1", userCode: "ABCD-EFGH", verificationUri: "https://device.example/", verificationUriComplete: "https://device.example/?code=ABCD-EFGH", interval: 1, expiresIn: 600 });
    if (path === "/oidc/token") {
      if (body.grantType === "urn:ietf:params:oauth:grant-type:device_code") {
        devicePolls++;
        if (devicePolls < 2) return json(400, { error: "authorization_pending" });
        return json(200, { accessToken: "builder-access", refreshToken: "builder-refresh", expiresIn: 3600 });
      }
      if (body.grantType === "authorization_code")
        return json(200, { accessToken: "idc-access", refreshToken: "idc-refresh", expiresIn: 3600 });
      if (body.grantType === "refresh_token") {
        if (body.refreshToken === "revoked") return json(400, { error: "invalid_grant", error_description: "Invalid refresh token provided" });
        return json(200, { accessToken: `refreshed-${body.refreshToken}`, refreshToken: body.refreshToken, expiresIn: 3600 });
      }
    }
    if (path === "/codewhisperer/ListAvailableProfiles")
      return json(200, { profiles: [{ arn: "arn:aws:codewhisperer:eu-central-1:123456789012:profile/ABC" }] });
    if (path === "/oauth/token")
      return json(200, { accessToken: "social-access", refreshToken: "social-refresh", expiresIn: 3600, profileArn: "arn:aws:codewhisperer:us-east-1:111:profile/P" });
    if (path === "/refreshToken")
      return json(200, { accessToken: `refreshed-${body.refreshToken}`, refreshToken: body.refreshToken, expiresIn: 3600 });
    if (path === "/idp/.well-known/openid-configuration")
      return json(200, { authorization_endpoint: `${fakeUrl}/idp/authorize`, token_endpoint: `${fakeUrl}/idp/token` });
    if (path === "/idp/token") return json(200, { access_token: "idp-access", ...(body.code === "no-refresh" ? {} : { refresh_token: "idp-refresh" }), expires_in: 3600 });
    if (path === "/getUsageLimits")
      return json(200, { subscriptionInfo: { subscriptionTitle: "KIRO PRO" }, usageBreakdownList: [{ currentUsage: 1, usageLimit: 100 }] });
    json(404, { error: "not found" });
  });
  fakeUrl = await listen(fake);
  const previous = { auth: config.authBaseUrl, upstream: config.upstreamBaseUrl };
  config.authBaseUrl = fakeUrl;
  config.upstreamBaseUrl = fakeUrl;
  const database = new AppDatabase(":memory:");
  const context = createServerContext(database);
  const app = http.createServer(context.app);
  const baseUrl = await listen(app);
  t.after(() => {
    config.authBaseUrl = previous.auth;
    config.upstreamBaseUrl = previous.upstream;
    context.logins.close();
    app.close();
    fake.close();
    database.close();
  });
  const api = async (path: string, init?: RequestInit) => {
    const response = await fetch(`${baseUrl}${path}`, {
      ...init,
      headers: { "content-type": "application/json", ...(init?.headers || {}) },
    });
    const text = await response.text();
    let body: any = text;
    try { body = JSON.parse(text); } catch {}
    return { status: response.status, body, response };
  };
  const waitFor = async (id: string, status: string) => {
    for (let i = 0; i < 50; i++) {
      const { body } = await api(`/api/logins/${id}`);
      if (body.status === status) return body;
      await new Promise((r) => setTimeout(r, 100));
    }
    throw new Error(`login ${id} never reached ${status}`);
  };
  return { api, baseUrl, fakeUrl, calls, waitFor, context };
}

test("Builder ID device flow creates an account without exposing tokens", async (t) => {
  const { api, waitFor, context } = await createHarness(t);
  const start = await api("/api/logins/builder-id", { method: "POST", body: JSON.stringify({ region: "us-east-1" }) });
  assert.equal(start.status, 201);
  assert.equal(start.body.userCode, "ABCD-EFGH");
  assert.equal(start.body.verificationUrl, "https://device.example/?code=ABCD-EFGH");
  const done = await waitFor(start.body.id, "complete");
  assert.equal(done.label, "AWS Builder ID");
  assert.ok(!JSON.stringify(done).includes("builder-refresh"), "session view must not leak tokens");

  const created = await api(`/api/logins/${start.body.id}/account`, { method: "POST", body: JSON.stringify({ priority: 3, comment: "Work" }) });
  assert.equal(created.status, 201);
  const account = context.accounts.get(created.body.id)!;
  const credentials = JSON.parse(account.credentials);
  assert.equal(credentials.provider, "BuilderId");
  assert.equal(credentials.clientId, "client-1");
  assert.equal(account.priority, 3);
  assert.equal(account.comment, "Work");
  assert.equal(account.source, "Signed in with AWS Builder ID");

  // A finished session can only be turned into an account once.
  const again = await api(`/api/logins/${start.body.id}/account`, { method: "POST", body: "{}" });
  assert.equal(again.status, 409);
});

test("Kiro portal Google sign-in completes through the adapter's own callback", async (t) => {
  const { api, baseUrl, calls, waitFor } = await createHarness(t);
  const start = await api("/api/logins/kiro", { method: "POST", body: JSON.stringify({ origin: baseUrl }) });
  assert.equal(start.status, 201);
  const signin = new URL(start.body.verificationUrl);
  assert.equal(signin.origin + signin.pathname, "https://app.kiro.dev/signin");
  // Bare origin, as login-external-idp.js sends it; the portal picks the path.
  assert.equal(signin.searchParams.get("redirect_uri"), baseUrl);
  assert.equal(signin.searchParams.get("code_challenge_method"), "S256");
  const state = signin.searchParams.get("state")!;

  const wrong = await fetch(`${baseUrl}/oauth/callback?state=nope&code=x&login_option=google`);
  assert.equal(wrong.status, 400, "unknown state is rejected");

  // Kiro may return to the bare origin; the dashboard path must accept it.
  const callback = await fetch(`${baseUrl}/?state=${state}&code=auth-code&login_option=google`);
  assert.equal(callback.status, 200);
  assert.match(await callback.text(), /Signed in/);
  const exchange = calls.find((c) => c.path === "/oauth/token")!;
  assert.equal(exchange.body.code, "auth-code");
  assert.equal(exchange.body.redirect_uri, `${baseUrl}/?login_option=google`);
  assert.ok(exchange.body.code_verifier.length >= 43);
  const done = await waitFor(start.body.id, "complete");
  assert.equal(done.label, "Google");
});

test("portal returns to /signin/callback use that path in the token exchange", async (t) => {
  const { api, baseUrl, calls, waitFor } = await createHarness(t);
  const start = await api("/api/logins/kiro", { method: "POST", body: JSON.stringify({ origin: baseUrl }) });
  const state = new URL(start.body.verificationUrl).searchParams.get("state")!;
  const callback = await fetch(`${baseUrl}/signin/callback?state=${state}&code=gh-code&login_option=github`);
  assert.equal(callback.status, 200);
  assert.equal(calls.find((c) => c.path === "/oauth/token")!.body.redirect_uri, `${baseUrl}/signin/callback?login_option=github`);
  assert.equal((await waitFor(start.body.id, "complete")).label, "GitHub");
});

test("the dashboard still loads at / without sign-in parameters", async (t) => {
  const { baseUrl } = await createHarness(t);
  for (const path of ["/", "/?range=1h", "/?state=only"]) {
    const response = await fetch(`${baseUrl}${path}`);
    assert.equal(response.status, 200, path);
    assert.match(await response.text(), /<title>Kiro Local Adapter<\/title>/, path);
  }
});

test("Kiro portal external IdP does the second redirect and token exchange", async (t) => {
  const { api, baseUrl, fakeUrl, waitFor, context } = await createHarness(t);
  const start = await api("/api/logins/kiro", { method: "POST", body: JSON.stringify({ origin: baseUrl }) });
  const state = new URL(start.body.verificationUrl).searchParams.get("state")!;
  const first = await fetch(
    `${baseUrl}/oauth/callback?state=${state}&login_option=external_idp&issuer_url=${encodeURIComponent(`${fakeUrl}/idp`)}&client_id=idp-client&scopes=openid%20email`,
    { redirect: "manual" },
  );
  assert.equal(first.status, 302);
  const authorize = new URL(first.headers.get("location")!);
  assert.equal(authorize.origin + authorize.pathname, `${fakeUrl}/idp/authorize`);
  assert.equal(authorize.searchParams.get("scope"), "openid email offline_access");
  const second = await fetch(`${baseUrl}/oauth/callback?state=${authorize.searchParams.get("state")}&code=idp-code`);
  assert.equal(second.status, 200);
  await waitFor(start.body.id, "complete");
  const created = await api(`/api/logins/${start.body.id}/account`, { method: "POST", body: "{}" });
  const credentials = JSON.parse(context.accounts.get(created.body.id)!.credentials);
  assert.equal(credentials.provider, "ExternalIdp");
  assert.equal(credentials.tokenEndpoint, `${fakeUrl}/idp/token`);
});

test("IAM Identity Center resolves the profile ARN and runtime region", async (t) => {
  const { api, baseUrl, calls, waitFor, context } = await createHarness(t);
  const start = await api("/api/logins/identity-center", {
    method: "POST",
    body: JSON.stringify({ origin: baseUrl, region: "eu-central-1", startUrl: "https://d-1234567890.awsapps.com/start" }),
  });
  assert.equal(start.status, 201, JSON.stringify(start.body));
  const authorize = new URL(start.body.verificationUrl);
  assert.match(authorize.searchParams.get("redirect_uri")!, /^http:\/\/127\.0\.0\.1:\d+\/oauth\/callback$/);
  const callbackUrl = new URL(authorize.searchParams.get("redirect_uri")!);
  callbackUrl.search = `state=${authorize.searchParams.get("state")}&code=idc-code`;
  assert.equal((await fetch(callbackUrl)).status, 200);
  await waitFor(start.body.id, "complete");
  assert.ok(calls.some((c) => c.path === "/codewhisperer/ListAvailableProfiles"));
  const created = await api(`/api/logins/${start.body.id}/account`, { method: "POST", body: "{}" });
  const credentials = JSON.parse(context.accounts.get(created.body.id)!.credentials);
  assert.equal(credentials.provider, "Enterprise");
  assert.equal(credentials.runtimeRegion, "eu-central-1");
  assert.equal(credentials.profileArn, "arn:aws:codewhisperer:eu-central-1:123456789012:profile/ABC");
});

test("redirect-based sign-ins refuse non-loopback dashboards", async (t) => {
  const { api } = await createHarness(t);
  const kiro = await api("/api/logins/kiro", { method: "POST", body: JSON.stringify({ origin: "http://192.168.1.20:48763" }) });
  assert.equal(kiro.status, 400);
  assert.match(kiro.body.error, /localhost or 127\.0\.0\.1/);
  const idc = await api("/api/logins/identity-center", { method: "POST", body: JSON.stringify({ origin: "https://kiro.example.com", region: "us-east-1", startUrl: "https://d-1.awsapps.com/start" }) });
  assert.equal(idc.status, 400);
  const badRegion = await api("/api/logins/builder-id", { method: "POST", body: JSON.stringify({ region: "nowhere" }) });
  assert.equal(badRegion.status, 400);
});

test("manual form creates refresh-token and API-key accounts, rejects duplicates", async (t) => {
  const { api, context } = await createHarness(t);
  const social = await api("/api/accounts/create", {
    method: "POST",
    body: JSON.stringify({ credentials: { refreshToken: "manual-refresh", provider: "Github", authMethod: "social", region: "us-east-1" }, priority: 2 }),
  });
  assert.equal(social.status, 201, JSON.stringify(social.body));
  const stored = context.accounts.get(social.body.id)!;
  assert.equal(JSON.parse(stored.credentials).accessToken, "refreshed-manual-refresh");
  assert.equal(stored.priority, 2);
  assert.equal(stored.source, "Added manually");

  const key = await api("/api/accounts/create", {
    method: "POST",
    body: JSON.stringify({ credentials: { accessToken: "ksk_manual_key", authMethod: "api_key", region: "eu-central-1" } }),
  });
  assert.equal(key.status, 201);

  const dup = await api("/api/accounts/create", {
    method: "POST",
    body: JSON.stringify({ credentials: { refreshToken: "manual-refresh", provider: "Github", authMethod: "social" } }),
  });
  assert.equal(dup.status, 400);
  assert.match(dup.body.error, /already in the pool/);

  const empty = await api("/api/accounts/create", { method: "POST", body: JSON.stringify({ credentials: { provider: "Google" } }) });
  assert.equal(empty.status, 400);
});

test("account detail exposes a credential summary with masked hints", async (t) => {
  const { api } = await createHarness(t);
  const created = await api("/api/accounts/create", {
    method: "POST",
    body: JSON.stringify({ credentials: { refreshToken: "summary-refresh-9xyz", provider: "Google", authMethod: "social" } }),
  });
  const detail = await api(`/api/accounts/${created.body.id}`);
  const summary = detail.body.credentialSummary;
  assert.equal(summary.signIn, "Google");
  assert.equal(summary.hasRefreshToken, true);
  assert.equal(summary.refreshTokenHint, "…9xyz");
  assert.ok(summary.expiresAt);
});

test("sign-in results are stored as issued, without an extra refresh", async (t) => {
  const { api, calls, waitFor, context } = await createHarness(t);
  const start = await api("/api/logins/builder-id", { method: "POST", body: JSON.stringify({ region: "us-east-1" }) });
  await waitFor(start.body.id, "complete");
  const refreshesBefore = calls.filter((c) => c.body?.grantType === "refresh_token").length;
  const created = await api(`/api/logins/${start.body.id}/account`, { method: "POST", body: "{}" });
  assert.equal(created.status, 201);
  assert.equal(calls.filter((c) => c.body?.grantType === "refresh_token").length, refreshesBefore, "no refresh at account creation");
  const stored = JSON.parse(context.accounts.get(created.body.id)!.credentials);
  assert.equal(stored.accessToken, "builder-access", "the token AWS issued at sign-in is kept");
});

test("external IdP without a refresh token can still be added", async (t) => {
  const { api, baseUrl, fakeUrl, waitFor, context } = await createHarness(t);
  const start = await api("/api/logins/kiro", { method: "POST", body: JSON.stringify({ origin: baseUrl }) });
  const state = new URL(start.body.verificationUrl).searchParams.get("state")!;
  const first = await fetch(`${baseUrl}/oauth/callback?state=${state}&login_option=external_idp&issuer_url=${encodeURIComponent(`${fakeUrl}/idp`)}&client_id=c&scopes=openid`, { redirect: "manual" });
  const authorize = new URL(first.headers.get("location")!);
  await fetch(`${baseUrl}/oauth/callback?state=${authorize.searchParams.get("state")}&code=no-refresh`);
  await waitFor(start.body.id, "complete");
  const created = await api(`/api/logins/${start.body.id}/account`, { method: "POST", body: "{}" });
  assert.equal(created.status, 201, JSON.stringify(created.body));
  const stored = JSON.parse(context.accounts.get(created.body.id)!.credentials);
  assert.equal(stored.accessToken, "idp-access");
  assert.equal(stored.refreshToken, "");
});

test("Identity Center keeps the typed start URL and always returns to 127.0.0.1", async (t) => {
  const { api, baseUrl, calls } = await createHarness(t);
  const port = new URL(baseUrl).port;
  for (const origin of [`http://localhost:${port}`, `http://LOCALHOST:${port}/`, `http://[::1]:${port}`]) {
    const start = await api("/api/logins/identity-center", {
      method: "POST",
      body: JSON.stringify({ origin, region: "us-east-1", startUrl: "  https://d-9999999999.awsapps.com/start/  " }),
    });
    assert.equal(start.status, 201, origin + " " + JSON.stringify(start.body));
    assert.equal(new URL(start.body.verificationUrl).searchParams.get("redirect_uri"), `http://127.0.0.1:${port}/oauth/callback`, origin);
    await api(`/api/logins/${start.body.id}`, { method: "DELETE" });
  }
  const registration = calls.filter((c) => c.path === "/oidc/client/register").at(-1)!;
  assert.equal(registration.body.issuerUrl, "https://d-9999999999.awsapps.com/start/", "trailing slash kept, like login-zh.js");
  assert.deepEqual(registration.body.redirectUris, ["http://127.0.0.1/oauth/callback"]);
});

test("Kiro portal sign-in URL matches the script's shape", async (t) => {
  const { api, baseUrl } = await createHarness(t);
  const port = new URL(baseUrl).port;
  const start = await api("/api/logins/kiro", { method: "POST", body: JSON.stringify({ origin: `http://LOCALHOST:${port}/dashboard/` }) });
  const url = new URL(start.body.verificationUrl);
  assert.deepEqual([...url.searchParams.keys()], ["redirect_from", "state", "code_challenge", "code_challenge_method", "redirect_uri"]);
  assert.equal(url.searchParams.get("redirect_uri"), `http://localhost:${port}`);
});

test("callback edge cases: case-sensitive login_option, errors without state, '?' in values", async (t) => {
  const { api, baseUrl, fakeUrl, waitFor } = await createHarness(t);
  // login_option is matched exactly, like the script.
  let start = await api("/api/logins/kiro", { method: "POST", body: JSON.stringify({ origin: baseUrl }) });
  let state = new URL(start.body.verificationUrl).searchParams.get("state")!;
  assert.equal((await fetch(`${baseUrl}/oauth/callback?state=${state}&code=x&login_option=Google`)).status, 400);
  assert.equal((await waitFor(start.body.id, "failed")).status, "failed");

  // An error with no state fails the one pending redirect sign-in instead of hanging.
  start = await api("/api/logins/kiro", { method: "POST", body: JSON.stringify({ origin: baseUrl }) });
  const errorPage = await fetch(`${baseUrl}/oauth/callback?error=access_denied&error_description=User%20cancelled`);
  assert.equal(errorPage.status, 400);
  assert.match(await errorPage.text(), /User cancelled/);
  assert.match((await waitFor(start.body.id, "failed")).error, /User cancelled/);

  // A literal "?" inside issuer_url no longer truncates the query.
  start = await api("/api/logins/kiro", { method: "POST", body: JSON.stringify({ origin: baseUrl }) });
  state = new URL(start.body.verificationUrl).searchParams.get("state")!;
  // The old split("?") parse cut the query here, losing client_id/scopes and
  // failing with "missing issuer_url, client_id or scopes".
  const page = await fetch(`${baseUrl}/oauth/callback?state=${state}&login_option=external_idp&client_id=c&scopes=openid&issuer_url=${fakeUrl}/idp?x`, { redirect: "manual" });
  const text = await page.text();
  assert.doesNotMatch(text, /missing issuer_url, client_id or scopes/);
  assert.match(text, /discovery failed/i, "the full issuer_url (with ?x) was used for discovery");
});

test("refresh failures report the upstream reason", async (t) => {
  const { context } = await createHarness(t);
  const account = context.accounts.create({
    credentials: { accessToken: "a", refreshToken: "revoked", clientId: "c", clientSecret: "s", authMethod: "IdC", provider: "BuilderId", region: "us-east-1", expiresAt: new Date(0).toISOString() },
  });
  await assert.rejects(() => context.tokens.refreshAccount(account.id), /invalid_grant.*Invalid refresh token provided.*sign in again/);
});
