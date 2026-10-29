import axios from "axios";
import { createHash } from "node:crypto";
import KiroApiProviderHandler, {
  getKiroUnrecoverableErrorReason,
} from "../kiro/handler.ts";
import { CacheSimulator } from "../kiro/cache-simulation.ts";
import { SqliteCacheStore } from "../kiro/sqlite-cache.ts";
import { getKiroRuntimeBaseUrl } from "../kiro/constants.ts";
import {
  isKiroPremiumFromStatusInfo,
  shouldPreferPremiumKiroAccount,
  supportsKiroExperimentalModel,
} from "../kiro/utils.ts";
import { hasWebSearchTool, handleWebSearchRequest } from "../kiro/websearch.ts";
import type { MessagesRequest } from "../kiro/types.ts";
import type { McpShimConfig } from "../kiro/mcp-shim.ts";
import type { ProviderExtraConfig } from "../kiro/provider.ts";
import { buildAgentFromProxy } from "../proxy.ts";
import { config } from "../config.ts";
import type { AccountRepository } from "./repository.ts";
import type { ProxyRepository } from "./proxies.ts";
import type { TokenManager } from "./token-manager.ts";
import type { UsageRepository } from "../usage/repository.ts";
import type { AccountRecord, KiroCredentials } from "./types.ts";
import { parseCredentials } from "./types.ts";
import { normalizeKiroExtraConfigAliases } from "./token-manager.ts";

const AUTO_DISABLE_RETRY_COUNT = 5;
const AUTO_DISABLE_RETRY_DELAY_MS = 2000;
const STICKINESS_TTL_MS = 7 * 24 * 60 * 60 * 1000;

export interface KiroStreamSink {
  onHeaders?: (
    status: number,
    headers: Record<string, unknown>,
  ) => Promise<void> | void;
  onChunk: (chunk: string) => Promise<void> | void;
}

export interface PoolResult {
  success: boolean;
  statusCode?: number;
  response?: unknown;
  responseHeaders?: Record<string, unknown>;
  streamed?: boolean;
  error?: string;
  isUnrecoverable?: boolean;
  unrecoverableReason?: string;
  accountId?: number;
}

interface AttemptOptions {
  sink?: KiroStreamSink;
  abortSignal?: AbortSignal;
  requestHeaders?: Record<string, unknown>;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function shouldAutoDisableCredential(statusCode?: number): boolean {
  return statusCode === 401 || statusCode === 403;
}

export function isQuotaExhausted(
  statusCode?: number,
  response?: unknown,
  error?: string,
): boolean {
  if (statusCode !== 402) return false;
  const responseBody = Buffer.isBuffer(response)
    ? response.toString("utf8")
    : typeof response === "string"
      ? response
      : response != null
        ? JSON.stringify(response)
        : "";
  const body = [responseBody, error].filter(Boolean).join(" ");
  if (
    body.includes("MONTHLY_REQUEST_COUNT") ||
    body.includes("OVERAGE_REQUEST_LIMIT_EXCEEDED") ||
    /\bAPI key budget exhausted\b/i.test(body)
  )
    return true;
  try {
    const parsed =
      typeof response === "object" ? response : JSON.parse(responseBody);
    return (
      parsed?.reason === "MONTHLY_REQUEST_COUNT" ||
      parsed?.error?.reason === "MONTHLY_REQUEST_COUNT"
    );
  } catch {
    return false;
  }
}

function shuffleArray<T>(items: T[]): T[] {
  const shuffled = [...items];
  for (let index = shuffled.length - 1; index > 0; index -= 1) {
    const other = Math.floor(Math.random() * (index + 1));
    [shuffled[index], shuffled[other]] = [shuffled[other], shuffled[index]];
  }
  return shuffled;
}

function orderByPriority(accounts: AccountRecord[]): AccountRecord[] {
  const priorities = [
    ...new Set(accounts.map((account) => account.priority)),
  ].sort((a, b) => b - a);
  return priorities.flatMap((priority) =>
    accounts.filter((account) => account.priority === priority),
  );
}

function partitionAccounts(accounts: AccountRecord[], requestModel: string) {
  const preferPremium = shouldPreferPremiumKiroAccount(requestModel);
  const experimental: AccountRecord[] = [];
  const preferred: AccountRecord[] = [];
  const fallback: AccountRecord[] = [];
  for (const account of accounts) {
    const credentials = parseCredentials(account);
    if (
      supportsKiroExperimentalModel(
        requestModel,
        credentials.supportedExperimentalModels,
      )
    ) {
      experimental.push(account);
    } else if (
      isKiroPremiumFromStatusInfo(account.statusInfo) === preferPremium
    ) {
      preferred.push(account);
    } else {
      fallback.push(account);
    }
  }
  return { experimental, preferred, fallback };
}

function preferredAccounts(
  accounts: AccountRecord[],
  requestModel: string,
): AccountRecord[] {
  const { experimental, preferred, fallback } = partitionAccounts(
    accounts,
    requestModel,
  );
  return orderByPriority(
    experimental.length
      ? experimental
      : preferred.length
        ? preferred
        : fallback,
  );
}

export function orderAccountsForRequest(
  accounts: AccountRecord[],
  requestModel: string,
): AccountRecord[] {
  const { experimental, preferred, fallback } = partitionAccounts(
    accounts,
    requestModel,
  );
  return [
    ...orderByPriority(experimental),
    ...orderByPriority(preferred),
    ...orderByPriority(fallback),
  ];
}

function normalizeModelKey(model: string): string {
  return (
    model
      .trim()
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "") || "unknown"
  );
}

function stableUuidFromString(value: string): string {
  const hex = createHash("sha256").update(value).digest("hex");
  const version = `5${hex.slice(13, 16)}`;
  const variant = `${((parseInt(hex[16], 16) & 0x3) | 0x8).toString(16)}${hex.slice(17, 20)}`;
  return [
    hex.slice(0, 8),
    hex.slice(8, 12),
    version,
    variant,
    hex.slice(20, 32),
  ].join("-");
}

function withCacheMetadata(request: MessagesRequest): MessagesRequest {
  const existing = request.metadata?.user_id;
  if (typeof existing === "string" && existing.trim()) return request;
  return {
    ...request,
    metadata: {
      ...request.metadata,
      user_id: `kiro_cache_default__session_${stableUuidFromString("kiro-cache:anonymous")}`,
    },
  };
}

function applyModelMapping(
  request: MessagesRequest,
  credentials: KiroCredentials,
): MessagesRequest {
  const cloned = { ...request };
  if (
    !credentials.modelMapping ||
    typeof cloned.model !== "string" ||
    cloned.model.startsWith("!")
  )
    return cloned;
  let mapped = credentials.modelMapping[cloned.model];
  if (!mapped) {
    for (const [pattern, replacement] of Object.entries(
      credentials.modelMapping,
    )) {
      try {
        const regex = new RegExp(`^${pattern}$`);
        if (regex.test(cloned.model)) {
          mapped = cloned.model.replace(regex, replacement);
          break;
        }
      } catch {
        // Ignore malformed local mapping entries.
      }
    }
  }
  if (mapped) cloned.model = mapped;
  return cloned;
}

class AccountRateLimiter {
  private readonly buckets = new Map<
    number,
    { tokens: number; lastRefilled: number }
  >();

  consume(accountId: number, requestsPerMinute: number): boolean {
    const now = Date.now();
    const current = this.buckets.get(accountId) || {
      tokens: requestsPerMinute,
      lastRefilled: now,
    };
    const elapsed = Math.max(0, now - current.lastRefilled);
    current.tokens = Math.min(
      requestsPerMinute,
      current.tokens + elapsed * (requestsPerMinute / 60000),
    );
    current.lastRefilled = now;
    if (current.tokens < 1) {
      this.buckets.set(accountId, current);
      return false;
    }
    current.tokens -= 1;
    this.buckets.set(accountId, current);
    return true;
  }
}

export class KiroAccountPool {
  private readonly handler: KiroApiProviderHandler;
  private readonly rateLimiter = new AccountRateLimiter();

  constructor(
    private readonly accounts: AccountRepository,
    private readonly proxies: ProxyRepository,
    private readonly tokens: TokenManager,
    private readonly usage: UsageRepository,
  ) {
    this.handler = new KiroApiProviderHandler(
      new CacheSimulator(new SqliteCacheStore(accounts.database)),
    );
  }

  private stickyGet(key: string): number | null {
    const now = Date.now();
    this.accounts.database.connection
      .prepare("DELETE FROM sticky_routes WHERE expiresAtMs <= ?")
      .run(now);
    const row = this.accounts.database.connection
      .prepare(
        "SELECT accountId FROM sticky_routes WHERE key = ? AND expiresAtMs > ?",
      )
      .get(key, now) as { accountId: number } | undefined;
    return row?.accountId ?? null;
  }

  private stickySet(key: string, accountId: number): void {
    this.accounts.database.connection
      .prepare(
        `
      INSERT INTO sticky_routes(key, accountId, expiresAtMs) VALUES (?, ?, ?)
      ON CONFLICT(key) DO UPDATE SET accountId = excluded.accountId, expiresAtMs = excluded.expiresAtMs
    `,
      )
      .run(key, accountId, Date.now() + STICKINESS_TTL_MS);
  }

  private stickyClear(key: string, accountId?: number): void {
    if (accountId === undefined) {
      this.accounts.database.connection
        .prepare("DELETE FROM sticky_routes WHERE key = ?")
        .run(key);
    } else {
      this.accounts.database.connection
        .prepare("DELETE FROM sticky_routes WHERE key = ? AND accountId = ?")
        .run(key, accountId);
    }
  }

  private selectAccount(
    available: AccountRecord[],
    model: string,
    stickyKey: string,
  ): AccountRecord {
    const candidates = preferredAccounts(available, model);
    if (candidates.length === 1) return candidates[0];
    const sticky = this.stickyGet(stickyKey);
    const match = candidates.find((account) => account.id === sticky);
    if (match) return match;
    const selected = candidates[0];
    this.stickySet(stickyKey, selected.id);
    return selected;
  }

  async call(
    originalRequest: MessagesRequest,
    options: AttemptOptions = {},
  ): Promise<PoolResult> {
    const request = withCacheMetadata(structuredClone(originalRequest));
    const allAccounts = this.accounts.listEnabled();
    if (!allAccounts.length) {
      return {
        success: false,
        statusCode: 503,
        error: "No enabled Kiro account available in the pool",
        response: {
          type: "error",
          error: {
            type: "provider_unavailable",
            message: "No enabled Kiro account available in the pool",
          },
        },
      };
    }

    const ordered = orderAccountsForRequest(
      shuffleArray(allAccounts),
      request.model,
    );
    const stickyKey = `kiro:${request.metadata?.user_id}:${normalizeModelKey(request.model)}`;
    const excluded = new Set<number>();
    let lastResult: PoolResult | null = null;

    while (excluded.size < ordered.length) {
      if (options.abortSignal?.aborted)
        return (
          lastResult || {
            success: false,
            statusCode: 499,
            error: "Request canceled",
          }
        );
      const available = ordered.filter((account) => !excluded.has(account.id));
      if (!available.length) break;
      const account = this.selectAccount(available, request.model, stickyKey);
      const credentials = normalizeKiroExtraConfigAliases(
        parseCredentials(account),
      );
      const rpm = credentials.rateLimit?.requestsPerMinute;
      if (rpm && !this.rateLimiter.consume(account.id, rpm)) {
        excluded.add(account.id);
        this.stickyClear(stickyKey, account.id);
        continue;
      }
      excluded.add(account.id);

      const result = await this.callSingle(account, request, options);
      if (options.abortSignal?.aborted || result.statusCode === 499)
        return result;
      if (result.success || result.streamed) return result;
      lastResult = result;
      if (result.isUnrecoverable) return result;

      if (shouldAutoDisableCredential(result.statusCode)) {
        let retryResult = result;
        for (
          let attempt = 0;
          attempt < AUTO_DISABLE_RETRY_COUNT && !retryResult.success;
          attempt += 1
        ) {
          if (options.abortSignal?.aborted || retryResult.isUnrecoverable)
            break;
          await sleep(AUTO_DISABLE_RETRY_DELAY_MS);
          retryResult = await this.callSingle(account, request, options);
        }
        if (options.abortSignal?.aborted || retryResult.statusCode === 499)
          return retryResult;
        if (retryResult.success || retryResult.streamed) return retryResult;
        lastResult = retryResult;
        if (retryResult.isUnrecoverable) return retryResult;
        if (
          shouldAutoDisableCredential(retryResult.statusCode) &&
          credentials.disableAutoDisable !== true
        ) {
          this.accounts.update(account.id, {
            autoDisabled: true,
            disabledReason: `HTTP ${retryResult.statusCode}: ${retryResult.error || "authentication failed"}`,
          });
        }
      } else if (
        isQuotaExhausted(result.statusCode, result.response, result.error) &&
        credentials.disableAutoDisable !== true
      ) {
        this.accounts.update(account.id, {
          autoDisabled: true,
          disabledReason: "Kiro quota or budget exhausted (402)",
        });
      }
      this.stickyClear(stickyKey, account.id);
    }

    return (
      lastResult || {
        success: false,
        statusCode: 500,
        error: "No Kiro account in the pool could fulfill the request",
      }
    );
  }

  async testAccount(
    id: number,
    modelOverride?: string,
  ): Promise<PoolResult & { responseContent?: string }> {
    const account = this.accounts.get(id);
    if (!account)
      return { success: false, statusCode: 404, error: "Account not found" };
    const requestedModel = modelOverride?.trim();
    const model = requestedModel
      ? requestedModel.startsWith("!")
        ? requestedModel
        : `!${requestedModel}`
      : "claude-haiku-4-5-20251001";
    const result = await this.callSingle(
      account,
      {
        model,
        messages: [
          {
            role: "user",
            content: [
              {
                type: "text",
                text: "Please reply with exactly: test successful",
              },
            ],
          },
        ],
        system: [
          {
            text: "You are Claude Code, Anthropic's official CLI for Claude.",
            cache_control: { type: "ephemeral" },
          },
        ],
        tools: [],
        temperature: 1,
        max_tokens: 10,
        stream: false,
      } as MessagesRequest,
      {},
    );
    if (!result.success) return result;
    const response = result.response as any;
    const content =
      response?.type === "message" && Array.isArray(response.content)
        ? response.content.find(
            (block: any) =>
              block.type === "text" && typeof block.text === "string",
          )?.text || ""
        : "";
    if (result.statusCode !== 200 || !content) {
      return { ...result, success: false, error: "Invalid response format" };
    }
    return { ...result, responseContent: content };
  }

  private async callSingle(
    accountRecord: AccountRecord,
    originalRequest: MessagesRequest,
    options: AttemptOptions,
  ): Promise<PoolResult> {
    const startedAt = Date.now();
    let account = accountRecord;
    try {
      account = await this.tokens.ensureAccountToken(accountRecord);
      const credentials = normalizeKiroExtraConfigAliases(
        parseCredentials(account),
      );
      const runtimeCredentials: ProviderExtraConfig = {
        ...credentials,
        isPremium: isKiroPremiumFromStatusInfo(account.statusInfo),
      };
      const proxy = this.proxies.get(account.proxyId);

      if (hasWebSearchTool(originalRequest)) {
        const mcpConfig: McpShimConfig = {
          region: credentials.region || "us-east-1",
          runtimeRegion: credentials.runtimeRegion,
          profileArn: credentials.profileArn,
          accessToken: account.accessToken || undefined,
          refreshToken: credentials.refreshToken,
          clientIdHash: credentials.clientIdHash,
          authMethod: credentials.authMethod,
          provider: credentials.provider,
          proxy,
        };
        const result = await handleWebSearchRequest(originalRequest, mcpConfig);
        const poolResult = {
          success: true,
          statusCode: 200,
          response: result.body,
          responseHeaders: result.headers,
          accountId: account.id,
        };
        this.logAttempt(
          account.id,
          originalRequest.model,
          poolResult,
          startedAt,
        );
        return poolResult;
      }

      if (
        originalRequest.model.includes("*") &&
        originalRequest.model.includes("claude")
      ) {
        originalRequest.model = "claude-haiku-4-5-20251001";
      }
      const mappedRequest = applyModelMapping(originalRequest, credentials);
      const modifiedRequest = this.handler.transformRequestBody(
        mappedRequest,
        runtimeCredentials,
      );
      const headers = this.handler.buildHeaders(
        account.accessToken!,
        runtimeCredentials,
      );
      const anthropicBeta = options.requestHeaders?.["anthropic-beta"];
      if (anthropicBeta) headers["anthropic-beta"] = String(anthropicBeta);
      if (runtimeCredentials.deleteAnthropicBetaHeader)
        delete headers["anthropic-beta"];
      const baseUrl =
        config.upstreamBaseUrl || getKiroRuntimeBaseUrl(credentials);
      const url = `${baseUrl}/generateAssistantResponse`;
      const httpsAgent = buildAgentFromProxy(proxy || undefined);
      const response = await axios({
        method: "POST",
        url,
        headers,
        data: modifiedRequest,
        timeout: config.requestTimeoutMs,
        validateStatus: () => true,
        responseType: "stream",
        httpsAgent,
        ...(httpsAgent ? { proxy: false as const } : {}),
        signal: options.abortSignal,
      });
      const success = response.status >= 200 && response.status < 300;
      const publicHeaders = {
        ...(response.headers || {}),
        "content-type": "text/event-stream; charset=utf-8",
      };
      let ttftMs: number | undefined;

      if (success && originalRequest.stream && options.sink) {
        try {
          await options.sink.onHeaders?.(response.status, publicHeaders);
          const streamed = await this.handler.streamResponse(
            response.data,
            originalRequest,
            modifiedRequest,
            {
              onChunk: async (chunk: string) => {
                if (options.abortSignal?.aborted)
                  throw new Error("Request canceled");
                if (ttftMs === undefined) ttftMs = Date.now() - startedAt;
                await options.sink!.onChunk(chunk);
              },
            },
          );
          const poolResult = {
            success: true,
            statusCode: response.status,
            streamed: true,
            responseHeaders: { ...publicHeaders, ...streamed.internalHeaders },
            accountId: account.id,
          };
          this.logAttempt(
            account.id,
            originalRequest.model,
            poolResult,
            startedAt,
            streamed.internalHeaders,
            ttftMs,
          );
          return poolResult;
        } catch (error) {
          if (options.abortSignal?.aborted)
            return {
              success: false,
              statusCode: 499,
              error: "Request canceled",
              accountId: account.id,
            };
          const poolResult = {
            success: false,
            statusCode: response.status,
            streamed: true,
            responseHeaders: publicHeaders,
            error: `Stream read failed after partial response: ${(error as Error).message}`,
            accountId: account.id,
          };
          this.logAttempt(
            account.id,
            originalRequest.model,
            poolResult,
            startedAt,
            undefined,
            ttftMs,
          );
          return poolResult;
        }
      }

      const chunks: Buffer[] = [];
      for await (const chunk of response.data as AsyncIterable<Buffer>) {
        if (options.abortSignal?.aborted) throw new Error("Request canceled");
        if (ttftMs === undefined) ttftMs = Date.now() - startedAt;
        chunks.push(Buffer.from(chunk));
      }
      const responseData = Buffer.concat(chunks);
      const transformed = await this.handler.transformResponseBody(
        response.status,
        responseData,
        originalRequest,
        modifiedRequest,
      );
      const responseHeaders = {
        ...(response.headers || {}),
        ...(transformed.headers || {}),
      };
      const error = success ? undefined : preview(transformed.body);
      const unrecoverableReason = getKiroUnrecoverableErrorReason(
        response.status,
        transformed.body,
        error,
      );
      const poolResult: PoolResult = {
        success,
        statusCode: response.status,
        response: transformed.body,
        responseHeaders,
        error,
        isUnrecoverable: unrecoverableReason !== undefined,
        unrecoverableReason,
        accountId: account.id,
      };
      this.logAttempt(
        account.id,
        originalRequest.model,
        poolResult,
        startedAt,
        responseHeaders,
        ttftMs,
      );
      return poolResult;
    } catch (error) {
      if (
        options.abortSignal?.aborted ||
        (error as any)?.code === "ERR_CANCELED" ||
        (error as Error).message === "Request canceled"
      ) {
        return {
          success: false,
          statusCode: 499,
          error: "Request canceled",
          accountId: account.id,
        };
      }
      const axiosError = error as any;
      const response = axiosError.response?.data;
      const message = (error as Error).message;
      const unrecoverableReason = getKiroUnrecoverableErrorReason(
        axiosError.response?.status,
        response,
        message,
      );
      const poolResult: PoolResult = {
        success: false,
        statusCode: axiosError.response?.status || 500,
        response,
        error: message,
        isUnrecoverable: unrecoverableReason !== undefined,
        unrecoverableReason,
        accountId: account.id,
      };
      this.logAttempt(account.id, originalRequest.model, poolResult, startedAt);
      return poolResult;
    }
  }

  private logAttempt(
    accountId: number,
    model: string,
    result: PoolResult,
    startedAt: number,
    headers: Record<string, unknown> = result.responseHeaders || {},
    ttftMs?: number,
  ): void {
    this.accounts.markUsed(accountId);
    this.usage.record({
      accountId,
      model,
      success: result.success,
      statusCode: result.statusCode,
      latencyMs: Date.now() - startedAt,
      ttftMs,
      inputTokens: numberHeader(headers, "x-usage-input-tokens"),
      outputTokens: numberHeader(headers, "x-usage-output-tokens"),
      cacheReadInputTokens: numberHeader(
        headers,
        "x-usage-cache-read-input-tokens",
      ),
      cacheCreationInputTokens: numberHeader(
        headers,
        "x-usage-cache-creation-input-tokens",
      ),
      inputCostUsd: numberHeader(headers, "x-cost-input-usd"),
      outputCostUsd: numberHeader(headers, "x-cost-output-usd"),
      cacheReadCostUsd: numberHeader(headers, "x-cost-cache-read-usd"),
      cacheCreationCostUsd: numberHeader(headers, "x-cost-cache-creation-usd"),
      costUsd: numberHeader(headers, "x-cost-usd"),
      kiroCredits: numberHeader(headers, "x-kiro-credit-consumption"),
    });
  }
}

function numberHeader(headers: Record<string, unknown>, name: string): number {
  const value = Number(headers[name]);
  return Number.isFinite(value) ? value : 0;
}

function preview(value: unknown): string {
  if (typeof value === "string") return value.slice(0, 500);
  if (Buffer.isBuffer(value)) return value.toString("utf8").slice(0, 500);
  try {
    return JSON.stringify(value).slice(0, 500);
  } catch {
    return String(value).slice(0, 500);
  }
}
