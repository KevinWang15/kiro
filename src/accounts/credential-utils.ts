export const firstNonEmptyString = (
  ...values: unknown[]
): string | undefined => {
  for (const value of values) {
    if (typeof value === "string" && value.trim()) return value;
  }
  return undefined;
};

export function parseJwtPayload(
  token?: string,
): Record<string, unknown> | null {
  if (!token) return null;
  const parts = token.split(".");
  if (parts.length < 2) return null;
  try {
    const payload = Buffer.from(
      parts[1].replace(/-/g, "+").replace(/_/g, "/"),
      "base64",
    ).toString("utf8");
    const parsed = JSON.parse(payload);
    return parsed && typeof parsed === "object" && !Array.isArray(parsed)
      ? parsed
      : null;
  } catch {
    return null;
  }
}

export function inferMicrosoftTokenEndpoint(
  issuerUrl?: string,
): string | undefined {
  const issuer = issuerUrl?.trim().replace(/\/+$/, "");
  if (!issuer) return undefined;
  try {
    const url = new URL(issuer);
    if (url.hostname.toLowerCase() !== "login.microsoftonline.com")
      return undefined;
    const tenantMatch = url.pathname.match(/^\/([^/]+)\/v2\.0$/);
    return tenantMatch
      ? `${url.origin}/${tenantMatch[1]}/oauth2/v2.0/token`
      : undefined;
  } catch {
    return undefined;
  }
}

export function inferMicrosoftScopes(
  jwtPayload: Record<string, unknown> | null,
  clientId?: string,
): string | undefined {
  const rawScopes = firstNonEmptyString(jwtPayload?.scp);
  if (!rawScopes) return undefined;
  const scopes = rawScopes.split(/\s+/).filter(Boolean);
  if (!scopes.length) return undefined;
  const audience = firstNonEmptyString(jwtPayload?.aud);
  const resource =
    audience && audience === clientId
      ? `api://${audience}`
      : audience && /^[a-z][a-z0-9+.-]*:\/\//i.test(audience)
        ? audience.replace(/\/+$/, "")
        : undefined;
  const normalizedScopes = scopes.map((scope) =>
    /^[a-z][a-z0-9+.-]*:\/\//i.test(scope) || !resource
      ? scope
      : `${resource}/${scope}`,
  );
  if (!normalizedScopes.includes("offline_access"))
    normalizedScopes.push("offline_access");
  return normalizedScopes.join(" ");
}

export function isSocialLoginAccount(credentials: {
  provider?: string;
}): boolean {
  return credentials.provider === "Google" || credentials.provider === "Github";
}

export function isExternalIdpAccount(credentials: {
  authMethod?: string;
  provider?: string;
}): boolean {
  return (
    credentials.authMethod === "external_idp" ||
    credentials.provider === "ExternalIdp"
  );
}
