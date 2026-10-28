import test from "node:test";
import assert from "node:assert/strict";
import { AppDatabase } from "../src/db.js";
import { UsageRepository } from "../src/usage/repository.js";

function entry(
  database: AppDatabase,
  values: {
    id: number;
    time: number;
    cost: number;
    success?: boolean;
  },
) {
  database.connection
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
      7,
      new Date(values.time).toISOString(),
      values.time,
      "claude-sonnet-4.5",
      Number(values.success ?? true),
      200,
      1200,
      300,
      100,
      20,
      30,
      40,
      values.cost / 4,
      values.cost / 4,
      values.cost / 4,
      values.cost / 4,
      values.cost,
      values.cost * 2,
    );
  return values.id;
}

test("history returns exact ordering, cumulative costs, components, and pages", (t) => {
  const database = new AppDatabase(":memory:");
  t.after(() => database.close());
  const now = new Date().toISOString();
  database.connection
    .prepare(
      "INSERT INTO accounts(id, credentials, createdAt, updatedAt) VALUES (7, '{}', ?, ?)",
    )
    .run(now, now);
  const usage = new UsageRepository(database);
  for (const values of [
    { id: 1, time: 1_000, cost: 0.1 },
    { id: 2, time: 2_000, cost: 0.2 },
    { id: 3, time: 3_000, cost: 0.3 },
    { id: 4, time: 4_000, cost: 0.4, success: false },
  ])
    entry(database, values);

  const firstPage = usage.history({ limit: 2, offset: 0 });
  assert.deepEqual(
    firstPage.map((row) => row.id),
    [3, 2],
  );
  assert.ok(Math.abs(Number(firstPage[0].cumulativeCostUsd) - 0.6) < 1e-9);
  assert.ok(Math.abs(Number(firstPage[1].cumulativeCostUsd) - 0.3) < 1e-9);
  assert.equal(firstPage[0].costUsd, 0.3);
  assert.equal(firstPage[0].cost.input_cost_usd, 0.075);
  assert.equal(firstPage[0].cost.output_cost_usd, 0.075);
  assert.equal(firstPage[0].cost.cache_read_cost_usd, 0.075);
  assert.equal(firstPage[0].cost.cache_creation_cost_usd, 0.075);
  assert.deepEqual(firstPage[0].usage, {
    input_tokens: 100,
    output_tokens: 20,
    cache_read_input_tokens: 30,
    cache_creation_input_tokens: 40,
  });
  assert.deepEqual(firstPage[0].timing, { ttft_ms: 300, total_time_ms: 1200 });
  assert.equal(firstPage[0].accountId, 7);
  assert.equal(firstPage[0].kiroCredits, 0.6);

  const secondPage = usage.history({ limit: 2, offset: 2 });
  assert.deepEqual(
    secondPage.map((row) => row.id),
    [1],
  );
  assert.ok(Math.abs(Number(secondPage[0].cumulativeCostUsd) - 0.1) < 1e-9);
  assert.equal(usage.historyCount(), 3);
  assert.equal(usage.historyCount(2_000, 3_000), 2);
});

test("history aggregation returns exact totals and zero-filled buckets", (t) => {
  const database = new AppDatabase(":memory:");
  t.after(() => database.close());
  const now = new Date().toISOString();
  database.connection
    .prepare(
      "INSERT INTO accounts(id, credentials, createdAt, updatedAt) VALUES (7, '{}', ?, ?)",
    )
    .run(now, now);
  for (const values of [
    { id: 1, time: 1_000, cost: 0.1 },
    { id: 2, time: 2_000, cost: 0.2 },
    { id: 3, time: 3_000, cost: 0.3 },
  ])
    entry(database, values);
  const usage = new UsageRepository(database);
  const result = usage.historyAggregated(0, 3_600_000);
  assert.equal(result.interval, 600000);
  assert.equal(result.buckets.length, 7);
  assert.ok(Math.abs(result.totalSpent - 0.6) < 1e-9);
  assert.deepEqual(
    result.buckets.map((bucket) => bucket.spent),
    [0.6, 0, 0, 0, 0, 0, 0],
  );
});
