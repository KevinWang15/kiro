import axios from "axios";
import { buildAgentFromProxy } from "../proxy.ts";
import { config } from "../config.ts";
import { getKiroRuntimeRegion } from "../kiro/constants.ts";
import type { AccountRepository } from "./repository.ts";
import type { ProxyRepository } from "./proxies.ts";
import type { AccountRecord, KiroCredentials, ProxyRecord } from "./types.ts";
import { parseCredentials } from "./types.ts";
import {
  firstNonEmptyString,
  inferMicrosoftScopes,
  inferMicrosoftTokenEndpoint,
  parseJwtPayload,
  isExternalIdpAccount,
  isSocialLoginAccount,
} from "./credential-utils.ts";

export interface KiroRefreshedCredentials {
  accessToken: string;
  refreshToken: string;
  expiresAt: string;
  profileArn?: string;
}

export function normalizeKiroExtraConfigAliases(
  credentials: KiroCredentials,
): KiroCredentials {
  const accessToken = firstNonEmptyString(
    credentials.accessToken,
    credentials.access_token,
  );
  const clientId = firstNonEmptyString(
    credentials.clientId,
    credentials.client_id,
  );
  const jwtPayload = parseJwtPayload(accessToken);
  const issuerUrl =
    firstNonEmptyString(
      credentials.issuerUrl,
      credentials.issuer_url,
      jwtPayload?.iss,
    ) || credentials.issuerUrl;
  return {
    ...credentials,
    accessToken: accessToken || credentials.accessToken,
    refreshToken:
      firstNonEmptyString(
        credentials.refreshToken,
        credentials.refresh_token,
      ) || credentials.refreshToken,
    expiresAt:
      firstNonEmptyString(credentials.expiresAt, credentials.expires_at) ||
      credentials.expiresAt,
    clientId: clientId || credentials.clientId,
    clientSecret:
      firstNonEmptyString(
        credentials.clientSecret,
        credentials.client_secret,
      ) || credentials.clientSecret,
    clientIdHash:
      firstNonEmptyString(
        credentials.clientIdHash,
        credentials.client_id_hash,
      ) || credentials.clientIdHash,
    startUrl:
      firstNonEmptyString(credentials.startUrl, credentials.start_url) ||
      credentials.startUrl,
    tokenEndpoint:
      firstNonEmptyString(
        credentials.tokenEndpoint,
        credentials.token_endpoint,
      ) ||
      inferMicrosoftTokenEndpoint(issuerUrl) ||
      credentials.tokenEndpoint,
    issuerUrl,
    scopes:
      firstNonEmptyString(credentials.scopes, credentials.scope) ||
      inferMicrosoftScopes(jwtPayload, clientId) ||
      credentials.scopes,
    audience: firstNonEmptyString(credentials.audience) || credentials.audience,
    authMethod:
      firstNonEmptyString(credentials.authMethod, credentials.auth_method) ||
      credentials.authMethod,
    runtimeRegion:
      firstNonEmptyString(
        credentials.runtimeRegion,
        credentials.runtime_region,
      ) || credentials.runtimeRegion,
    profileArn:
      firstNonEmptyString(credentials.profileArn, credentials.profile_arn) ||
      credentials.profileArn,
    ssoSessionId:
      firstNonEmptyString(
        credentials.ssoSessionId,
        credentials.sso_session_id,
      ) || credentials.ssoSessionId,
    idToken:
      firstNonEmptyString(credentials.idToken, credentials.id_token) ||
      credentials.idToken,
    machineId:
      firstNonEmptyString(credentials.machineId, credentials.machine_id) ||
      credentials.machineId,
    userId:
      firstNonEmptyString(credentials.userId, credentials.user_id) ||
      credentials.userId,
  };
}

export function isApiKeyAccount(credentials: KiroCredentials | null): boolean {
  const authMethod = credentials?.authMethod?.trim().toLowerCase();
  return authMethod === "api_key" || authMethod === "apikey";
}

/** Thrown when an auth server rejects a refresh; carries its own reason. */
export class RefreshRejectedError extends Error {}

function refreshRejected(prefix: string, response: { status: number; data: any }): RefreshRejectedError {
  const data = response.data;
  const code = typeof data === "object" ? data?.error || data?.__type : undefined;
  const detail =
    (typeof data === "object" && (data?.error_description || data?.message)) ||
    (typeof data === "string" ? data.slice(0, 200) : "");
  const hint = /invalid_grant|InvalidGrant/i.test(String(code || detail))
    ? " The refresh token is no longer valid; sign in again to keep this account."
    : "";
  return new RefreshRejectedError(
    `${prefix} (HTTP ${response.status}${code ? `, ${code}` : ""})${detail ? `: ${detail}` : ""}.${hint}`,
  );
}

async function postRefresh(
  url: string,
  data: unknown,
  proxy: ProxyRecord | null,
  form = false,
): Promise<any> {
  const httpsAgent = buildAgentFromProxy(proxy || undefined);
  const response = await axios.post(url, data, {
    headers: form
      ? {
          "Content-Type": "application/x-www-form-urlencoded",
          Accept: "application/json",
        }
      : { "Content-Type": "application/json", Accept: "application/json" },
    httpsAgent,
    ...(httpsAgent ? { proxy: false as const } : {}),
    timeout: 30000,
    validateStatus: () => true,
  });
  return response;
}

async function refreshSocialLoginToken(
  refreshToken: string,
  region: string,
  proxy: ProxyRecord | null,
): Promise<KiroRefreshedCredentials | null> {
  const url = config.authBaseUrl
    ? `${config.authBaseUrl}/refreshToken`
    : `https://prod.${region}.auth.desktop.kiro.dev/refreshToken`;
  const response = await postRefresh(url, { refreshToken }, proxy);
  if (
    response.status !== 200 ||
    typeof response.data?.accessToken !== "string" ||
    !response.data.accessToken.trim()
  )
    throw refreshRejected("Kiro rejected the token refresh", response);
  const {
    accessToken,
    refreshToken: newRefreshToken,
    expiresIn,
    profileArn,
  } = response.data;
  return {
    accessToken,
    refreshToken: newRefreshToken || refreshToken,
    expiresAt: new Date(Date.now() + (expiresIn || 3600) * 1000).toISOString(),
    ...(typeof profileArn === "string" && profileArn.trim()
      ? { profileArn }
      : {}),
  };
}

async function refreshExternalIdpToken(
  credentials: KiroCredentials,
  proxy: ProxyRecord | null,
): Promise<KiroRefreshedCredentials | null> {
  if (
    !credentials.refreshToken ||
    !credentials.clientId ||
    !credentials.tokenEndpoint
  )
    return null;
  const form = new URLSearchParams({
    grant_type: "refresh_token",
    refresh_token: credentials.refreshToken,
    client_id: credentials.clientId,
  });
  if (credentials.clientSecret)
    form.set("client_secret", credentials.clientSecret);
  if (credentials.scopes) form.set("scope", credentials.scopes);
  const response = await postRefresh(
    credentials.tokenEndpoint,
    form.toString(),
    proxy,
    true,
  );
  const accessToken = response.data?.access_token || response.data?.accessToken;
  if (response.status !== 200 || !accessToken)
    throw refreshRejected("The identity provider rejected the token refresh", response);
  const expiresIn = Number(
    response.data?.expires_in || response.data?.expiresIn || 3600,
  );
  return {
    accessToken,
    refreshToken:
      response.data?.refresh_token ||
      response.data?.refreshToken ||
      credentials.refreshToken,
    expiresAt: new Date(Date.now() + expiresIn * 1000).toISOString(),
  };
}

async function refreshKiroToken(
  credentials: KiroCredentials,
  proxy: ProxyRecord | null,
): Promise<KiroRefreshedCredentials | null> {
  if (
    !credentials.refreshToken ||
    !credentials.clientId ||
    !credentials.clientSecret
  )
    return null;
  const region = credentials.region || "us-east-1";
  const url = config.authBaseUrl
    ? `${config.authBaseUrl}/oidc/token`
    : `https://oidc.${region}.amazonaws.com/token`;
  const httpsAgent = buildAgentFromProxy(proxy || undefined);
  const response = await axios.post(
    url,
    {
      clientId: credentials.clientId,
      clientSecret: credentials.clientSecret,
      grantType: "refresh_token",
      refreshToken: credentials.refreshToken,
    },
    {
      // Same as refresh.js: a plain JSON POST with no IDE fingerprint headers.
      headers: { "Content-Type": "application/json" },
      httpsAgent,
      ...(httpsAgent ? { proxy: false as const } : {}),
      timeout: 30000,
      validateStatus: () => true,
    },
  );
  if (
    response.status !== 200 ||
    typeof response.data?.accessToken !== "string" ||
    !response.data.accessToken.trim()
  )
    throw refreshRejected("AWS rejected the token refresh", response);
  const {
    accessToken,
    refreshToken: newRefreshToken,
    expiresIn,
    profileArn,
  } = response.data;
  return {
    accessToken,
    refreshToken: newRefreshToken || credentials.refreshToken,
    expiresAt: new Date(Date.now() + (expiresIn || 3600) * 1000).toISOString(),
    ...(typeof profileArn === "string" && profileArn.trim()
      ? { profileArn }
      : {}),
  };
}

export async function refreshKiroCredentials(
  input: KiroCredentials,
  proxy?: ProxyRecord | null,
): Promise<KiroRefreshedCredentials | null> {
  const credentials = normalizeKiroExtraConfigAliases(input);
  if (!credentials.refreshToken) return null;
  const selectedProxy = proxy ?? null;
  if (isSocialLoginAccount(credentials)) {
    return refreshSocialLoginToken(
      credentials.refreshToken,
      credentials.region || "us-east-1",
      selectedProxy,
    );
  }
  if (isExternalIdpAccount(credentials))
    return refreshExternalIdpToken(credentials, selectedProxy);
  return refreshKiroToken(credentials, selectedProxy);
}

export class TokenManager {
  private readonly locks = new Map<number, Promise<AccountRecord>>();

  constructor(
    private readonly accounts: AccountRepository,
    private readonly proxies: ProxyRepository,
  ) {}

  async convertCredential(
    credentials: KiroCredentials,
    proxy: ProxyRecord | null = null,
  ): Promise<KiroCredentials> {
    const normalized = normalizeKiroExtraConfigAliases(credentials);
    if (isApiKeyAccount(normalized)) {
      if (!normalized.accessToken) throw new Error("Kiro API key is missing");
      return {
        ...normalized,
        region: normalized.region || "us-east-1",
        runtimeRegion: getKiroRuntimeRegion(normalized),
      };
    }
    if (!normalized.refreshToken)
      throw new Error("refreshToken is required for OAuth credentials");
    const refreshed = await refreshKiroCredentials(normalized, proxy);
    if (!refreshed?.accessToken)
      throw new Error("Kiro access-token exchange failed");
    const merged = { ...normalized, ...refreshed };
    return {
      ...merged,
      region: merged.region || "us-east-1",
      runtimeRegion: getKiroRuntimeRegion(merged),
    };
  }

  async ensureAccountToken(account: AccountRecord): Promise<AccountRecord> {
    const credentials = normalizeKiroExtraConfigAliases(
      parseCredentials(account),
    );
    if (isApiKeyAccount(credentials) && account.accessToken) return account;
    const expiresAt = new Date(credentials.expiresAt || "").getTime();
    if (
      account.accessToken &&
      Number.isFinite(expiresAt) &&
      expiresAt > Date.now() + 60_000
    )
      return account;
    if (!credentials.refreshToken) {
      if (account.accessToken) return account;
      throw new Error(
        `Account ${account.id} has no access token or refresh token`,
      );
    }
    return this.refreshAccount(account.id);
  }

  refreshAccount(id: number, force = true): Promise<AccountRecord> {
    const existing = this.locks.get(id);
    if (existing) return existing;
    const task = this.doRefresh(id, force).finally(() => this.locks.delete(id));
    this.locks.set(id, task);
    return task;
  }

  private async doRefresh(id: number, force: boolean): Promise<AccountRecord> {
    const account = this.accounts.get(id);
    if (!account) throw new Error("Account not found");
    const credentials = normalizeKiroExtraConfigAliases(
      parseCredentials(account),
    );
    if (isApiKeyAccount(credentials)) return account;
    if (!credentials.refreshToken)
      throw new Error("Account has no refresh token");
    if (!force && account.accessToken) {
      const expiresAt = new Date(credentials.expiresAt || "").getTime();
      if (
        Number.isFinite(expiresAt) &&
        expiresAt > Date.now() + config.refreshThresholdMs
      )
        return account;
    }
    const proxy = this.proxies.get(account.proxyId);
    const refreshed = await refreshKiroCredentials(credentials, proxy);
    if (!refreshed?.accessToken)
      throw new Error(`Token refresh failed for account ${id}`);
    const merged = {
      ...credentials,
      ...refreshed,
      runtimeRegion: getKiroRuntimeRegion({ ...credentials, ...refreshed }),
    };
    this.accounts.updateCredentials(id, merged);
    return this.accounts.get(id)!;
  }

  async refreshExpiring(): Promise<void> {
    for (const account of this.accounts.list()) {
      const credentials = normalizeKiroExtraConfigAliases(
        parseCredentials(account),
      );
      if (
        !account.enabled ||
        !credentials.refreshToken ||
        !credentials.expiresAt
      )
        continue;
      const expiresAt = new Date(credentials.expiresAt).getTime();
      if (expiresAt > Date.now() + config.refreshThresholdMs) continue;
      try {
        await this.refreshAccount(account.id, false);
      } catch (error) {
        console.warn(`[KIRO_TOKEN_REFRESH] ${(error as Error).message}`);
      }
    }
  }
}
