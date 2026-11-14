import test from "node:test";
import assert from "node:assert/strict";
import {
  CacheSimulator,
  InMemoryCacheStore,
  MockClock,
  type ICacheStore,
} from "../src/kiro/cache-simulation.ts";
import { SqliteCacheStore } from "../src/kiro/sqlite-cache.ts";
import { AppDatabase } from "../src/db.ts";
import type { AnthropicMessage, SystemMessage } from "../src/kiro/types.ts";

// These tests describe the simulator only through simulate(), so they hold
// for any cache key format.

type System = SystemMessage[] | string | undefined;
const user = (content: any) => ({ role: "user", content }) as AnthropicMessage;
const assistant = (content: any) =>
  ({ role: "assistant", content }) as AnthropicMessage;
const turns = (n: number, tag = "m") =>
  Array.from({ length: n }, (_, i) =>
    i % 2 ? assistant(`${tag}${i}`) : user(`${tag}${i}`),
  );

function simulator(ttlMs?: number) {
  const clock = new MockClock(0);
  return { clock, sim: new CacheSimulator(new InMemoryCacheStore(clock), ttlMs) };
}

test("the longest stored prefix wins", async () => {
  const { sim } = simulator();
  await sim.simulate("sys", turns(1), 100, "c");
  await sim.simulate("sys", turns(3), 300, "c");
  await sim.simulate("sys", turns(5), 500, "c");
  assert.equal(await sim.simulate("sys", turns(7), 700, "c"), 500);
  // Only prefixes shorter than the request count, never the request itself.
  const fresh = simulator().sim;
  await fresh.simulate("sys", turns(3), 300, "c");
  assert.equal(await fresh.simulate("sys", turns(3), 300, "c"), 0);
  assert.equal(await fresh.simulate("sys", turns(4), 400, "c"), 300);
});

test("a changed message only matches prefixes before the change", async () => {
  const { sim } = simulator();
  await sim.simulate("sys", turns(2), 200, "c");
  await sim.simulate("sys", turns(6), 600, "c");
  const edited = turns(8);
  edited[3] = assistant("edited");
  assert.equal(await sim.simulate("sys", edited, 800, "c"), 200);
  edited[0] = user("edited too");
  assert.equal(await sim.simulate("sys", edited, 800, "c"), 0);
});

test("system prompt, conversation ID, role and content boundaries are part of the key", async () => {
  const { sim } = simulator();
  await sim.simulate("sys", turns(2), 200, "c");
  assert.equal(await sim.simulate("other", turns(3), 300, "c"), 0);
  assert.equal(await sim.simulate("sys", turns(3), 300, "d"), 0);
  assert.equal(await sim.simulate("sys", turns(3), 300, undefined), 0);
  assert.equal(await sim.simulate(undefined, turns(3), 300, "c"), 0);

  const roles = simulator().sim;
  await roles.simulate("sys", [user("a"), user("b")], 200, "c");
  assert.equal(await roles.simulate("sys", [user("a"), assistant("b"), user("c")], 300, "c"), 0);

  const split = simulator().sim;
  await split.simulate("sys", [user("ab"), assistant("c")], 200, "c");
  assert.equal(await split.simulate("sys", [user("a"), assistant("bc"), user("d")], 300, "c"), 0);
});

test("cache_control, block type defaults, string content and key order don't change the key", async () => {
  const { sim } = simulator();
  await sim.simulate(
    [{ text: "sys", cache_control: { type: "ephemeral" } }],
    [
      user("hello"),
      assistant([{ type: "tool_use", id: "t1", name: "Read", input: { b: 2, a: 1 } }]),
    ],
    200,
    "c",
  );
  const hit = await sim.simulate(
    "sys",
    [
      user([{ type: "text", text: "hello", cache_control: { type: "ephemeral" } }]),
      assistant([{ input: { a: 1, b: 2 }, name: "Read", id: "t1", type: "tool_use" }]),
      user("next"),
    ],
    300,
    "c",
  );
  assert.equal(hit, 200);
});

test("expired entries are skipped and a shorter live prefix still matches", async () => {
  const { clock, sim } = simulator(10_000);
  await sim.simulate("sys", turns(2), 200, "c");
  clock.advance(6_000);
  await sim.simulate("sys", turns(4), 400, "c");
  clock.advance(5_000); // turns(2) expired, turns(4) still live
  assert.equal(await sim.simulate("sys", turns(6), 600, "c"), 400);
  clock.advance(9_000);
  assert.equal(await sim.simulate("sys", turns(8), 800, "c"), 600);
  clock.advance(10_000);
  assert.equal(await sim.simulate("sys", turns(10), 1000, "c"), 0);
});

test("zero context tokens stores nothing", async () => {
  const { sim } = simulator();
  await sim.simulate("sys", turns(2), 0, "c");
  assert.equal(await sim.simulate("sys", turns(4), 400, "c"), 0);
  assert.equal(await sim.simulate("sys", [], 50, "c"), 0);
});

// ---- Differential test against a plain reference model ----

function stableStringify(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(",")}]`;
  const keys = Object.keys(value as object).sort();
  return `{${keys.map((k) => `${JSON.stringify(k)}:${stableStringify((value as any)[k])}`).join(",")}}`;
}

// Same meaning as the simulator, without hashing: an entry is the canonical
// text of a whole request, and a lookup is an exact match on a shorter prefix.
class ReferenceSimulator {
  private readonly entries = new Map<string, { tokens: number; expiresAt: number }>();
  constructor(private readonly clock: MockClock, private readonly ttlMs: number) {}

  private canonical(system: System, messages: AnthropicMessage[], id?: string): string {
    const blocks = typeof system === "string" ? [{ type: "text", text: system }] : system || [];
    const strip = ({ cache_control, ...rest }: any) => rest;
    return stableStringify({
      conversationId: id ?? null,
      system: blocks.map(({ cache_control, type = "text", ...rest }: any) => ({ type, ...rest })),
      messages: messages.map((m) => ({
        role: m.role,
        content: (typeof m.content === "string" ? [{ type: "text", text: m.content }] : m.content).map(
          (b: any) => (typeof b === "object" && b !== null ? strip(b) : b),
        ),
      })),
    });
  }

  simulate(system: System, messages: AnthropicMessage[], total: number, id?: string): number {
    const now = this.clock.now();
    if (total > 0)
      this.entries.set(this.canonical(system, messages, id), { tokens: total, expiresAt: now + this.ttlMs });
    for (let length = messages.length - 1; length >= 1; length -= 1) {
      const entry = this.entries.get(this.canonical(system, messages.slice(0, length), id));
      if (entry && now < entry.expiresAt && entry.tokens > 0) return entry.tokens;
    }
    return 0;
  }
}

function prng(seed: number) {
  return () => {
    seed = (seed * 1103515245 + 12345) & 0x7fffffff;
    return seed / 0x7fffffff;
  };
}

async function runDifferential(store: ICacheStore, clock: MockClock | null, seed: number, steps: number) {
  const ttl = 5 * 60 * 1000;
  const refClock = clock ?? new MockClock(0);
  const sim = new CacheSimulator(store, ttl);
  const ref = new ReferenceSimulator(refClock, ttl);
  const rand = prng(seed);
  const pick = <T>(items: T[]) => items[Math.floor(rand() * items.length)];
  const word = () => pick(["a", "b", "ab", "c", "", "你好", 'q"x']);
  const block = (): any =>
    pick([
      () => ({ type: "text", text: word() }),
      () => ({ type: "text", text: word(), cache_control: { type: "ephemeral" } }),
      () => ({ type: "tool_use", id: word(), name: "Read", input: { path: word(), n: 1 } }),
      () => ({ type: "tool_result", tool_use_id: word(), content: word() }),
    ])();
  const message = (role: string): AnthropicMessage =>
    ({ role, content: rand() < 0.4 ? word() : [block(), ...(rand() < 0.3 ? [block()] : [])] }) as any;

  const threads: AnthropicMessage[][] = [[]];
  const systems: System[] = ["sys", [{ text: "sys" }], [{ text: "sys", cache_control: { type: "ephemeral" } }], "other", undefined];
  for (let step = 0; step < steps; step += 1) {
    let thread = pick(threads);
    const r = rand();
    if (r < 0.15 && thread.length > 1) {
      thread = thread.slice(0, 1 + Math.floor(rand() * (thread.length - 1))); // fork
      threads.push(thread);
    } else if (r < 0.2) {
      thread = [];
      threads.push(thread);
    }
    const grow = 1 + Math.floor(rand() * 3);
    for (let i = 0; i < grow; i += 1) thread.push(message(thread.length % 2 ? "assistant" : "user"));
    const system = pick(systems);
    const id = pick(["c1", "c2", undefined]);
    const total = rand() < 0.1 ? 0 : 100 + Math.floor(rand() * 10_000);
    if (clock && rand() < 0.1) clock.advance(Math.floor(rand() * 2 * ttl));
    const messages = structuredClone(thread);
    assert.equal(
      await sim.simulate(system, messages, total, id),
      ref.simulate(system, structuredClone(thread), total, id),
      `step ${step}`,
    );
  }
}

test("simulate matches the reference model on random branching conversations", async () => {
  for (const seed of [1, 7, 42, 1234, 99991]) {
    const clock = new MockClock(0);
    await runDifferential(new InMemoryCacheStore(clock), clock, seed, 400);
  }
});

test("the SQLite store gives the same answers as the reference model", async () => {
  const database = new AppDatabase(":memory:");
  try {
    for (const seed of [3, 17, 2024]) {
      database.connection.exec("DELETE FROM cache_entries");
      await runDifferential(new SqliteCacheStore(database), null, seed, 300);
    }
  } finally {
    database.close();
  }
});
