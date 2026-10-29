import type { AppDatabase } from "../db.ts";

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

  aggregate(startMs: number, endMs: number) {
    const row = this.database.connection
      .prepare(
        `
      SELECT COUNT(*) AS totalRequests, COALESCE(SUM(success), 0) AS successRequests,
        COUNT(*) - COALESCE(SUM(success), 0) AS failedRequests,
        COALESCE(SUM(costUsd), 0) AS totalCostUsd, ${TOKEN_SUM} AS totalTokens,
        COALESCE(AVG(latencyMs), 0) AS avgLatencyMs, COALESCE(AVG(ttftMs), 0) AS avgTtftMs
      FROM request_logs WHERE createdAtMs >= ? AND createdAtMs <= ?
    `,
      )
      .get(startMs, endMs);
    return row;
  }

  private bucketExpression(): string {
    return "CAST((createdAtMs - ?) / ? AS INTEGER)";
  }

  timeseries(startMs: number, endMs: number) {
    const intervalMs = metricsInterval(startMs, endMs);
    const rows = this.database.connection
      .prepare(
        `
      SELECT ${this.bucketExpression()} AS bucket, COUNT(*) AS totalRequests,
        COALESCE(SUM(success), 0) AS successRequests,
        COUNT(*) - COALESCE(SUM(success), 0) AS failedRequests,
        COALESCE(SUM(costUsd), 0) AS totalCostUsd, ${TOKEN_SUM} AS totalTokens,
        COALESCE(AVG(latencyMs), 0) AS avgLatencyMs, COALESCE(AVG(ttftMs), 0) AS avgTtftMs
      FROM request_logs WHERE createdAtMs >= ? AND createdAtMs <= ?
      GROUP BY bucket ORDER BY bucket
    `,
      )
      .all(startMs, intervalMs, startMs, endMs) as Array<
      Record<string, number>
    >;
    const byBucket = new Map(rows.map((row) => [Number(row.bucket), row]));
    const count = Math.max(1, Math.floor((endMs - startMs) / intervalMs) + 1);
    return Array.from({ length: count }, (_, bucket) => {
      const { bucket: _bucket, ...values } = byBucket.get(bucket) || { bucket };
      return {
        timestamp: new Date(startMs + bucket * intervalMs).toISOString(),
        ...zeroTimeSeries(),
        ...values,
      };
    });
  }

  models(startMs: number, endMs: number) {
    return this.database.connection
      .prepare(
        `
      SELECT model, COUNT(*) AS totalRequests, COALESCE(SUM(costUsd), 0) AS totalCostUsd,
        ${TOKEN_SUM} AS totalTokens, COALESCE(AVG(latencyMs), 0) AS avgLatencyMs
      FROM request_logs WHERE createdAtMs >= ? AND createdAtMs <= ?
      GROUP BY model ORDER BY totalCostUsd DESC LIMIT 100
    `,
      )
      .all(startMs, endMs);
  }

  modelCostTimeseries(startMs: number, endMs: number) {
    const intervalMs = metricsInterval(startMs, endMs);
    const rows = this.database.connection
      .prepare(
        `
      SELECT ${this.bucketExpression()} AS bucket, model, COALESCE(SUM(costUsd), 0) AS cost
      FROM request_logs WHERE createdAtMs >= ? AND createdAtMs <= ?
      GROUP BY bucket, model ORDER BY bucket, model
    `,
      )
      .all(startMs, intervalMs, startMs, endMs) as Array<{
      bucket: number;
      model: string;
      cost: number;
    }>;
    const count = Math.max(1, Math.floor((endMs - startMs) / intervalMs) + 1);
    const timestamps = Array.from({ length: count }, (_, bucket) =>
      new Date(startMs + bucket * intervalMs).toISOString(),
    );
    const models = [...new Set(rows.map((row) => row.model))];
    const series: Record<string, number[]> = Object.fromEntries(
      models.map((model) => [model, Array(count).fill(0)]),
    );
    for (const row of rows) {
      if (row.bucket >= 0 && row.bucket < count)
        series[row.model][row.bucket] = row.cost;
    }
    return { timestamps, models, series };
  }

  private historyFilter(startMs?: number, endMs?: number) {
    const conditions = ["success = 1"];
    const params: number[] = [];
    if (startMs !== undefined) {
      conditions.push("createdAtMs >= ?");
      params.push(startMs);
    }
    if (endMs !== undefined) {
      conditions.push("createdAtMs <= ?");
      params.push(endMs);
    }
    return { where: conditions.join(" AND "), params };
  }

  history(options: {
    startMs?: number;
    endMs?: number;
    limit: number;
    offset: number;
  }) {
    const { where, params } = this.historyFilter(
      options.startMs,
      options.endMs,
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

  historyCount(startMs?: number, endMs?: number): number {
    const { where, params } = this.historyFilter(startMs, endMs);
    const row = this.database.connection
      .prepare(`SELECT COUNT(*) AS count FROM request_logs WHERE ${where}`)
      .get(...params) as { count: number };
    return row.count;
  }

  historyAggregated(startMs: number, endMs: number) {
    const interval = metricsInterval(startMs, endMs);
    const { where, params } = this.historyFilter(startMs, endMs);
    const rows = this.database.connection
      .prepare(
        `
      SELECT ${this.bucketExpression()} AS bucket, COALESCE(SUM(costUsd), 0) AS spent
      FROM request_logs WHERE ${where} GROUP BY bucket ORDER BY bucket
    `,
      )
      .all(startMs, interval, ...params) as Array<{
      bucket: number;
      spent: number;
    }>;
    const values = new Map(rows.map((row) => [row.bucket, row.spent]));
    const count = Math.max(1, Math.floor((endMs - startMs) / interval) + 1);
    const buckets = Array.from({ length: count }, (_, bucket) => ({
      timestamp: new Date(startMs + bucket * interval).toISOString(),
      spent: values.get(bucket) || 0,
    }));
    return {
      buckets,
      totalSpent: buckets.reduce((sum, bucket) => sum + bucket.spent, 0),
      interval,
      startTime: new Date(startMs).toISOString(),
      endTime: new Date(endMs).toISOString(),
    };
  }
}

function metricsInterval(startMs: number, endMs: number): number {
  const diff = endMs - startMs;
  if (diff <= 24 * 60 * 60 * 1000) return 10 * 60 * 1000;
  if (diff <= 7 * 24 * 60 * 60 * 1000) return 60 * 60 * 1000;
  if (diff <= 30 * 24 * 60 * 60 * 1000) return 6 * 60 * 60 * 1000;
  return 24 * 60 * 60 * 1000;
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
