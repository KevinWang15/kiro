import path from "node:path";

function integerFromEnv(name: string, fallback: number): number {
  const value = Number(process.env[name]);
  return Number.isInteger(value) && value > 0 ? value : fallback;
}

export const config = {
  host: process.env.HOST || "127.0.0.1",
  port: integerFromEnv("PORT", 4789),
  dbPath: path.resolve(
    process.env.KIRO_DB_PATH || path.join(process.cwd(), "data", "kiro.db"),
  ),
  upstreamBaseUrl:
    process.env.KIRO_UPSTREAM_BASE_URL?.replace(/\/+$/, "") || "",
  authBaseUrl: process.env.KIRO_AUTH_BASE_URL?.replace(/\/+$/, "") || "",
  refreshThresholdMs: 32 * 60 * 1000,
  refreshIntervalMs: 60 * 1000,
  usageIntervalMs: 2 * 60 * 1000,
  requestTimeoutMs: 10 * 60 * 1000,
};
