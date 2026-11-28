import test from "node:test";
import assert from "node:assert/strict";
import { AppDatabase } from "../src/db.ts";
import { UsageRepository } from "../src/usage/repository.ts";
import {
  FilterError,
  compileFilters,
  parseFilters,
  usageField,
} from "../src/usage/filters.ts";
import { MEASURES, measureById } from "../src/usage/measures.ts";

const MINUTE = 60_000;

interface Row {
  time: number;
  model: string;
  account?: number | null;
  success?: boolean;
  status?: number | null;
  cost?: number;
  latency?: number | null;
  ttft?: number | null;
  input?: number;
  output?: number;
  cacheRead?: number;
}

function setup(t: { after: (fn: () => void) => void }, rows: Row[]) {
  const database = new AppDatabase(":memory:");
  t.after(() => database.close());
  const now = new Date().toISOString();
  for (const id of [1, 2])
    database.connection
      .prepare("INSERT INTO accounts(id, credentials, createdAt, updatedAt) VALUES (?, '{}', ?, ?)")
      .run(id, now, now);
  const insert = database.connection.prepare(`
    INSERT INTO request_logs(
      accountId, createdAt, createdAtMs, model, success, statusCode, latencyMs, ttftMs,
      inputTokens, outputTokens, cacheReadInputTokens, costUsd
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);
  for (const row of rows) {
    const success = row.success ?? true;
    insert.run(
      row.account === undefined ? 1 : row.account,
      new Date(row.time).toISOString(),
      row.time,
      row.model,
      Number(success),
      row.status === undefined ? (success ? 200 : 429) : row.status,
      row.latency === undefined ? 1000 : row.latency,
      row.ttft === undefined ? 200 : row.ttft,
      row.input ?? 0,
      row.output ?? 0,
      row.cacheRead ?? 0,
      row.cost ?? 0,
    );
  }
  return new UsageRepository(database);
}

const pick = (...ids: string[]) => ids.map((id) => measureById(id)!);
const filter = (...tokens: string[]) => compileFilters(parseFilters(tokens));
const close = (actual: unknown, expected: number) =>
  assert.ok(Math.abs(Number(actual) - expected) < 1e-9, `${actual} is not ${expected}`);

// Two 10-minute buckets, then the period just before the range.
const ROWS: Row[] = [
  { time: 60 * MINUTE + 1, model: "opus", cost: 0.5, latency: 3000, input: 100, cacheRead: 300, output: 50 },
  { time: 60 * MINUTE + 2, model: "opus", cost: 0.3, latency: 1000, account: 2, input: 100, output: 150, ttft: 500 },
  { time: 60 * MINUTE + 3, model: "haiku", cost: 0.1, latency: 400, account: null },
  { time: 71 * MINUTE, model: "haiku", success: false, latency: null, ttft: null },
  { time: 72 * MINUTE, model: "sonnet", cost: 0.2, latency: 2000, account: 2 },
  { time: 50 * MINUTE, model: "opus", cost: 0.4, latency: 500 },
];
const RANGE = { startMs: 60 * MINUTE, endMs: 80 * MINUTE };

test("series split requests by a field, ranked by the first summed measure", (t) => {
  const usage = setup(t, ROWS);
  const result = usage.series({
    ...RANGE,
    measures: pick("cost", "requests", "failed", "latency", "successRate"),
    groupBy: usageField("model")!,
  });
  assert.equal(result.intervalMs, 10 * MINUTE);
  assert.equal(result.timestamps.length, 3);
  assert.equal(result.groupBy, "model");
  assert.deepEqual(result.series.map((series) => series.key), ["opus", "sonnet", "haiku"]);

  const [opus, sonnet, haiku] = result.series;
  close(opus.points.cost[0], 0.8);
  assert.deepEqual(opus.points.cost.slice(1), [0, 0]);
  assert.deepEqual(opus.points.requests, [2, 0, 0]);
  // A ratio is its summed numerator over its summed denominator, and has no
  // value where there is nothing to divide by.
  assert.deepEqual(opus.points.latency, [2000, null, null]);
  assert.deepEqual(sonnet.points.latency, [null, 2000, null]);
  assert.deepEqual(haiku.points.failed, [0, 1, 0]);
  assert.deepEqual(haiku.points.successRate, [1, 0, null]);
  // The failed request recorded no latency, so it isn't averaged in.
  assert.deepEqual(haiku.points.latency, [400, null, null]);

  close(result.totals.cost, 1.1);
  assert.equal(result.totals.requests, 5);
  assert.equal(result.totals.failed, 1);
  assert.equal(result.totals.latency, 1600);
  assert.equal(result.totals.successRate, 0.8);
  // The period of the same length just before the range.
  close(result.previous.cost, 0.4);
  assert.equal(result.previous.requests, 1);
  assert.equal(result.previous.latency, 500);

  assert.deepEqual(result.rows.map((row) => row.key), ["opus", "sonnet", "haiku"]);
  close(result.rows[0].values.cost, 0.8);
  assert.equal(result.rows[2].values.successRate, 0.5);
  assert.equal(result.rowsTruncated, false);
});

test("series without a split are one series, of zeros when nothing matches", (t) => {
  const usage = setup(t, ROWS);
  const all = usage.series({ ...RANGE, measures: pick("requests", "cacheHitRate", "outputSpeed"), groupBy: null });
  assert.equal(all.groupBy, null);
  assert.equal(all.series.length, 1);
  assert.deepEqual(all.series[0].points.requests, [3, 2, 0]);
  // 300 cache read of 500 prompt tokens.
  assert.equal(all.totals.cacheHitRate, 0.6);
  // 50 tokens in 2.8 s and 150 in 0.5 s after their first tokens.
  close(all.totals.outputSpeed, 200 / 3.3);
  assert.deepEqual(all.rows, []);

  const none = usage.series({ ...RANGE, measures: pick("requests", "latency"), groupBy: null, filter: filter("model:is:missing") });
  assert.deepEqual(none.series[0].points.requests, [0, 0, 0]);
  assert.deepEqual(none.series[0].points.latency, [null, null, null]);
  assert.equal(none.totals.latency, null);
  const noGroups = usage.series({ ...RANGE, measures: pick("requests"), groupBy: usageField("model")!, filter: filter("model:is:missing") });
  assert.deepEqual(noGroups.series, []);
});

test("series fold the groups past the limit into one", (t) => {
  const usage = setup(
    t,
    Array.from({ length: 11 }, (_, index) => ({ time: 60 * MINUTE + index, model: `m${index}`, cost: 11 - index })),
  );
  const result = usage.series({ ...RANGE, measures: pick("cost", "costPerRequest"), groupBy: usageField("model")! });
  assert.equal(result.series.length, 9);
  assert.deepEqual(result.series.slice(0, 8).map((series) => series.key), ["m0", "m1", "m2", "m3", "m4", "m5", "m6", "m7"]);
  const other = result.series[8];
  assert.equal(other.other, 3);
  assert.equal(other.points.cost[0], 3 + 2 + 1);
  assert.equal(other.points.costPerRequest[0], 2);
  // The table still lists every group.
  assert.equal(result.rows.length, 11);
});

test("filters narrow every read", (t) => {
  const usage = setup(t, ROWS);
  const requests = (...tokens: string[]) =>
    usage.series({ ...RANGE, measures: pick("requests"), groupBy: null, filter: filter(...tokens) }).totals.requests;
  assert.equal(requests("model:is:opus"), 2);
  assert.equal(requests("model:in:opus,sonnet"), 3);
  assert.equal(requests("model:not:opus"), 3);
  assert.equal(requests("model:notIn:opus,haiku"), 1);
  assert.equal(requests("account:is:2"), 2);
  assert.equal(requests("account:missing"), 1);
  assert.equal(requests("account:exists"), 4);
  // A request without an account isn't on the excluded account.
  assert.equal(requests("account:not:1"), 3);
  assert.equal(requests("outcome:is:failed"), 1);
  assert.equal(requests("status:in:200,500"), 4);
  assert.equal(requests("cost:gt:0.2"), 2);
  assert.equal(requests("cost:gte:0.2"), 3);
  assert.equal(requests("latency:lt:1000"), 1);
  assert.equal(requests("totalTokens:lte:250", "outputTokens:gt:0"), 1);
  assert.equal(requests("model:is:opus", "account:is:2"), 1);

  const aggregate = usage.aggregate(RANGE.startMs, RANGE.endMs, filter("model:is:haiku")) as Record<string, number>;
  assert.equal(aggregate.totalRequests, 2);
  assert.equal(aggregate.failedRequests, 1);
  const timeseries = usage.timeseries(RANGE.startMs, RANGE.endMs, filter("model:is:sonnet"));
  assert.deepEqual(timeseries.map((point) => point.totalRequests), [0, 1, 0]);
  // History lists successful requests only.
  assert.equal(usage.historyCount(RANGE.startMs, RANGE.endMs, filter("model:is:haiku")), 1);
  assert.deepEqual(
    usage.history({ ...RANGE, limit: 10, offset: 0, filter: filter("account:is:2") }).map((row) => row.model),
    ["sonnet", "opus"],
  );
});

test("field values are counted among the requests the other filters match", (t) => {
  const usage = setup(t, ROWS);
  const values = (name: string, ...tokens: string[]) =>
    usage.fieldValues({ ...RANGE, field: usageField(name)!, filter: filter(...tokens) });
  assert.deepEqual(values("model"), {
    values: [
      { value: "haiku", count: 2 },
      { value: "opus", count: 2 },
      { value: "sonnet", count: 1 },
    ],
    truncated: false,
  });
  // Requests without an account have no value to offer.
  assert.deepEqual(values("account").values, [
    { value: "1", count: 2 },
    { value: "2", count: 2 },
  ]);
  assert.deepEqual(values("outcome", "model:is:haiku").values, [
    { value: "failed", count: 1 },
    { value: "success", count: 1 },
  ]);
  assert.deepEqual(values("status", "outcome:is:failed").values, [{ value: "429", count: 1 }]);
});

test("filter text is parsed strictly and never reaches SQL", () => {
  assert.deepEqual(parseFilters(undefined), []);
  assert.deepEqual(parseFilters("model:in:a%2Cb,c%25,d:e"), [
    { field: "model", operator: "in", values: ["a,b", "c%", "d:e"] },
  ]);
  const compiled = filter("model:is:x' OR '1'='1", "account:notIn:1,2", "ttft:missing", "cost:lte:0.5");
  assert.equal(
    compiled.where,
    "model IN (?) AND (accountId IS NULL OR accountId NOT IN (?, ?)) AND ttftMs IS NULL AND costUsd <= ?",
  );
  assert.deepEqual(compiled.params, ["x' OR '1'='1", 1, 2, 0.5]);
  assert.equal(filter().where, "1");

  for (const bad of [
    "nope:is:1",
    "model",
    "model:gt:a",
    "model:is",
    "model:is:a,b",
    "model:in",
    "model:exists",
    "account:is:abc",
    "account:exists:1",
    "cost:missing",
    "outcome:is:maybe",
    "cost:gt:lots",
    "cost:in:1,2",
    "model:is:%zz",
  ])
    assert.throws(() => parseFilters(bad), FilterError, bad);
  assert.throws(() => parseFilters(Array.from({ length: 21 }, () => "model:is:a")), FilterError);
  assert.throws(() => parseFilters([{ nested: "x" }]), FilterError);
});

test("measure ids are unique", () => {
  assert.equal(new Set(MEASURES.map((measure) => measure.id)).size, MEASURES.length);
});
