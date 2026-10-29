// Interactive Kiro sign-in flows, ported from sharegpt/scripts/kiro-login:
//   - AWS Builder ID          device code       (login-builderid.js)
//   - IAM Identity Center     auth code + PKCE  (login-zh.js)
//   - Kiro portal (Google, GitHub, external IdP) (login-external-idp.js)
//
// Each sign-in is a short-lived session held in memory. Browser redirects land
// on the adapter's own /oauth/callback (loopback only, as Kiro and AWS require),
// so no extra ports are opened. Finished sessions hold canonical credentials
// until the UI turns them into an account.
import axios from "axios";
import crypto from "node:crypto";
import { config } from "../config.ts";
import { buildAgentFromProxy } from "../proxy.ts";
import type { KiroCredentials, ProxyRecord } from "./types.ts";

export const KIRO_SCOPES = [
  "codewhisperer:completions",
  "codewhisperer:analysis",
  "codewhisperer:conversations",
  "codewhisperer:transformations",
  "codewhisperer:taskassist",
];
export const BUILDER_ID_START_URL = "https://view.awsapps.com/start";
export const KIRO_SIGNIN_URL = "https://app.kiro.dev/signin";
export const CALLBACK_PATH = "/oauth/callback";
/** Paths Kiro's sign-in portal may return to under the redirect origin. */
export const PORTAL_CALLBACK_PATHS = ["/", "/oauth/callback", "/signin/callback"];
const KIRO_VERSION = "0.9.2";
const SESSION_TTL_MS = 15 * 60 * 1000;
const REGION_PATTERN = /^[a-z]{2}(-[a-z]+)+-\d+$/;

export type LoginMethod = "builder_id" | "identity_center" | "kiro_portal";
export type LoginStatus = "pending" | "complete" | "failed" | "cancelled";

export interface LoginSession {
  id: string;
  method: LoginMethod;
  status: LoginStatus;
  createdAt: number;
  expiresAt: number;
  error?: string;
  /** What the user must do next; shown by the UI. */
  verificationUrl?: string;
  userCode?: string;
  /** Result, only while complete and not yet consumed. */
  credentials?: KiroCredentials;
  label?: string;
}

interface InternalSession extends LoginSession {
  state: string;
  codeVerifier?: string;
  redirectUri?: string;
  region: string;
  proxy: ProxyRecord | null;
  // Builder ID
  clientId?: string;
  clientSecret?: string;
  deviceCode?: string;
  pollIntervalMs?: number;
  pollTimer?: NodeJS.Timeout;
  // Identity Center
  startUrl?: string;
  // External IdP second leg
  external?: {
    state: string;
    codeVerifier: string;
    redirectUri: string;
    tokenEndpoint: string;
    issuerUrl: string;
    clientId: string;
    scopes: string;
    audience?: string;
  };
}

// Endpoint builders. KIRO_AUTH_BASE_URL (config.authBaseUrl) redirects every
// auth host to one base, which the tests use to stand in for AWS and Kiro.
const oidcBase = (region: string) =>
  config.authBaseUrl ? `${config.authBaseUrl}/oidc` : `https://oidc.${region}.amazonaws.com`;
const kiroAuthBase = (region: string) =>
  config.authBaseUrl || `https://prod.${region}.auth.desktop.kiro.dev`;
const profilesBase = (region: string) =>
  config.authBaseUrl ? `${config.authBaseUrl}/codewhisperer` : `https://codewhisperer.${region}.amazonaws.com`;

function pkce(verifierBytes = 64) {
  const codeVerifier = crypto.randomBytes(verifierBytes).toString("base64url").slice(0, 128);
  const codeChallenge = crypto.createHash("sha256").update(codeVerifier).digest("base64url");
  return { codeVerifier, codeChallenge };
}
const randomState = () => crypto.randomBytes(32).toString("base64url");
const expiresAtFrom = (seconds: unknown) =>
  new Date(Date.now() + (Number(seconds) > 0 ? Number(seconds) : 3600) * 1000).toISOString();

export function assertRegion(region: string): string {
  const value = region.trim();
  if (!REGION_PATTERN.test(value)) throw new Error(`Invalid AWS region: ${region || "(empty)"}`);
  return value;
}

/** Loopback check: AWS and Kiro only accept http://localhost / 127.0.0.1 redirects. */
export function isLoopbackOrigin(origin: string): boolean {
  try {
    const url = new URL(origin);
    return url.protocol === "http:" && ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname);
  } catch {
    return false;
  }
}

/** "http://LOCALHOST:3000/x/" -> "http://localhost:3000" (URL lowercases the host). */
function normalizeOrigin(origin: string): URL {
  const url = new URL(origin);
  return new URL(`${url.protocol}//${url.host}`);
}

async function post(url: string, body: unknown, proxy: ProxyRecord | null, form = false, headers: Record<string, string> = {}) {
  const httpsAgent = buildAgentFromProxy(proxy || undefined);
  return axios.post(url, form ? new URLSearchParams(body as Record<string, string>).toString() : body, {
    headers: {
      "Content-Type": form ? "application/x-www-form-urlencoded" : "application/json",
      Accept: "application/json",
      ...headers,
    },
    httpsAgent,
    ...(httpsAgent ? { proxy: false as const } : {}),
    timeout: 30_000,
    validateStatus: () => true,
  });
}

async function get(url: string, proxy: ProxyRecord | null) {
  const httpsAgent = buildAgentFromProxy(proxy || undefined);
  return axios.get(url, {
    headers: { Accept: "application/json" },
    httpsAgent,
    ...(httpsAgent ? { proxy: false as const } : {}),
    timeout: 30_000,
    validateStatus: () => true,
  });
}

function upstreamError(prefix: string, response: { status: number; data: any }): Error {
  const data = response.data;
  const detail =
    (typeof data === "object" && (data?.error_description || data?.message || data?.error)) ||
    (typeof data === "string" ? data.slice(0, 200) : "");
  return new Error(`${prefix} (HTTP ${response.status})${detail ? `: ${detail}` : ""}`);
}

/** Find the CodeWhisperer profile for IdC tokens; its ARN fixes the runtime region. */
async function resolveProfile(accessToken: string, refreshToken: string, authRegion: string, proxy: ProxyRecord | null) {
  const fallback = authRegion.startsWith("eu-") ? "eu-central-1" : "us-east-1";
  const machineId = crypto.createHash("sha256").update(`KotlinNativeAPI/${refreshToken}`).digest("hex");
  const suffix = `KiroIDE-${KIRO_VERSION}-${machineId}`;
  for (const region of [...new Set([fallback, "us-east-1", "eu-central-1"])]) {
    try {
      const response = await post(`${profilesBase(region)}/ListAvailableProfiles`, {}, proxy, false, {
        Authorization: `Bearer ${accessToken}`,
        "x-amz-user-agent": `aws-sdk-js/1.0.27 ${suffix}`,
        "user-agent": `aws-sdk-js/1.0.27 ua/2.1 os/${process.platform} lang/js md/nodejs#${process.version.slice(1)} api/codewhispererstreaming#1.0.27 m/E ${suffix}`,
        "amz-sdk-invocation-id": crypto.randomUUID(),
        "amz-sdk-request": "attempt=1; max=1",
      });
      if (response.status < 200 || response.status >= 300) continue;
      const arn = (response.data?.profiles || []).find((p: any) => typeof p?.arn === "string" && p.arn)?.arn;
      const arnRegion = typeof arn === "string" ? arn.match(/^arn:[^:]+:codewhisperer:([^:]+):/)?.[1] : undefined;
      if (arn && arnRegion) return { profileArn: arn as string, runtimeRegion: arnRegion };
    } catch {
      // Try the next known runtime region.
    }
  }
  return { profileArn: "", runtimeRegion: fallback };
}

export class LoginFlowService {
  private readonly sessions = new Map<string, InternalSession>();
  private readonly sweep: NodeJS.Timeout;

  constructor() {
    this.sweep = setInterval(() => this.expire(), 60_000);
    this.sweep.unref();
  }

  close(): void {
    clearInterval(this.sweep);
    for (const session of this.sessions.values()) clearTimeout(session.pollTimer);
    this.sessions.clear();
  }

  private create(method: LoginMethod, region: string, proxy: ProxyRecord | null): InternalSession {
    const now = Date.now();
    const session: InternalSession = {
      id: crypto.randomUUID(),
      method,
      status: "pending",
      createdAt: now,
      expiresAt: now + SESSION_TTL_MS,
      state: randomState(),
      region,
      proxy,
    };
    this.sessions.set(session.id, session);
    return session;
  }

  private expire(): void {
    const now = Date.now();
    for (const [id, session] of this.sessions) {
      if (session.expiresAt > now) continue;
      clearTimeout(session.pollTimer);
      if (session.status === "pending") {
        session.status = "failed";
        session.error = "Sign-in timed out. Start again.";
      }
      // Keep a finished session briefly so the UI can read the outcome.
      if (session.expiresAt + 60_000 < now) this.sessions.delete(id);
    }
  }

  private fail(session: InternalSession, error: unknown): void {
    clearTimeout(session.pollTimer);
    if (session.status !== "pending") return;
    session.status = "failed";
    session.error = error instanceof Error ? error.message : String(error);
  }

  private complete(session: InternalSession, credentials: KiroCredentials, label: string): void {
    clearTimeout(session.pollTimer);
    if (session.status !== "pending") return;
    session.status = "complete";
    session.credentials = credentials;
    session.label = label;
  }

  /** Public view: never exposes tokens, verifiers or client secrets. */
  view(id: string): LoginSession | null {
    const s = this.sessions.get(id);
    if (!s) return null;
    return {
      id: s.id,
      method: s.method,
      status: s.status,
      createdAt: s.createdAt,
      expiresAt: s.expiresAt,
      error: s.error,
      verificationUrl: s.verificationUrl,
      userCode: s.userCode,
      label: s.label,
    };
  }

  /** Hand the finished credentials to the caller exactly once. */
  take(id: string): KiroCredentials | null {
    const s = this.sessions.get(id);
    if (!s || s.status !== "complete" || !s.credentials) return null;
    const credentials = s.credentials;
    s.credentials = undefined;
    this.sessions.delete(id);
    return credentials;
  }

  cancel(id: string): boolean {
    const s = this.sessions.get(id);
    if (!s) return false;
    clearTimeout(s.pollTimer);
    if (s.status === "pending") s.status = "cancelled";
    s.credentials = undefined;
    this.sessions.delete(id);
    return true;
  }

  // ---------------------------------------------------------------- Builder ID
  async startBuilderId(regionInput: string, proxy: ProxyRecord | null): Promise<LoginSession> {
    const region = assertRegion(regionInput || "us-east-1");
    const session = this.create("builder_id", region, proxy);
    try {
      const registration = await post(`${oidcBase(region)}/client/register`, {
        clientName: "Kiro-BuilderID-Adapter",
        clientType: "public",
        scopes: KIRO_SCOPES,
        grantTypes: ["urn:ietf:params:oauth:grant-type:device_code", "refresh_token"],
        issuerUrl: BUILDER_ID_START_URL,
      }, proxy);
      if (registration.status !== 200 || !registration.data?.clientId)
        throw upstreamError("Builder ID client registration failed", registration);
      session.clientId = registration.data.clientId;
      session.clientSecret = registration.data.clientSecret;

      const device = await post(`${oidcBase(region)}/device_authorization`, {
        clientId: session.clientId,
        clientSecret: session.clientSecret,
        startUrl: BUILDER_ID_START_URL,
      }, proxy);
      if (device.status !== 200 || !device.data?.deviceCode)
        throw upstreamError("Builder ID device authorization failed", device);
      session.deviceCode = device.data.deviceCode;
      session.userCode = device.data.userCode;
      session.verificationUrl = device.data.verificationUriComplete || device.data.verificationUri;
      session.pollIntervalMs = Math.max(1, Number(device.data.interval) || 5) * 1000;
      const deviceTtl = Math.max(60, Number(device.data.expiresIn) || 600) * 1000;
      session.expiresAt = Math.min(session.expiresAt, Date.now() + deviceTtl);
      this.schedulePoll(session);
    } catch (error) {
      this.fail(session, error);
    }
    return this.view(session.id)!;
  }

  private schedulePoll(session: InternalSession): void {
    session.pollTimer = setTimeout(() => void this.pollBuilderId(session), session.pollIntervalMs);
    session.pollTimer.unref();
  }

  private async pollBuilderId(session: InternalSession): Promise<void> {
    if (session.status !== "pending") return;
    if (Date.now() >= session.expiresAt) return this.fail(session, new Error("The sign-in code expired. Start again."));
    try {
      const response = await post(`${oidcBase(session.region)}/token`, {
        clientId: session.clientId,
        clientSecret: session.clientSecret,
        grantType: "urn:ietf:params:oauth:grant-type:device_code",
        deviceCode: session.deviceCode,
      }, session.proxy);
      if (response.status === 200 && response.data?.accessToken) {
        return this.complete(session, {
          accessToken: response.data.accessToken,
          refreshToken: response.data.refreshToken,
          expiresAt: expiresAtFrom(response.data.expiresIn),
          clientId: session.clientId,
          clientSecret: session.clientSecret,
          startUrl: BUILDER_ID_START_URL,
          authMethod: "IdC",
          provider: "BuilderId",
          region: session.region,
          runtimeRegion: "us-east-1",
        }, "AWS Builder ID");
      }
      const code = response.data?.error;
      if (code === "authorization_pending") return this.schedulePoll(session);
      if (code === "slow_down") {
        // RFC 8628: keep the larger interval for the rest of the flow.
        session.pollIntervalMs = (session.pollIntervalMs || 5000) + 5000;
        return this.schedulePoll(session);
      }
      if (code === "access_denied") return this.fail(session, new Error("Sign-in was denied in the browser."));
      if (code === "expired_token") return this.fail(session, new Error("The sign-in code expired. Start again."));
      return this.fail(session, upstreamError("Builder ID token request failed", response));
    } catch (error) {
      // Transient network error: keep polling until the code expires.
      this.schedulePoll(session);
      session.error = error instanceof Error ? error.message : String(error);
    }
  }

  // ------------------------------------------------------- IAM Identity Center
  async startIdentityCenter(regionInput: string, startUrlInput: string, origin: string, proxy: ProxyRecord | null): Promise<LoginSession> {
    const region = assertRegion(regionInput);
    const startUrl = startUrlInput.trim();
    if (!startUrl.startsWith("https://"))
      throw new Error("Enter your organization's start URL, starting with https:// (e.g. https://d-1234567890.awsapps.com/start)");
    try {
      new URL(startUrl);
    } catch {
      throw new Error("The start URL isn't a valid address.");
    }
    if (!isLoopbackOrigin(origin))
      throw new Error("IAM Identity Center sign-in needs the dashboard opened on localhost or 127.0.0.1.");
    const callbackOrigin = normalizeOrigin(origin);
    const session = this.create("identity_center", region, proxy);
    session.startUrl = startUrl;
    // The client is registered for http://127.0.0.1/oauth/callback; AWS lets
    // the port vary, but the host must stay 127.0.0.1 (login-zh.js).
    session.redirectUri = `http://127.0.0.1:${callbackOrigin.port || "80"}${CALLBACK_PATH}`;
    try {
      const registration = await post(`${oidcBase(region)}/client/register`, {
        clientName: "Kiro-IdC-Adapter",
        clientType: "public",
        scopes: KIRO_SCOPES,
        grantTypes: ["authorization_code", "refresh_token"],
        redirectUris: [`http://127.0.0.1${CALLBACK_PATH}`],
        issuerUrl: session.startUrl,
      }, proxy);
      if (registration.status !== 200 || !registration.data?.clientId) {
        const message = String(registration.data?.message || "");
        if (/UnauthorizedException|access denied/i.test(message))
          throw new Error("Your organization doesn't appear to have Kiro / Amazon Q Developer access. Ask your administrator.");
        throw upstreamError("Identity Center client registration failed", registration);
      }
      session.clientId = registration.data.clientId;
      session.clientSecret = registration.data.clientSecret;
      const { codeVerifier, codeChallenge } = pkce(32);
      session.codeVerifier = codeVerifier;
      const authorize = new URL(`${oidcBase(region)}/authorize`);
      authorize.search = new URLSearchParams({
        response_type: "code",
        client_id: session.clientId!,
        redirect_uri: session.redirectUri,
        scopes: KIRO_SCOPES.join(","),
        state: session.state,
        code_challenge: codeChallenge,
        code_challenge_method: "S256",
      }).toString();
      session.verificationUrl = authorize.toString();
    } catch (error) {
      this.fail(session, error);
    }
    return this.view(session.id)!;
  }

  // ------------------------------------------------- Kiro portal (social/IdP)
  startKiroPortal(regionInput: string, origin: string, proxy: ProxyRecord | null): LoginSession {
    const region = assertRegion(regionInput || "us-east-1");
    if (!isLoopbackOrigin(origin))
      throw new Error("Kiro sign-in needs the dashboard opened on localhost or 127.0.0.1.");
    const session = this.create("kiro_portal", region, proxy);
    // Bare origin, like the script; the portal appends its own callback path.
    session.redirectUri = normalizeOrigin(origin).toString().replace(/\/$/, "");
    const { codeVerifier, codeChallenge } = pkce();
    session.codeVerifier = codeVerifier;
    const signin = new URL(KIRO_SIGNIN_URL);
    signin.search = new URLSearchParams({
      redirect_from: "KiroIDE",
      state: session.state,
      code_challenge: codeChallenge,
      code_challenge_method: "S256",
      redirect_uri: session.redirectUri,
    }).toString();
    session.verificationUrl = signin.toString();
    return this.view(session.id)!;
  }

  // ------------------------------------------------------------- Callback
  /**
   * Handle a browser redirect to /oauth/callback. Returns either a page to
   * show, or a URL to redirect to (external IdP second leg).
   */
  async handleCallback(params: URLSearchParams, pathname = CALLBACK_PATH): Promise<{ redirect?: string; ok: boolean; message: string }> {
    const value = (key: string) => params.get(key)?.trim() || undefined;
    const state = value("state");
    const error = value("error");
    const session = state
      ? [...this.sessions.values()].find(
          (s) => s.status === "pending" && (s.state === state || s.external?.state === state),
        )
      : undefined;
    if (error) {
      const message = `Sign-in failed: ${value("error_description") || error}`;
      // An error may arrive without state; then fail the only pending
      // redirect sign-in, if there is exactly one, so the UI isn't left waiting.
      const target =
        session ||
        (() => {
          const pending = [...this.sessions.values()].filter((s) => s.status === "pending" && s.method !== "builder_id");
          return pending.length === 1 ? pending[0] : undefined;
        })();
      if (target) this.fail(target, new Error(message));
      return { ok: false, message };
    }
    if (!state) return { ok: false, message: "The sign-in response is missing its state. Start again from the dashboard." };
    if (!session) return { ok: false, message: "This sign-in link has expired or was already used. Start again from the dashboard." };
    const code = value("code");
    try {
      if (session.external && state === session.external.state) {
        if (!code) throw new Error("The identity provider returned no authorization code.");
        await this.finishExternalIdp(session, code);
      } else if (session.method === "identity_center") {
        if (!code) throw new Error("AWS returned no authorization code.");
        await this.finishIdentityCenter(session, code);
      } else {
        // Exact, case-sensitive match like the script; the raw value is echoed
        // back in the token exchange redirect_uri, so it must not be altered.
        const loginOption = value("login_option") || "";
        if (loginOption === "google" || loginOption === "github") {
          if (!code) throw new Error(`${loginOption} sign-in returned no authorization code.`);
          await this.finishSocial(session, code, loginOption, pathname);
        } else if (loginOption === "external_idp") {
          const redirect = await this.beginExternalIdp(session, params);
          return { ok: true, redirect, message: "Redirecting to your identity provider…" };
        } else if (["builderid", "awsidc", "internal"].includes(loginOption)) {
          throw new Error("That option uses AWS sign-in. Choose “AWS Builder ID” or “IAM Identity Center” in the dashboard instead.");
        } else {
          throw new Error(`Unsupported sign-in option: ${loginOption || "(none)"}`);
        }
      }
    } catch (err) {
      this.fail(session, err);
      return { ok: false, message: session.error! };
    }
    return { ok: true, message: "Signed in. You can close this tab and return to the dashboard." };
  }

  private async finishIdentityCenter(session: InternalSession, code: string): Promise<void> {
    const response = await post(`${oidcBase(session.region)}/token`, {
      clientId: session.clientId,
      clientSecret: session.clientSecret,
      grantType: "authorization_code",
      redirectUri: session.redirectUri,
      code,
      codeVerifier: session.codeVerifier,
    }, session.proxy);
    if (response.status !== 200 || !response.data?.accessToken)
      throw upstreamError("Identity Center token exchange failed", response);
    const { accessToken, refreshToken, expiresIn } = response.data;
    const profile = await resolveProfile(accessToken, refreshToken || "", session.region, session.proxy);
    this.complete(session, {
      accessToken,
      refreshToken,
      expiresAt: expiresAtFrom(expiresIn),
      clientId: session.clientId,
      clientSecret: session.clientSecret,
      clientIdHash: crypto.createHash("sha1").update(JSON.stringify({ startUrl: session.startUrl })).digest("hex"),
      startUrl: session.startUrl,
      authMethod: "IdC",
      provider: "Enterprise",
      region: session.region,
      runtimeRegion: profile.runtimeRegion,
      ...(profile.profileArn ? { profileArn: profile.profileArn } : {}),
    }, "IAM Identity Center");
  }

  private async finishSocial(session: InternalSession, code: string, loginOption: "google" | "github", pathname: string): Promise<void> {
    // Kiro checks this against the URL it redirected to: origin + the path it
    // used + login_option (login-external-idp.js builds it the same way).
    const response = await post(`${kiroAuthBase(session.region)}/oauth/token`, {
      code,
      code_verifier: session.codeVerifier,
      redirect_uri: `${session.redirectUri}${pathname}?login_option=${loginOption}`,
    }, session.proxy);
    const data = response.data || {};
    const accessToken = data.accessToken || data.access_token;
    const refreshToken = data.refreshToken || data.refresh_token;
    if (response.status !== 200 || !accessToken || !refreshToken)
      throw upstreamError("Kiro token exchange failed", response);
    const provider = loginOption === "google" ? "Google" : "Github";
    const profileArn = typeof data.profileArn === "string" ? data.profileArn : "";
    this.complete(session, {
      accessToken,
      refreshToken,
      expiresAt: expiresAtFrom(data.expiresIn || data.expires_in),
      authMethod: "social",
      provider,
      region: session.region,
      runtimeRegion: profileArn.match(/^arn:[^:]+:codewhisperer:([^:]+):/)?.[1] || "us-east-1",
      ...(profileArn ? { profileArn } : {}),
    }, provider === "Google" ? "Google" : "GitHub");
  }

  private async beginExternalIdp(session: InternalSession, params: URLSearchParams): Promise<string> {
    const issuerUrl = params.get("issuer_url")?.trim();
    const clientId = params.get("client_id")?.trim();
    const scopes = params.get("scopes")?.trim();
    if (!issuerUrl || !clientId || !scopes)
      throw new Error("Kiro's external sign-in response is missing issuer_url, client_id or scopes.");
    const discovery = await get(`${issuerUrl.replace(/\/$/, "")}/.well-known/openid-configuration`, session.proxy);
    if (discovery.status !== 200 || !discovery.data?.authorization_endpoint || !discovery.data?.token_endpoint)
      throw upstreamError("Identity provider discovery failed", discovery);
    const scopeList = scopes.split(/\s+/).filter(Boolean);
    if (!scopeList.includes("offline_access")) scopeList.push("offline_access");
    const { codeVerifier, codeChallenge } = pkce();
    const audience = params.get("audience")?.trim() || undefined;
    session.external = {
      state: randomState(),
      codeVerifier,
      redirectUri: `${session.redirectUri}${CALLBACK_PATH}`,
      tokenEndpoint: discovery.data.token_endpoint,
      issuerUrl,
      clientId,
      scopes: scopeList.join(" "),
      audience,
    };
    const authorize = new URL(discovery.data.authorization_endpoint);
    authorize.searchParams.set("client_id", clientId);
    authorize.searchParams.set("response_type", "code");
    authorize.searchParams.set("redirect_uri", session.external.redirectUri);
    authorize.searchParams.set("scope", session.external.scopes);
    authorize.searchParams.set("code_challenge", codeChallenge);
    authorize.searchParams.set("code_challenge_method", "S256");
    authorize.searchParams.set("response_mode", "query");
    authorize.searchParams.set("state", session.external.state);
    const loginHint = params.get("login_hint")?.trim();
    if (loginHint) authorize.searchParams.set("login_hint", loginHint);
    if (audience) authorize.searchParams.set("audience", audience);
    return authorize.toString();
  }

  private async finishExternalIdp(session: InternalSession, code: string): Promise<void> {
    const ext = session.external!;
    const response = await post(ext.tokenEndpoint, {
      grant_type: "authorization_code",
      code,
      redirect_uri: ext.redirectUri,
      client_id: ext.clientId,
      code_verifier: ext.codeVerifier,
    }, session.proxy, true);
    const accessToken = response.data?.access_token || response.data?.accessToken;
    if (response.status !== 200 || !accessToken)
      throw upstreamError("Identity provider token exchange failed", response);
    this.complete(session, {
      accessToken,
      refreshToken: response.data.refresh_token || response.data.refreshToken || "",
      expiresAt: expiresAtFrom(response.data.expires_in || response.data.expiresIn),
      authMethod: "external_idp",
      provider: "ExternalIdp",
      tokenEndpoint: ext.tokenEndpoint,
      issuerUrl: ext.issuerUrl,
      clientId: ext.clientId,
      scopes: ext.scopes,
      ...(ext.audience ? { audience: ext.audience } : {}),
      region: session.region,
      runtimeRegion: session.region === "eu-east-1" ? "eu-central-1" : "us-east-1",
    }, "Organization sign-in");
  }
}
