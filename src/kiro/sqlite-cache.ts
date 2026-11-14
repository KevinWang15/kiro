import type { AppDatabase } from "../db.ts";
import type { ICacheStore } from "./cache-simulation.ts";

export class SqliteCacheStore implements ICacheStore {
  constructor(private readonly database: AppDatabase) {}

  async get(key: string): Promise<number | null> {
    const now = Date.now();
    this.database.connection
      .prepare("DELETE FROM cache_entries WHERE expiresAtMs <= ?")
      .run(now);
    const row = this.database.connection
      .prepare(
        "SELECT tokenCount FROM cache_entries WHERE key = ? AND expiresAtMs > ?",
      )
      .get(key, now) as { tokenCount: number } | undefined;
    return row?.tokenCount ?? null;
  }

  async getMany(keys: string[]): Promise<Map<string, number>> {
    if (!keys.length) return new Map();
    const now = Date.now();
    this.database.connection
      .prepare("DELETE FROM cache_entries WHERE expiresAtMs <= ?")
      .run(now);
    const rows = this.database.connection
      .prepare(
        `SELECT key, tokenCount FROM cache_entries
         WHERE key IN (SELECT value FROM json_each(?)) AND expiresAtMs > ?`,
      )
      .all(JSON.stringify(keys), now) as Array<{
      key: string;
      tokenCount: number;
    }>;
    return new Map(rows.map((row) => [row.key, row.tokenCount]));
  }

  async set(key: string, tokenCount: number, ttlMs: number): Promise<void> {
    this.database.connection
      .prepare(
        `
        INSERT INTO cache_entries(key, tokenCount, expiresAtMs) VALUES (?, ?, ?)
        ON CONFLICT(key) DO UPDATE SET tokenCount = excluded.tokenCount, expiresAtMs = excluded.expiresAtMs
      `,
      )
      .run(key, tokenCount, Date.now() + ttlMs);
  }
}
