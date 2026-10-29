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
