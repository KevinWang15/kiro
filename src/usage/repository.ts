import type { AppDatabase } from "../db.ts";
import { NO_FILTER, type SqlFilter, type UsageField } from "./filters.ts";
import {
  SUMS_SQL,
  addSums,
  measureById,
  sumsOf,
  zeroSums,
  type Measure,
  type Sums,
} from "./measures.ts";

export interface RequestLogEntry {
  accountId: number | null;
  model: string;
  success: boolean;
  statusCode?: number;
  latencyMs?: number;
  ttftMs?: number;
  inputTokens?: number;
  outputTokens?: number;
  cacheReadInputTokens?: number;
  cacheCreationInputTokens?: number;
  inputCostUsd?: number;
  outputCostUsd?: number;
  cacheReadCostUsd?: number;
  cacheCreationCostUsd?: number;
  costUsd?: number;
  kiroCredits?: number;
}

const TOKEN_SUM =
  "COALESCE(SUM(inputTokens + outputTokens + cacheReadInputTokens + cacheCreationInputTokens), 0)";

// A chart draws this many groups, each in its own color (the dashboard's
// palette has as many); the rest are folded into one "Other" series.
const SERIES_LIMIT = 8;
// The most groups a breakdown table lists, and values a filter offers.
const ROW_LIMIT = 200;
const VALUE_LIMIT = 200;
const NO_SUMS: Readonly<Sums> = zeroSums();

interface SeriesGroup {
  key: string | null;
  total: Sums;
  buckets: Map<number, Sums>;
}

export class UsageRepository {
  constructor(private readonly database: AppDatabase) {}

  record(entry: RequestLogEntry): void {
    const now = Date.now();
    this.database.connection
      .prepare(
        `
      INSERT INTO request_logs(
        accountId, createdAt, createdAtMs, model, success, statusCode, latencyMs, ttftMs,
        inputTokens, outputTokens, cacheReadInputTokens, cacheCreationInputTokens,
        inputCostUsd, outputCostUsd, cacheReadCostUsd, cacheCreationCostUsd, costUsd, kiroCredits
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `,
      )
      .run(
        entry.accountId,
        new Date(now).toISOString(),
        now,
        entry.model,
        Number(entry.success),
        entry.statusCode ?? null,
        entry.latencyMs ?? null,
        entry.ttftMs ?? null,
        entry.inputTokens ?? 0,
        entry.outputTokens ?? 0,
        entry.cacheReadInputTokens ?? 0,
        entry.cacheCreationInputTokens ?? 0,
        entry.inputCostUsd ?? 0,
        entry.outputCostUsd ?? 0,
        entry.cacheReadCostUsd ?? 0,
        entry.cacheCreationCostUsd ?? 0,
        entry.costUsd ?? 0,
        entry.kiroCredits ?? 0,
      );
  }

  aggregate(startMs: number, endMs: number, filter: SqlFilter = NO_FILTER) {
    const row = this.database.connection
      .prepare(
        `
      SELECT COUNT(*) AS totalRequests, COALESCE(SUM(success), 0) AS successRequests,
        COUNT(*) - COALESCE(SUM(success), 0) AS failedRequests,
        COALESCE(SUM(costUsd), 0) AS totalCostUsd, ${TOKEN_SUM} AS totalTokens,
        COALESCE(AVG(latencyMs), 0) AS avgLatencyMs, COALESCE(AVG(ttftMs), 0) AS avgTtftMs
      FROM request_logs WHERE createdAtMs >= ? AND createdAtMs <= ? AND ${filter.where}
    `,
      )
      .get(startMs, endMs, ...filter.params);
    return row;
  }

  private bucketExpression(): string {
    return "CAST((createdAtMs - ?) / ? AS INTEGER)";
  }

  timeseries(startMs: number, endMs: number, filter: SqlFilter = NO_FILTER) {
    const intervalMs = metricsInterval(startMs, endMs);
    const rows = this.database.connection
      .prepare(
        `
      SELECT ${this.bucketExpression()} AS bucket, COUNT(*) AS totalRequests,
        COALESCE(SUM(success), 0) AS successRequests,
        COUNT(*) - COALESCE(SUM(success), 0) AS failedRequests,
        COALESCE(SUM(costUsd), 0) AS totalCostUsd, ${TOKEN_SUM} AS totalTokens,
        COALESCE(AVG(latencyMs), 0) AS avgLatencyMs, COALESCE(AVG(ttftMs), 0) AS avgTtftMs
      FROM request_logs WHERE createdAtMs >= ? AND createdAtMs <= ? AND ${filter.where}
      GROUP BY bucket ORDER BY bucket
    `,
      )
      .all(startMs, intervalMs, startMs, endMs, ...filter.params) as Array<
      Record<string, number>
    >;
    const byBucket = new Map(rows.map((row) => [Number(row.bucket), row]));
    const count = bucketCount(startMs, endMs, intervalMs);
    return Array.from({ length: count }, (_, bucket) => {
      const { bucket: _bucket, ...values } = byBucket.get(bucket) || { bucket };
      return {
        timestamp: new Date(startMs + bucket * intervalMs).toISOString(),
        ...zeroTimeSeries(),
        ...values,
      };
    });
  }

  // The measures over time, split by one field: the largest groups each as a
  // series (the rest folded into one), every group's totals for the breakdown
  // table, and the overall totals beside those of the period just before.
  series(options: {
    startMs: number;
    endMs: number;
    measures: Measure[];
    groupBy: UsageField | null;
    filter?: SqlFilter;
  }) {
    const { startMs, endMs, measures, groupBy } = options;
    const filter = options.filter ?? NO_FILTER;
    const intervalMs = metricsInterval(startMs, endMs);
    const count = bucketCount(startMs, endMs, intervalMs);
    const rows = this.database.connection
      .prepare(
        `
      SELECT ${this.bucketExpression()} AS bucket,
        ${groupBy ? groupBy.expression : "NULL"} AS groupKey, ${SUMS_SQL}
      FROM request_logs WHERE createdAtMs >= ? AND createdAtMs <= ? AND ${filter.where}
      GROUP BY bucket, groupKey
    `,
      )
      .all(startMs, intervalMs, startMs, endMs, ...filter.params) as Array<
      Record<string, unknown>
    >;

    const groups = new Map<string | null, SeriesGroup>();
    const groupOf = (key: string | null) => {
      let group = groups.get(key);
      if (!group) {
        group = { key, total: zeroSums(), buckets: new Map() };
        groups.set(key, group);
      }
      return group;
    };
    const overall = zeroSums();
    // Without a split there is one series, of zeros when nothing matched.
    if (!groupBy) groupOf(null);
    for (const row of rows) {
      const bucket = Number(row.bucket);
      if (bucket < 0 || bucket >= count) continue;
      const sums = sumsOf(row);
      const group = groupOf(row.groupKey === null ? null : String(row.groupKey));
      group.buckets.set(bucket, sums);
      addSums(group.total, sums);
      addSums(overall, sums);
    }

    // Largest first by the first measure that adds up (a ratio says nothing
    // about how much of the traffic a group is), then by requests, so groups
    // that cost nothing still rank by how busy they were.
    const rankBy = measures.find((measure) => measure.kind === "sum") ?? measureById("requests")!;
    const ranked = [...groups.values()].sort(
      (a, b) =>
        (rankBy.value(b.total) ?? 0) - (rankBy.value(a.total) ?? 0) ||
        b.total.requests - a.total.requests ||
        String(a.key).localeCompare(String(b.key)),
    );
    const shown = ranked.slice(0, SERIES_LIMIT);
    const folded = ranked.slice(SERIES_LIMIT);
    const other = new Map<number, Sums>();
    for (const group of folded) {
      for (const [bucket, sums] of group.buckets)
        other.set(bucket, addSums(other.get(bucket) ?? zeroSums(), sums));
    }

    const values = (sums: Sums) =>
      Object.fromEntries(measures.map((measure) => [measure.id, measure.value(sums)]));
    const points = (buckets: Map<number, Sums>) =>
      Object.fromEntries(
        measures.map((measure) => [
          measure.id,
          Array.from({ length: count }, (_, bucket) =>
            measure.value(buckets.get(bucket) ?? NO_SUMS),
          ),
        ]),
      );
    // `other` is how many groups the last series folds together.
    const series: Array<{
      key: string | null;
      other?: number;
      points: Record<string, Array<number | null>>;
    }> = shown.map((group) => ({ key: group.key, points: points(group.buckets) }));
    if (folded.length > 0)
      series.push({ key: null, other: folded.length, points: points(other) });
    const previous = this.database.connection
      .prepare(
        `SELECT ${SUMS_SQL} FROM request_logs
         WHERE createdAtMs >= ? AND createdAtMs < ? AND ${filter.where}`,
      )
      .get(startMs - (endMs - startMs), startMs, ...filter.params) as Record<string, unknown>;

    return {
      intervalMs,
      timestamps: Array.from({ length: count }, (_, bucket) =>
        new Date(startMs + bucket * intervalMs).toISOString(),
      ),
      groupBy: groupBy?.name ?? null,
      totals: values(overall),
      previous: values(sumsOf(previous)),
      series,
      rows: groupBy
        ? ranked
            .slice(0, ROW_LIMIT)
            .map((group) => ({ key: group.key, values: values(group.total) }))
        : [],
      rowsTruncated: groupBy !== null && ranked.length > ROW_LIMIT,
    };
  }

  // The values a field takes among the matching requests, most common first.
  fieldValues(options: {
    startMs: number;
    endMs: number;
    field: UsageField;
    filter?: SqlFilter;
  }) {
    const filter = options.filter ?? NO_FILTER;
    const expression = options.field.expression;
    const rows = this.database.connection
      .prepare(
        `
      SELECT ${expression} AS value, COUNT(*) AS count
      FROM request_logs
      WHERE createdAtMs >= ? AND createdAtMs <= ? AND ${filter.where}
        AND ${expression} IS NOT NULL
      GROUP BY value ORDER BY count DESC, value LIMIT ?
    `,
      )
      .all(options.startMs, options.endMs, ...filter.params, VALUE_LIMIT + 1) as Array<{
      value: string | number;
      count: number;
    }>;
    return {
      values: rows
        .slice(0, VALUE_LIMIT)
        .map((row) => ({ value: String(row.value), count: Number(row.count) })),
      truncated: rows.length > VALUE_LIMIT,
    };
  }

  private historyFilter(startMs?: number, endMs?: number, filter: SqlFilter = NO_FILTER) {
    const conditions = ["success = 1"];
    const params: Array<string | number> = [];
    if (startMs !== undefined) {
      conditions.push("createdAtMs >= ?");
      params.push(startMs);
    }
    if (endMs !== undefined) {
      conditions.push("createdAtMs <= ?");
      params.push(endMs);
    }
    conditions.push(filter.where);
    params.push(...filter.params);
    return { where: conditions.join(" AND "), params };
  }

  history(options: {
    startMs?: number;
    endMs?: number;
    limit: number;
    offset: number;
    filter?: SqlFilter;
  }) {
    const { where, params } = this.historyFilter(
      options.startMs,
      options.endMs,
      options.filter,
    );
    const rows = this.database.connection
      .prepare(
        `
      SELECT *, SUM(costUsd) OVER (ORDER BY createdAtMs, id) AS cumulativeCostUsd
      FROM request_logs WHERE ${where}
      ORDER BY createdAtMs DESC, id DESC LIMIT ? OFFSET ?
    `,
      )
      .all(...params, options.limit, options.offset) as Array<
      Record<string, unknown>
    >;
    return rows.map((row) => ({
      id: row.id,
      createdAt: row.createdAt,
      model: row.model,
      costUsd: row.costUsd,
      cumulativeCostUsd: row.cumulativeCostUsd,
      accountId: row.accountId,
      usage: {
        input_tokens: row.inputTokens,
        output_tokens: row.outputTokens,
        cache_read_input_tokens: row.cacheReadInputTokens,
        cache_creation_input_tokens: row.cacheCreationInputTokens,
      },
      cost: {
        input_cost_usd: row.inputCostUsd,
        output_cost_usd: row.outputCostUsd,
        cache_read_cost_usd: row.cacheReadCostUsd,
        cache_creation_cost_usd: row.cacheCreationCostUsd,
        total_cost_usd: row.costUsd,
      },
      timing: { ttft_ms: row.ttftMs, total_time_ms: row.latencyMs },
      kiroCredits: row.kiroCredits,
    }));
  }

  historyCount(startMs?: number, endMs?: number, filter?: SqlFilter): number {
    const { where, params } = this.historyFilter(startMs, endMs, filter);
    const row = this.database.connection
      .prepare(`SELECT COUNT(*) AS count FROM request_logs WHERE ${where}`)
      .get(...params) as { count: number };
    return row.count;
  }
}

function metricsInterval(startMs: number, endMs: number): number {
  const diff = endMs - startMs;
  if (diff <= 24 * 60 * 60 * 1000) return 10 * 60 * 1000;
  if (diff <= 7 * 24 * 60 * 60 * 1000) return 60 * 60 * 1000;
  if (diff <= 30 * 24 * 60 * 60 * 1000) return 6 * 60 * 60 * 1000;
  return 24 * 60 * 60 * 1000;
}

function bucketCount(startMs: number, endMs: number, intervalMs: number): number {
  return Math.max(1, Math.floor((endMs - startMs) / intervalMs) + 1);
}

function zeroTimeSeries() {
  return {
    totalRequests: 0,
    successRequests: 0,
    failedRequests: 0,
    totalCostUsd: 0,
    totalTokens: 0,
    avgLatencyMs: 0,
    avgTtftMs: 0,
  };
}
