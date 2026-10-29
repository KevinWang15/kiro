import {
  inferMicrosoftScopes,
  inferMicrosoftTokenEndpoint,
  parseJwtPayload,
} from "./credential-utils.ts";

export interface KiroCanonicalJson {
  accessToken: string;
  refreshToken: string;
  expiresAt: string;
  clientId: string;
  clientSecret: string;
  clientIdHash: string;
  startUrl: string;
  tokenEndpoint: string;
  issuerUrl: string;
  scopes: string;
  audience: string;
  authMethod: string;
  provider: string;
  region: string;
  runtimeRegion: string;
  profileArn: string;
  ssoSessionId: string;
  idToken: string;
  machineId: string;
  email: string;
  userId: string;
}

export interface KiroJsonAccountOption {
  index: number;
  label: string;
  canonical: KiroCanonicalJson;
}

const DEFAULT_REGION = "us-east-1";
const DEFAULT_RUNTIME_REGION = "us-east-1";
const MAX_SCAN_DEPTH = 8;

const CANONICAL_KEYS: Array<keyof KiroCanonicalJson> = [
  "accessToken",
  "refreshToken",
  "expiresAt",
  "clientId",
  "clientSecret",
  "clientIdHash",
  "startUrl",
  "tokenEndpoint",
  "issuerUrl",
  "scopes",
  "audience",
  "authMethod",
  "provider",
  "region",
  "runtimeRegion",
  "profileArn",
  "ssoSessionId",
  "idToken",
  "machineId",
  "email",
  "userId",
];

const objectFrom = (value: unknown): Record<string, any> =>
  value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, any>)
    : {};

const objectFromJson = (value: unknown): Record<string, any> => {
  if (typeof value !== "string") return objectFrom(value);
  try {
    return objectFrom(JSON.parse(value));
  } catch {
    return {};
  }
};

const valueFrom = (...values: unknown[]): any => {
  for (const value of values) {
    if (value !== undefined && value !== null && value !== "") {
      return value;
    }
  }
  return "";
};

const stringFrom = (...values: unknown[]): string => {
  const value = valueFrom(...values);
  return typeof value === "string" ? value.trim() : value ? String(value) : "";
};

const isApiKeyAuthMethod = (value: unknown): boolean => {
  const authMethod = stringFrom(value).toLowerCase();
  return authMethod === "api_key" || authMethod === "apikey";
};

export const normalizeKiroDate = (value: unknown): string => {
  if (value === null || value === undefined || value === "") return "";

  if (typeof value === "number" && Number.isFinite(value)) {
    const timestamp = value < 100000000000 ? value * 1000 : value;
    return new Date(timestamp).toISOString();
  }

  if (typeof value === "string") {
    const trimmed = value.trim();
    if (!trimmed) return "";

    if (/^\d+(?:\.\d+)?$/.test(trimmed)) {
      const numeric = Number(trimmed);
      if (Number.isFinite(numeric)) {
        return normalizeKiroDate(numeric);
      }
    }

    const parsed = new Date(trimmed);
    return Number.isNaN(parsed.getTime()) ? trimmed : parsed.toISOString();
  }

  return "";
};

export const normalizeKiroProvider = (value: unknown): string => {
  if (!value) return "";

  const provider = String(value).trim();
  if (/^github(?:\.com)?$/i.test(provider) || /^git\s*hub$/i.test(provider)) {
    return "Github";
  }
  if (/^google(?:\.com)?$/i.test(provider)) return "Google";
  if (/^builderid$/i.test(provider) || /^builder id$/i.test(provider))
    return "BuilderId";
  if (/^enterprise$/i.test(provider)) return "Enterprise";
  if (/^external[_\s-]?idp$/i.test(provider)) return "ExternalIdp";
  return provider;
};

export const isKiroSocialProvider = (provider: string): boolean =>
  provider === "Github" || provider === "Google";

const isExternalIdpCredential = (
  provider: string,
  authMethod: string,
): boolean => provider === "ExternalIdp" || authMethod === "external_idp";

const inferRuntimeRegion = (
  authRegion: string,
  provider: string,
  authMethod: string,
): string => {
  if (
    isExternalIdpCredential(provider, authMethod) &&
    authRegion === "eu-east-1"
  ) {
    return "eu-central-1";
  }
  return DEFAULT_RUNTIME_REGION;
};

const normalizeExpiry = (
  value: unknown,
  expiresIn: unknown,
  provider: string,
  hasRefreshToken: boolean,
): string => {
  const normalized = normalizeKiroDate(value);
  if (normalized) return normalized;

  const expiresInNumber = Number(expiresIn);
  if (Number.isFinite(expiresInNumber) && expiresInNumber > 0) {
    return new Date(Date.now() + expiresInNumber * 1000).toISOString();
  }

  if (isKiroSocialProvider(provider) && hasRefreshToken) {
    return new Date(Date.now() + 60 * 60 * 1000).toISOString();
  }

  return "";
};

const nestedTokenObject = (
  account: Record<string, any>,
  credentials: Record<string, any>,
) =>
  objectFrom(
    valueFrom(
      credentials.tokens,
      account.tokens,
      account.tokenData,
      account.token_data,
    ),
  );

const nestedUsageUserInfo = (account: Record<string, any>) =>
  objectFrom(objectFrom(account.usageData).userInfo);

export const toKiroCanonicalJson = (input: unknown): KiroCanonicalJson => {
  const account = objectFrom(input);
  const credentials = objectFrom(account.credentials);
  const tokens = nestedTokenObject(account, credentials);
  const usageUserInfo = nestedUsageUserInfo(account);

  const provider = normalizeKiroProvider(
    valueFrom(
      credentials.provider,
      account.provider,
      account.idp,
      account.identityProvider,
    ),
  );
  const refreshToken = String(
    valueFrom(
      credentials.refreshToken,
      credentials.refresh_token,
      tokens.refreshToken,
      tokens.refresh_token,
      account.refreshToken,
      account.refresh_token,
    ),
  );
  const authMethod = String(
    valueFrom(
      credentials.authMethod,
      credentials.auth_method,
      account.authMethod,
      account.auth_method,
    ) || (isKiroSocialProvider(provider) ? "social" : ""),
  );
  const region = String(
    valueFrom(credentials.region, account.region, DEFAULT_REGION),
  );

  const profileArn = stringFrom(
    credentials.profileArn,
    credentials.profile_arn,
    account.profileArn,
    account.profile_arn,
  );
  const profileRegion = profileArn.match(
    /^arn:[^:]+:(?:codewhisperer|q|kiro):([a-z0-9-]+):/,
  )?.[1];

  const canonical: KiroCanonicalJson = {
    accessToken: String(
      valueFrom(
        credentials.accessToken,
        credentials.access_token,
        tokens.accessToken,
        tokens.access_token,
        account.accessToken,
        account.access_token,
      ),
    ),
    refreshToken,
    expiresAt: normalizeExpiry(
      valueFrom(
        credentials.expiresAt,
        credentials.expires_at,
        tokens.expiresAt,
        tokens.expires_at,
        account.expiresAt,
        account.expires_at,
        account.expiration,
        account.expires,
      ),
      valueFrom(
        credentials.expiresIn,
        credentials.expires_in,
        tokens.expiresIn,
        tokens.expires_in,
        account.expiresIn,
        account.expires_in,
      ),
      provider,
      Boolean(refreshToken),
    ),
    clientId: String(
      valueFrom(
        credentials.clientId,
        credentials.client_id,
        account.clientId,
        account.client_id,
      ),
    ),
    clientSecret: String(
      valueFrom(
        credentials.clientSecret,
        credentials.client_secret,
        account.clientSecret,
        account.client_secret,
      ),
    ),
    clientIdHash: String(
      valueFrom(credentials.clientIdHash, account.clientIdHash),
    ),
    startUrl: String(
      valueFrom(
        credentials.startUrl,
        credentials.start_url,
        account.startUrl,
        account.start_url,
      ),
    ),
    tokenEndpoint: String(
      valueFrom(
        credentials.tokenEndpoint,
        credentials.token_endpoint,
        tokens.tokenEndpoint,
        tokens.token_endpoint,
        account.tokenEndpoint,
        account.token_endpoint,
      ),
    ),
    issuerUrl: String(
      valueFrom(
        credentials.issuerUrl,
        credentials.issuer_url,
        account.issuerUrl,
        account.issuer_url,
      ),
    ),
    scopes: String(
      valueFrom(
        credentials.scopes,
        credentials.scope,
        account.scopes,
        account.scope,
        tokens.scopes,
        tokens.scope,
      ),
    ),
    audience: String(valueFrom(credentials.audience, account.audience)),
    authMethod,
    provider,
    region,
    runtimeRegion: String(
      valueFrom(
        credentials.runtimeRegion,
        credentials.runtime_region,
        account.runtimeRegion,
        account.runtime_region,
        profileRegion,
        inferRuntimeRegion(region, provider, authMethod),
      ),
    ),
    profileArn: String(
      valueFrom(
        credentials.profileArn,
        credentials.profile_arn,
        account.profileArn,
        account.profile_arn,
      ),
    ),
    ssoSessionId: String(
      valueFrom(credentials.ssoSessionId, account.ssoSessionId),
    ),
    idToken: String(
      valueFrom(
        credentials.idToken,
        credentials.id_token,
        tokens.idToken,
        tokens.id_token,
        account.idToken,
        account.id_token,
      ),
    ),
    machineId: String(valueFrom(credentials.machineId, account.machineId)),
    email: String(
      valueFrom(account.email, credentials.email, usageUserInfo.email),
    ),
    userId: String(
      valueFrom(account.userId, credentials.userId, usageUserInfo.userId),
    ),
  };

  for (const key of CANONICAL_KEYS) {
    if (canonical[key] === "null" || canonical[key] === "undefined") {
      canonical[key] = "";
    }
  }

  if (isExternalIdpCredential(canonical.provider, canonical.authMethod)) {
    const jwtPayload = parseJwtPayload(canonical.accessToken);
    if (!canonical.issuerUrl) {
      canonical.issuerUrl = stringFrom(jwtPayload?.iss);
    }
    if (!canonical.tokenEndpoint) {
      canonical.tokenEndpoint =
        inferMicrosoftTokenEndpoint(canonical.issuerUrl) || "";
    }
    if (!canonical.scopes) {
      canonical.scopes =
        inferMicrosoftScopes(jwtPayload, canonical.clientId) || "";
    }
  }

  return canonical;
};

export const isKiroAccountLike = (value: unknown): boolean => {
  const account = objectFrom(value);
  const credentials = objectFrom(account.credentials);
  const tokens = nestedTokenObject(account, credentials);

  return Boolean(
    credentials.accessToken ||
    credentials.refreshToken ||
    credentials.access_token ||
    credentials.refresh_token ||
    tokens.accessToken ||
    tokens.refreshToken ||
    tokens.access_token ||
    tokens.refresh_token ||
    account.accessToken ||
    account.refreshToken ||
    account.access_token ||
    account.refresh_token,
  );
};

const pushUniqueAccount = (accounts: unknown[], candidate: unknown) => {
  if (!isKiroAccountLike(candidate)) return;
  if (accounts.includes(candidate)) return;
  accounts.push(candidate);
};

const scanForAccounts = (
  value: unknown,
  accounts: unknown[],
  seen: Set<unknown>,
  depth: number,
): void => {
  if (!value || depth > MAX_SCAN_DEPTH) return;
  if (typeof value !== "object") return;
  if (seen.has(value)) return;
  seen.add(value);

  if (Array.isArray(value)) {
    for (const item of value) {
      if (isKiroAccountLike(item)) {
        pushUniqueAccount(accounts, item);
      } else {
        scanForAccounts(item, accounts, seen, depth + 1);
      }
    }
    return;
  }

  if (isKiroAccountLike(value)) {
    pushUniqueAccount(accounts, value);
    return;
  }

  const object = value as Record<string, unknown>;
  const preferredKeys = [
    "accounts",
    "items",
    "data",
    "account",
    "accountData",
    "account_data",
  ];
  for (const key of preferredKeys) {
    if (key in object) {
      scanForAccounts(object[key], accounts, seen, depth + 1);
    }
  }

  if (accounts.length > 0) return;

  for (const nested of Object.values(object)) {
    scanForAccounts(nested, accounts, seen, depth + 1);
  }
};

export const extractKiroAccounts = (parsed: unknown): unknown[] => {
  const accounts: unknown[] = [];
  scanForAccounts(parsed, accounts, new Set(), 0);
  return accounts;
};

export const getKiroAccountLabel = (
  accountInput: unknown,
  index: number,
): string => {
  const account = objectFrom(accountInput);
  const credentials = objectFrom(account.credentials);
  const usageUserInfo = nestedUsageUserInfo(account);
  const provider = normalizeKiroProvider(
    valueFrom(
      credentials.provider,
      account.provider,
      account.idp,
      account.identityProvider,
    ),
  );
  const email = valueFrom(
    account.email,
    credentials.email,
    usageUserInfo.email,
  );
  const nickname = valueFrom(account.nickname, account.name, account.label);
  const suffix = provider ? ` - ${provider}` : "";
  return `${email || nickname || `Account ${index + 1}`}${suffix}`;
};

const parseKiroApiKeyPayload = (parsed: unknown): KiroCanonicalJson | null => {
  const payload = objectFrom(parsed);
  const extraConfig = objectFromJson(payload.extraConfig);
  const authMethod = valueFrom(
    payload.authMethod,
    payload.auth_method,
    extraConfig.authMethod,
    extraConfig.auth_method,
  );
  const apiKey = stringFrom(
    payload.apiKey,
    payload.kiroApiKey,
    extraConfig.apiKey,
    extraConfig.kiroApiKey,
  );
  if (!isApiKeyAuthMethod(authMethod) || !apiKey) {
    return null;
  }

  const region = stringFrom(payload.region, extraConfig.region, DEFAULT_REGION);
  const runtimeRegion = stringFrom(
    payload.runtimeRegion,
    payload.runtime_region,
    extraConfig.runtimeRegion,
    extraConfig.runtime_region,
    region,
  );
  return toKiroCanonicalJson({
    accessToken: apiKey,
    authMethod: "api_key",
    region,
    runtimeRegion,
  });
};

export const parseKiroJsonText = (text: string): KiroJsonAccountOption[] => {
  const parsed = JSON.parse(text);
  const apiKeyCredential = parseKiroApiKeyPayload(parsed);
  if (apiKeyCredential) {
    return [{ index: 0, label: "Kiro API key", canonical: apiKeyCredential }];
  }

  const accounts = extractKiroAccounts(parsed);
  if (!accounts.length) {
    throw new Error(
      "No accounts found. Expected an accounts array, a wrapped account, or a Kiro login JSON object.",
    );
  }

  return accounts.map((account, index) => ({
    index,
    label: getKiroAccountLabel(account, index),
    canonical: toKiroCanonicalJson(account),
  }));
};
