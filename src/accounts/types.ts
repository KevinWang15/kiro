import type { ProviderExtraConfig } from "../kiro/provider.js";

export type KiroCredentials = ProviderExtraConfig;

export interface ProxyRecord {
  id: number;
  name: string;
  type: string;
  url: string;
  basicAuthUsername: string | null;
  basicAuthPassword: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface AccountRecord {
  id: number;
  accessToken: string | null;
  credentials: string;
  statusInfo: string | null;
  priority: number;
  enabled: number;
  autoDisabled: number;
  disabledReason: string | null;
  comment: string;
  source: string;
  proxyId: number | null;
  createdAt: string;
  updatedAt: string;
  lastUsedAt: string | null;
}

export interface KiroStatusInfo {
  subscriptionTitle: string;
  currentUsage: number;
  usageLimit: number;
  remaining: number;
  usagePercentage: number;
  isPremium: boolean;
  nextResetAt: string | null;
  lastCheckedAt: string;
}

export interface UsageTotals {
  totalCostUsd: number;
  totalKiroCredits: number;
  byDay?: Array<{
    date: string;
    totalCostUsd: number;
    totalKiroCredits: number;
  }>;
}

export function parseCredentials(record: AccountRecord): KiroCredentials {
  try {
    return JSON.parse(record.credentials) as KiroCredentials;
  } catch {
    return {};
  }
}

export function parseStatusInfo(record: AccountRecord): KiroStatusInfo | null {
  if (!record.statusInfo) return null;
  try {
    return JSON.parse(record.statusInfo) as KiroStatusInfo;
  } catch {
    return null;
  }
}

export function maskToken(token: string | null | undefined): string {
  if (!token) return "";
  if (token.length <= 12) return `${token.slice(0, 2)}…${token.slice(-2)}`;
  return `${token.slice(0, 5)}…${token.slice(-4)}`;
}
