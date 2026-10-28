import { isExternalIdpAccount } from "../accounts/credential-utils.js";

export const KIRO_RUNTIME_REGION = "us-east-1";

export type KiroRuntimeRegionConfig = {
  runtimeRegion?: string;
  runtime_region?: string;
  region?: string;
  profileArn?: string;
  profile_arn?: string;
  authMethod?: string;
  provider?: string;
};

function isExternalIdpConfig(config?: KiroRuntimeRegionConfig | null): boolean {
  return isExternalIdpAccount(config || {});
}

export function getKiroRuntimeRegion(
  configOrRegion?: KiroRuntimeRegionConfig | string | null,
): string {
  if (typeof configOrRegion === "string")
    return configOrRegion.trim() || KIRO_RUNTIME_REGION;
  const runtimeRegion =
    configOrRegion?.runtimeRegion?.trim() ||
    configOrRegion?.runtime_region?.trim();
  if (runtimeRegion) return runtimeRegion;
  const profileArn = configOrRegion?.profileArn || configOrRegion?.profile_arn;
  const profileRegion = profileArn?.match(
    /^arn:[^:]+:(?:codewhisperer|q|kiro):([a-z0-9-]+):/,
  )?.[1];
  if (profileRegion) return profileRegion;
  if (
    isExternalIdpConfig(configOrRegion) &&
    configOrRegion?.region === "eu-east-1"
  )
    return "eu-central-1";
  return KIRO_RUNTIME_REGION;
}

export function getKiroRuntimeHost(
  configOrRegion?: KiroRuntimeRegionConfig | string | null,
): string {
  return `q.${getKiroRuntimeRegion(configOrRegion)}.amazonaws.com`;
}

export function getKiroRuntimeBaseUrl(
  configOrRegion?: KiroRuntimeRegionConfig | string | null,
): string {
  return `https://${getKiroRuntimeHost(configOrRegion)}`;
}
