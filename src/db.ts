import fs from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";

export class AppDatabase {
  readonly connection: DatabaseSync;

  constructor(filename: string) {
    fs.mkdirSync(path.dirname(filename), { recursive: true });
    this.connection = new DatabaseSync(filename);
    this.connection.exec(
      "PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON; PRAGMA busy_timeout = 5000;",
    );
    this.initializeSchema();
  }

  private initializeSchema(): void {
    this.connection.exec(`
      CREATE TABLE IF NOT EXISTS proxies (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        name TEXT NOT NULL,
        type TEXT NOT NULL,
        url TEXT NOT NULL,
        basicAuthUsername TEXT,
        basicAuthPassword TEXT,
        createdAt TEXT NOT NULL,
        updatedAt TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS accounts (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        credentials TEXT NOT NULL,
        statusInfo TEXT,
        priority INTEGER NOT NULL DEFAULT 1,
        enabled INTEGER NOT NULL DEFAULT 1,
        autoDisabled INTEGER NOT NULL DEFAULT 0,
        disabledReason TEXT,
        comment TEXT NOT NULL DEFAULT '',
        source TEXT NOT NULL DEFAULT 'Manual Kiro account',
        proxyId INTEGER REFERENCES proxies(id) ON DELETE SET NULL,
        createdAt TEXT NOT NULL,
        updatedAt TEXT NOT NULL,
        lastUsedAt TEXT
      );

      CREATE TABLE IF NOT EXISTS request_logs (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        accountId INTEGER REFERENCES accounts(id) ON DELETE SET NULL,
        createdAt TEXT NOT NULL,
        createdAtMs INTEGER NOT NULL,
        model TEXT NOT NULL,
        success INTEGER NOT NULL,
        statusCode INTEGER,
        latencyMs INTEGER,
        ttftMs INTEGER,
        inputTokens INTEGER NOT NULL DEFAULT 0,
        outputTokens INTEGER NOT NULL DEFAULT 0,
        cacheReadInputTokens INTEGER NOT NULL DEFAULT 0,
        cacheCreationInputTokens INTEGER NOT NULL DEFAULT 0,
        inputCostUsd REAL NOT NULL DEFAULT 0,
        outputCostUsd REAL NOT NULL DEFAULT 0,
        cacheReadCostUsd REAL NOT NULL DEFAULT 0,
        cacheCreationCostUsd REAL NOT NULL DEFAULT 0,
        costUsd REAL NOT NULL DEFAULT 0,
        kiroCredits REAL NOT NULL DEFAULT 0
      );

      CREATE TABLE IF NOT EXISTS cache_entries (
        key TEXT PRIMARY KEY,
        tokenCount INTEGER NOT NULL,
        expiresAtMs INTEGER NOT NULL
      );

      CREATE TABLE IF NOT EXISTS sticky_routes (
        key TEXT PRIMARY KEY,
        accountId INTEGER NOT NULL,
        expiresAtMs INTEGER NOT NULL
      );

      CREATE INDEX IF NOT EXISTS idx_accounts_enabled ON accounts(enabled, autoDisabled);
      CREATE INDEX IF NOT EXISTS idx_request_logs_account ON request_logs(accountId, createdAtMs);
      CREATE INDEX IF NOT EXISTS idx_request_logs_time_model ON request_logs(createdAtMs, model);
      CREATE INDEX IF NOT EXISTS idx_request_logs_history ON request_logs(success, createdAtMs, id);
      CREATE INDEX IF NOT EXISTS idx_cache_expiry ON cache_entries(expiresAtMs);
      CREATE INDEX IF NOT EXISTS idx_sticky_expiry ON sticky_routes(expiresAtMs);
    `);
  }

  close(): void {
    this.connection.close();
  }
}
