// Match sharegpt edd007fc's OAuth profile selection for inference and MCP.
export const BUILDER_ID_PROFILE_ARN =
  "arn:aws:codewhisperer:us-east-1:638616132270:profile/AAAACCCCXXXX";
export const SOCIAL_PROFILE_ARN =
  "arn:aws:codewhisperer:us-east-1:699475941385:profile/EHGA3GRVQMUK";

type ProfileConfig = {
  profileArn?: string;
  profile_arn?: string;
  authMethod?: string;
  provider?: string;
  kiroApiKey?: string;
};

function configuredProfileArn(config?: ProfileConfig | null): string | undefined {
  return [config?.profileArn, config?.profile_arn].find(
    (arn) => typeof arn === "string" && arn.trim().length > 0,
  );
}

export function getStreamingProfileArn(config?: ProfileConfig | null): string | undefined {
  const configured = configuredProfileArn(config);
  if (configured) return configured;

  const authMethod = config?.authMethod?.trim().toLowerCase();
  if (authMethod === "api_key" || authMethod === "apikey" || config?.kiroApiKey)
    return undefined;

  const provider = config?.provider?.trim().toLowerCase();
  return authMethod === "social" || provider === "github" || provider === "google"
    ? SOCIAL_PROFILE_ARN
    : BUILDER_ID_PROFILE_ARN;
}

// Management operations must not receive the Builder ID inference placeholder.
export function getEffectiveProfileArn(config?: ProfileConfig | null): string | undefined {
  const configured = configuredProfileArn(config);
  return configured === BUILDER_ID_PROFILE_ARN ? undefined : configured;
}
