import type { AppDatabase } from "../db.js";
import type { AccountRecord, KiroCredentials, UsageTotals } from "./types.js";
import { maskToken, parseStatusInfo } from "./types.js";

export interface NewAccount {
  credentials: KiroCredentials;
  comment?: string;
  source?: string;
  priority?: number;
  proxyId?: number | null;
}

export class AccountRepository {
  constructor(readonly database: AppDatabase) {}

  private hydrate(
    row: Record<string, unknown> | undefined,
  ): AccountRecord | null {
    if (!row) return null;
    let accessToken: string | null = null;
    try {
      accessToken = JSON.parse(String(row.credentials)).accessToken || null;
    } catch {
      // Invalid JSON cannot provide an access token.
    }
    return { ...row, accessToken } as AccountRecord;
  }

  list(): AccountRecord[] {
    const rows = this.database.connection
      .prepare("SELECT * FROM accounts ORDER BY id DESC")
      .all() as Array<Record<string, unknown>>;
    return rows.map((row) => this.hydrate(row)!);
  }

  listEnabled(): AccountRecord[] {
    const rows = this.database.connection
      .prepare(
        "SELECT * FROM accounts WHERE enabled = 1 AND autoDisabled = 0 ORDER BY id ASC",
      )
      .all() as Array<Record<string, unknown>>;
    return rows.map((row) => this.hydrate(row)!);
  }

  get(id: number): AccountRecord | null {
    const row = this.database.connection
      .prepare("SELECT * FROM accounts WHERE id = ?")
      .get(id) as Record<string, unknown> | undefined;
    return this.hydrate(row);
  }

  create(input: NewAccount): AccountRecord {
    const now = new Date().toISOString();
    const result = this.database.connection
      .prepare(
        `
      INSERT INTO accounts(credentials, priority, comment, source, proxyId, createdAt, updatedAt)
      VALUES (?, ?, ?, ?, ?, ?, ?)
    `,
      )
      .run(
        JSON.stringify(input.credentials),
        input.priority ?? 1,
        input.comment || "Bulk imported Kiro account",
        input.source || "Bulk imported Kiro account",
        input.proxyId ?? null,
        now,
        now,
      );
    return this.get(Number(result.lastInsertRowid))!;
  }

  updateCredentials(id: number, credentials: KiroCredentials): void {
    this.database.connection
      .prepare(
        `
      UPDATE accounts SET credentials = ?, updatedAt = ? WHERE id = ?
    `,
      )
      .run(JSON.stringify(credentials), new Date().toISOString(), id);
  }

  update(
    id: number,
    input: {
      credentials?: KiroCredentials;
      priority?: number;
      enabled?: boolean;
      autoDisabled?: boolean;
      disabledReason?: string | null;
      comment?: string;
      proxyId?: number | null;
    },
  ): AccountRecord | null {
    const current = this.get(id);
    if (!current) return null;
    const credentials =
      input.credentials ?? (JSON.parse(current.credentials) as KiroCredentials);
    this.database.connection
      .prepare(
        `
      UPDATE accounts SET credentials = ?, priority = ?, enabled = ?,
        autoDisabled = ?, disabledReason = ?, comment = ?, proxyId = ?, updatedAt = ? WHERE id = ?
    `,
      )
      .run(
        JSON.stringify(credentials),
        input.priority ?? current.priority,
        input.enabled === undefined ? current.enabled : Number(input.enabled),
        input.autoDisabled === undefined
          ? current.autoDisabled
          : Number(input.autoDisabled),
        input.disabledReason === undefined
          ? current.disabledReason
          : input.disabledReason,
        input.comment ?? current.comment,
        input.proxyId === undefined ? current.proxyId : input.proxyId,
        new Date().toISOString(),
        id,
      );
    return this.get(id);
  }

  updateStatusInfo(id: number, statusInfo: unknown): void {
    this.database.connection
      .prepare("UPDATE accounts SET statusInfo = ?, updatedAt = ? WHERE id = ?")
      .run(JSON.stringify(statusInfo), new Date().toISOString(), id);
  }

  markUsed(id: number): void {
    this.database.connection
      .prepare("UPDATE accounts SET lastUsedAt = ? WHERE id = ?")
      .run(new Date().toISOString(), id);
  }

  delete(id: number): boolean {
    return (
      this.database.connection
        .prepare("DELETE FROM accounts WHERE id = ?")
        .run(id).changes > 0
    );
  }

  credentialIdentity(credentials: KiroCredentials): string | null {
    const identity =
      credentials.refreshToken ||
      credentials.email ||
      credentials.machineId ||
      credentials.accessToken;
    return identity?.trim().toLowerCase() || null;
  }

  hasDuplicate(credentials: KiroCredentials): boolean {
    const identity = this.credentialIdentity(credentials);
    if (!identity) return false;
    return this.list().some((account) => {
      try {
        return (
          this.credentialIdentity(JSON.parse(account.credentials)) === identity
        );
      } catch {
        return false;
      }
    });
  }

  usageTotals(accountId: number): UsageTotals {
    const row = this.database.connection
      .prepare(
        `
      SELECT COALESCE(SUM(costUsd), 0) AS totalCostUsd,
        COALESCE(SUM(kiroCredits), 0) AS totalKiroCredits
      FROM request_logs WHERE accountId = ? AND success = 1
    `,
      )
      .get(accountId) as unknown as UsageTotals;
    const byDay = this.database.connection
      .prepare(
        `
      SELECT substr(createdAt, 1, 10) AS date, SUM(costUsd) AS totalCostUsd,
        SUM(kiroCredits) AS totalKiroCredits
      FROM request_logs WHERE accountId = ? AND success = 1
      GROUP BY substr(createdAt, 1, 10) ORDER BY date DESC LIMIT 31
    `,
      )
      .all(accountId) as unknown as UsageTotals["byDay"];
    return {
      totalCostUsd: row.totalCostUsd || 0,
      totalKiroCredits: row.totalKiroCredits || 0,
      byDay,
    };
  }

  summaries(): Array<Record<string, unknown>> {
    return this.list().map((account) => ({
      id: account.id,
      provider: "kiro",
      maskedToken: maskToken(account.accessToken),
      priority: account.priority,
      enabled: Boolean(account.enabled),
      autoDisabled: Boolean(account.autoDisabled),
      disabledReason: account.disabledReason,
      comment: account.comment,
      source: account.source,
      proxyId: account.proxyId,
      createdAt: account.createdAt,
      updatedAt: account.updatedAt,
      lastUsedAt: account.lastUsedAt,
      statusInfo: parseStatusInfo(account),
      usage: this.usageTotals(account.id),
    }));
  }
}
