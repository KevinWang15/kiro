export interface ProviderExtraConfig {
  modelMapping?: Record<string, string>;
  disableAutoDisable?: boolean;
  accessToken?: string;
  refreshToken?: string;
  expiresAt?: string;
  clientId?: string;
  clientSecret?: string;
  clientIdHash?: string;
  startUrl?: string;
  tokenEndpoint?: string;
  issuerUrl?: string;
  scopes?: string;
  audience?: string;
  authMethod?: string;
  provider?: string;
  region?: string;
  runtimeRegion?: string;
  profileArn?: string;
  ssoSessionId?: string;
  idToken?: string;
  machineId?: string;
  email?: string;
  userId?: string;
  supportedExperimentalModels?: string[];
  deleteAnthropicBetaHeader?: boolean;
  rateLimit?: { requestsPerMinute: number };
  [key: string]: unknown;
}
