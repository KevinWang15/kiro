// What the dashboard can chart about request logs. Every read fetches the same
// sums per group and time bucket, and each measure is derived from them. So a
// total is the sum of its buckets' sums, and a ratio (a rate or an average) is
// its summed numerator over its summed denominator, never an average of
// averages.

const SUM_COLUMNS = {
  requests: "COUNT(*)",
  succeeded: "COALESCE(SUM(success), 0)",
  cost: "COALESCE(SUM(costUsd), 0)",
  inputCost: "COALESCE(SUM(inputCostUsd), 0)",
  outputCost: "COALESCE(SUM(outputCostUsd), 0)",
  cacheReadCost: "COALESCE(SUM(cacheReadCostUsd), 0)",
  cacheWriteCost: "COALESCE(SUM(cacheCreationCostUsd), 0)",
  credits: "COALESCE(SUM(kiroCredits), 0)",
  inputTokens: "COALESCE(SUM(inputTokens), 0)",
  outputTokens: "COALESCE(SUM(outputTokens), 0)",
  cacheReadTokens: "COALESCE(SUM(cacheReadInputTokens), 0)",
  cacheWriteTokens: "COALESCE(SUM(cacheCreationInputTokens), 0)",
  latencyMs: "COALESCE(SUM(latencyMs), 0)",
  latencyCount: "COUNT(latencyMs)",
  ttftMs: "COALESCE(SUM(ttftMs), 0)",
  ttftCount: "COUNT(ttftMs)",
  // Output speed counts the time after the first token, on requests that
  // recorded both timings and produced output.
  generatedTokens:
    "COALESCE(SUM(CASE WHEN success = 1 AND outputTokens > 0 AND latencyMs > ttftMs THEN outputTokens END), 0)",
  generationMs:
    "COALESCE(SUM(CASE WHEN success = 1 AND outputTokens > 0 AND latencyMs > ttftMs THEN latencyMs - ttftMs END), 0)",
} as const;

type SumKey = keyof typeof SUM_COLUMNS;
export type Sums = Record<SumKey, number>;

const SUM_KEYS = Object.keys(SUM_COLUMNS) as SumKey[];

export const SUMS_SQL = SUM_KEYS.map((key) => `${SUM_COLUMNS[key]} AS ${key}`).join(", ");

export const zeroSums = (): Sums =>
  Object.fromEntries(SUM_KEYS.map((key) => [key, 0])) as Sums;

export function sumsOf(row: Record<string, unknown>): Sums {
  return Object.fromEntries(SUM_KEYS.map((key) => [key, Number(row[key] || 0)])) as Sums;
}

export function addSums(target: Sums, source: Sums): Sums {
  for (const key of SUM_KEYS) target[key] += source[key];
  return target;
}

export interface Measure {
  id: string;
  label: string;
  group: "Cost" | "Requests" | "Tokens" | "Speed";
  unit: "usd" | "credits" | "count" | "tokens" | "percent" | "ms" | "tokensPerSecond";
  // A sum adds up across groups and buckets, so it is drawn stacked. A ratio
  // doesn't: each group gets its own line.
  kind: "sum" | "ratio";
  // Which direction is an improvement, where one is.
  better?: "higher" | "lower";
  note?: string;
  // Null where there is nothing to divide by.
  value: (sums: Sums) => number | null;
}

type MeasureInfo = Omit<Measure, "kind" | "value">;

const sum = (info: MeasureInfo, of: (sums: Sums) => number): Measure => ({
  ...info,
  kind: "sum",
  value: of,
});

const ratio = (
  info: MeasureInfo,
  numerator: (sums: Sums) => number,
  denominator: (sums: Sums) => number,
): Measure => ({
  ...info,
  kind: "ratio",
  value: (sums) => (denominator(sums) > 0 ? numerator(sums) / denominator(sums) : null),
});

const totalTokens = (sums: Sums) =>
  sums.inputTokens + sums.outputTokens + sums.cacheReadTokens + sums.cacheWriteTokens;

export const MEASURES: Measure[] = [
  sum({ id: "cost", label: "Estimated cost", group: "Cost", unit: "usd" }, (s) => s.cost),
  sum({ id: "inputCost", label: "Input cost", group: "Cost", unit: "usd" }, (s) => s.inputCost),
  sum({ id: "outputCost", label: "Output cost", group: "Cost", unit: "usd" }, (s) => s.outputCost),
  sum({ id: "cacheReadCost", label: "Cache read cost", group: "Cost", unit: "usd" }, (s) => s.cacheReadCost),
  sum({ id: "cacheWriteCost", label: "Cache write cost", group: "Cost", unit: "usd" }, (s) => s.cacheWriteCost),
  ratio(
    {
      id: "costPerRequest",
      label: "Cost per request",
      group: "Cost",
      unit: "usd",
      note: "Estimated cost divided by successful requests",
    },
    (s) => s.cost,
    (s) => s.succeeded,
  ),
  sum({ id: "credits", label: "Kiro credits", group: "Cost", unit: "credits" }, (s) => s.credits),

  sum({ id: "requests", label: "Requests", group: "Requests", unit: "count" }, (s) => s.requests),
  sum({ id: "succeeded", label: "Successful requests", group: "Requests", unit: "count" }, (s) => s.succeeded),
  sum(
    { id: "failed", label: "Failed requests", group: "Requests", unit: "count", better: "lower" },
    (s) => s.requests - s.succeeded,
  ),
  ratio(
    { id: "successRate", label: "Success rate", group: "Requests", unit: "percent", better: "higher" },
    (s) => s.succeeded,
    (s) => s.requests,
  ),

  sum(
    { id: "totalTokens", label: "Total tokens", group: "Tokens", unit: "tokens", note: "Input, output and cache" },
    totalTokens,
  ),
  sum({ id: "inputTokens", label: "Input tokens", group: "Tokens", unit: "tokens" }, (s) => s.inputTokens),
  sum({ id: "outputTokens", label: "Output tokens", group: "Tokens", unit: "tokens" }, (s) => s.outputTokens),
  sum({ id: "cacheReadTokens", label: "Cache read tokens", group: "Tokens", unit: "tokens" }, (s) => s.cacheReadTokens),
  sum({ id: "cacheWriteTokens", label: "Cache write tokens", group: "Tokens", unit: "tokens" }, (s) => s.cacheWriteTokens),
  ratio(
    {
      id: "cacheHitRate",
      label: "Cache hit rate",
      group: "Tokens",
      unit: "percent",
      better: "higher",
      note: "Cache read tokens as a share of all prompt tokens",
    },
    (s) => s.cacheReadTokens,
    (s) => s.inputTokens + s.cacheReadTokens + s.cacheWriteTokens,
  ),

  ratio(
    { id: "latency", label: "Average latency", group: "Speed", unit: "ms", better: "lower" },
    (s) => s.latencyMs,
    (s) => s.latencyCount,
  ),
  ratio(
    { id: "ttft", label: "Average time to first token", group: "Speed", unit: "ms", better: "lower" },
    (s) => s.ttftMs,
    (s) => s.ttftCount,
  ),
  ratio(
    {
      id: "outputSpeed",
      label: "Output speed",
      group: "Speed",
      unit: "tokensPerSecond",
      better: "higher",
      note: "Output tokens per second after the first token",
    },
    (s) => s.generatedTokens,
    (s) => s.generationMs / 1000,
  ),
];

export const measureById = (id: string): Measure | undefined =>
  MEASURES.find((measure) => measure.id === id);

// The catalog as the dashboard reads it.
export function measureSchema() {
  return MEASURES.map(({ value: _value, ...info }) => info);
}
