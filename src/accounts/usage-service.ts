import axios from "axios";
import { encode, decode } from "cbor-x";
import { v4 as uuidv4 } from "uuid";
import { buildAgentFromProxy } from "../proxy.ts";
import {
  buildHeaders,
  generateMachineId,
  getSystemRuntimeInfo,
} from "../kiro/handler.ts";
import { getKiroRuntimeBaseUrl } from "../kiro/constants.ts";
import { isKiroPremiumUsageLimit } from "../kiro/utils.ts";
import { config } from "../config.ts";
import { isApiKeyAccount } from "./token-manager.ts";
import type { AccountRepository } from "./repository.ts";
import type { ProxyRepository } from "./proxies.ts";
import type { TokenManager } from "./token-manager.ts";
import type { KiroCredentials, KiroStatusInfo, ProxyRecord } from "./types.ts";
import { parseCredentials } from "./types.ts";
import { isSocialLoginAccount } from "./credential-utils.ts";

const KIRO_VERSION = "0.9.2";

interface UsageBreakdown {
  currentUsage: number;
  currentUsageWithPrecision: number;
  usageLimit: number;
  usageLimitWithPrecision: number;
  nextDateReset: number;
  bonuses?: Array<{ currentUsage: number; usageLimit: number; status: string }>;
  freeTrialInfo?: {
    currentUsage: number;
    currentUsageWithPrecision: number;
    usageLimit: number;
    usageLimitWithPrecision: number;
    freeTrialStatus: string;
  };
}

interface UsageLimitsResponse {
  nextDateReset?: number;
  subscriptionInfo?: { subscriptionTitle?: string };
  usageBreakdownList?: UsageBreakdown[];
}

// Kiro reports nextDateReset in seconds on some endpoints and milliseconds on
// others (get-usage.js accepts both). Anything above 1e12 is already ms.
export function resetDateFrom(value: unknown): string | null {
  const n = Number(value);
  if (!Number.isFinite(n) || n <= 0) return null;
  const ms = n > 1e12 ? n : n * 1000;
  const date = new Date(ms);
  return Number.isFinite(date.getTime()) ? date.toISOString() : null;
}

export function aggregateUsage(response: UsageLimitsResponse): KiroStatusInfo {
  const subscriptionTitle =
    response.subscriptionInfo?.subscriptionTitle || "Unknown";
  const breakdown = response.usageBreakdownList?.[0];
  if (!breakdown) {
    return {
      subscriptionTitle,
      currentUsage: 0,
      usageLimit: 0,
      remaining: 0,
      usagePercentage: 0,
      isPremium: false,
      nextResetAt: null,
      lastCheckedAt: new Date().toISOString(),
    };
  }
  // Prefer the precise values and fall back to the plain ones, as
  // get-usage.js does; a missing field must not turn the total into NaN/null.
  const amount = (precise: unknown, plain: unknown) => {
    const value = Number(precise ?? plain);
    return Number.isFinite(value) ? value : 0;
  };
  let currentUsage = amount(breakdown.currentUsageWithPrecision, (breakdown as any).currentUsage);
  let usageLimit = amount(breakdown.usageLimitWithPrecision, (breakdown as any).usageLimit);
  const trial = breakdown.freeTrialInfo as any;
  if (trial?.freeTrialStatus === "ACTIVE") {
    currentUsage += amount(trial.currentUsageWithPrecision, trial.currentUsage);
    usageLimit += amount(trial.usageLimitWithPrecision, trial.usageLimit);
  }
  for (const bonus of (breakdown.bonuses || []) as any[]) {
    if (bonus.status === "ACTIVE") {
      currentUsage += amount(bonus.currentUsageWithPrecision, bonus.currentUsage);
      usageLimit += amount(bonus.usageLimitWithPrecision, bonus.usageLimit);
    }
  }
  const remaining = Math.max(usageLimit - currentUsage, 0);
  const usagePercentage =
    usageLimit > 0 ? Math.min((currentUsage / usageLimit) * 100, 100) : 0;
  const nextResetAt = resetDateFrom(
    breakdown.nextDateReset ?? response.nextDateReset,
  );
  return {
    subscriptionTitle,
    currentUsage: Math.round(currentUsage * 100) / 100,
    usageLimit: Math.round(usageLimit * 100) / 100,
    remaining: Math.round(remaining * 100) / 100,
    usagePercentage: Math.round(usagePercentage * 100) / 100,
    isPremium: isKiroPremiumUsageLimit(usageLimit),
    nextResetAt,
    lastCheckedAt: new Date().toISOString(),
  };
}

function isBuilderIdAccount(credentials: KiroCredentials): boolean {
  return credentials.provider
    ? credentials.provider === "BuilderId"
    : !credentials.profileArn;
}

export function shouldUseCborApi(credentials: KiroCredentials): boolean {
  if (isApiKeyAccount(credentials)) return false;
  return isBuilderIdAccount(credentials) || isSocialLoginAccount(credentials);
}

export function canFetchKiroUsage(
  token: string | null,
  credentials: KiroCredentials,
): boolean {
  return Boolean(
    token && (credentials.refreshToken || isApiKeyAccount(credentials)),
  );
}

async function fetchCbor(
  token: string,
  provider: string,
  proxy: ProxyRecord | null,
): Promise<UsageLimitsResponse | null> {
  try {
    const url =
      process.env.KIRO_CBOR_USAGE_URL ||
      "https://app.kiro.dev/service/KiroWebPortalService/operation/GetUserUsageAndLimits";
    const httpsAgent = buildAgentFromProxy(proxy || undefined);
    const machineId = generateMachineId({ refreshToken: token });
    const { osName, nodeVersion } = getSystemRuntimeInfo();
    const response = await axios.post(
      url,
      encode({ isEmailRequired: true, origin: "KIRO_IDE" }),
      {
        headers: {
          accept: "application/cbor",
          "content-type": "application/cbor",
          "smithy-protocol": "rpc-v2-cbor",
          authorization: `Bearer ${token}`,
          cookie: `Idp=${provider}; AccessToken=${token}`,
          "x-amz-user-agent": `aws-sdk-js/1.0.27 KiroIDE-${KIRO_VERSION}-${machineId}`,
          "user-agent": `aws-sdk-js/1.0.27 ua/2.1 os/${osName} lang/js md/nodejs#${nodeVersion} api/codewhispererstreaming#1.0.27 m/E KiroIDE-${KIRO_VERSION}-${machineId}`,
          "amz-sdk-invocation-id": uuidv4(),
          "amz-sdk-request": "attempt=1; max=1",
        },
        httpsAgent,
        ...(httpsAgent ? { proxy: false as const } : {}),
        timeout: 20000,
        validateStatus: () => true,
        responseType: "arraybuffer",
      },
    );
    if (response.status !== 200) return null;
    return decode(Buffer.from(response.data)) as UsageLimitsResponse;
  } catch {
    return null;
  }
}

async function fetchRest(
  token: string,
  credentials: KiroCredentials,
  proxy: ProxyRecord | null,
): Promise<UsageLimitsResponse | null> {
  try {
    const baseUrl =
      config.upstreamBaseUrl || getKiroRuntimeBaseUrl(credentials);
    let url = `${baseUrl}/getUsageLimits?origin=AI_EDITOR&resourceType=AGENTIC_REQUEST&isEmailRequired=true`;
    if (credentials.profileArn)
      url += `&profileArn=${encodeURIComponent(credentials.profileArn)}`;
    const httpsAgent = buildAgentFromProxy(proxy || undefined);
    const response = await axios.get(url, {
      headers: buildHeaders(token, credentials, "usageLimits"),
      httpsAgent,
      ...(httpsAgent ? { proxy: false as const } : {}),
      timeout: 20000,
      validateStatus: () => true,
    });
    return response.status === 200
      ? (response.data as UsageLimitsResponse)
      : null;
  } catch {
    return null;
  }
}

export async function fetchKiroUsageLimits(
  token: string,
  credentials: KiroCredentials,
  proxy: ProxyRecord | null,
): Promise<KiroStatusInfo | null> {
  if (shouldUseCborApi(credentials)) {
    const cbor = await fetchCbor(
      token,
      credentials.provider || "BuilderId",
      proxy,
    );
    if (cbor) return aggregateUsage(cbor);
    const rest = await fetchRest(token, credentials, proxy);
    return rest ? aggregateUsage(rest) : null;
  }
  const rest = await fetchRest(token, credentials, proxy);
  return rest ? aggregateUsage(rest) : null;
}

export class UsageService {
  private readonly locks = new Map<number, Promise<KiroStatusInfo | null>>();

  constructor(
    private readonly accounts: AccountRepository,
    private readonly proxies: ProxyRepository,
    private readonly tokens: TokenManager,
  ) {}

  refreshAccountUsage(id: number): Promise<KiroStatusInfo | null> {
    const existing = this.locks.get(id);
    if (existing) return existing;
    const task = this.doRefreshAccountUsage(id).finally(() =>
      this.locks.delete(id),
    );
    this.locks.set(id, task);
    return task;
  }

  private async doRefreshAccountUsage(
    id: number,
  ): Promise<KiroStatusInfo | null> {
    const account = await this.tokens.ensureAccountToken(
      this.accounts.get(id) ||
        (() => {
          throw new Error("Account not found");
        })(),
    );
    const credentials = parseCredentials(account);
    if (!canFetchKiroUsage(account.accessToken, credentials)) return null;
    const status = await fetchKiroUsageLimits(
      account.accessToken!,
      credentials,
      this.proxies.get(account.proxyId),
    );
    if (!status || !(status.usageLimit > 0)) return null;
    this.accounts.updateStatusInfo(id, status);
    return status;
  }

  /** Refresh several accounts in parallel, waiting at most `timeoutMs`. */
  async refreshNow(ids: number[], timeoutMs = 8000): Promise<void> {
    const all = Promise.allSettled(ids.map((id) => this.refreshAccountUsage(id)));
    await Promise.race([all, new Promise((resolve) => setTimeout(resolve, timeoutMs).unref())]);
  }

  async refreshAll(): Promise<void> {
    for (const account of this.accounts.list()) {
      if (!account.enabled || !account.accessToken) continue;
      try {
        await this.refreshAccountUsage(account.id);
      } catch (error) {
        console.warn(
          `[KIRO_USAGE_FETCH] account=${account.id}: ${(error as Error).message}`,
        );
      }
    }
  }
}
