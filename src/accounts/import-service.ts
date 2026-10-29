import { toKiroCanonicalJson } from "./credentials.ts";
import type { AccountRepository } from "./repository.ts";
import type { ProxyRepository } from "./proxies.ts";
import type { TokenManager } from "./token-manager.ts";
import type { KiroCredentials, ProxyRecord } from "./types.ts";

export type KiroBulkProxyMode = "none" | "random_working";

export interface KiroBulkImportResult {
  created: number;
  skipped: number;
  failed: Array<{ index: number; error: string }>;
  proxyCount: number;
  accountIds: number[];
}

const MAX_BULK_ACCOUNTS = 500;
const randomItem = <T>(items: T[]): T =>
  items[Math.floor(Math.random() * items.length)];

export class AccountImportService {
  constructor(
    private readonly accounts: AccountRepository,
    private readonly proxies: ProxyRepository,
    private readonly tokens: TokenManager,
  ) {}

  /**
   * Create one account from a credential gathered by the New account dialog
   * (a sign-in flow or the manual form). Same conversion and duplicate check
   * as bulk import; returns a clear error instead of a per-row failure list.
   */
  async createOne(
    raw: unknown,
    options: {
      proxyId?: number | null;
      priority?: number;
      comment?: string;
      enabled?: boolean;
      source: string;
    },
  ): Promise<{ id: number }> {
    const credential = toKiroCanonicalJson(raw) as KiroCredentials;
    if (!credential.accessToken && !credential.refreshToken)
      throw new Error("A refresh token or access token is required");
    const proxy =
      options.proxyId == null ? null : this.proxies.get(options.proxyId);
    if (options.proxyId != null && !proxy) throw new Error("Proxy not found");
    const resolved = await this.tokens.convertCredential(credential, proxy);
    if (this.accounts.hasDuplicate(resolved))
      throw new Error("This account is already in the pool");
    const account = this.accounts.create({
      credentials: resolved,
      proxyId: proxy?.id ?? null,
      priority: options.priority,
      comment: options.comment?.trim() || options.source,
      source: options.source,
    });
    if (options.enabled === false)
      this.accounts.update(account.id, { enabled: false });
    return { id: account.id };
  }

  async import(
    rawAccounts: unknown[],
    proxyMode: KiroBulkProxyMode = "none",
  ): Promise<KiroBulkImportResult> {
    if (!Array.isArray(rawAccounts) || rawAccounts.length === 0) {
      throw new Error("accounts must be a non-empty array");
    }
    if (rawAccounts.length > MAX_BULK_ACCOUNTS) {
      throw new Error(
        `at most ${MAX_BULK_ACCOUNTS} accounts may be imported at once`,
      );
    }
    if (proxyMode !== "none" && proxyMode !== "random_working")
      throw new Error("Unsupported proxy mode");

    let workingProxies: ProxyRecord[] = [];
    if (proxyMode === "random_working") {
      workingProxies = await this.proxies.findWorking();
      if (!workingProxies.length)
        throw new Error(
          "No working proxies remain after testing all configured proxies",
        );
    }

    const result: KiroBulkImportResult = {
      created: 0,
      skipped: 0,
      failed: [],
      proxyCount: workingProxies.length,
      accountIds: [],
    };
    for (let index = 0; index < rawAccounts.length; index += 1) {
      try {
        const credential = toKiroCanonicalJson(
          rawAccounts[index],
        ) as KiroCredentials;
        if (!credential.accessToken && !credential.refreshToken)
          throw new Error("missing accessToken or refreshToken");
        const proxy = workingProxies.length ? randomItem(workingProxies) : null;
        const resolved = await this.tokens.convertCredential(credential, proxy);
        if (this.accounts.hasDuplicate(resolved)) {
          result.skipped += 1;
          continue;
        }
        const account = this.accounts.create({
          credentials: resolved,
          proxyId: proxy?.id ?? null,
          comment: "Bulk imported Kiro account",
          source: "Bulk imported Kiro account",
        });
        result.created += 1;
        result.accountIds.push(account.id);
      } catch (error) {
        result.failed.push({
          index,
          error: error instanceof Error ? error.message : String(error),
        });
      }
    }
    return result;
  }
}
