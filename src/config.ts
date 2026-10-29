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
  thinkingTokenPercentRange: parseThinkingRange(
    process.env.KIRO_THINKING_TOKEN_PERCENT_RANGE || "[0,0]",
  ),
};

export function parseThinkingRange(raw: string): readonly [number, number] {
  try {
    const parsed = JSON.parse(raw);
    if (
      Array.isArray(parsed) &&
      parsed.length === 2 &&
      parsed.every(
        (value) =>
          typeof value === "number" && Number.isFinite(value) && value >= 0,
      ) &&
      parsed[0] <= parsed[1]
    ) {
      return [parsed[0], parsed[1]];
    }
  } catch {
    // Use the disabled default for malformed local configuration.
  }
  return [0, 0];
}
