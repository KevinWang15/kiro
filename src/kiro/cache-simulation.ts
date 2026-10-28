import * as crypto from "node:crypto";
import { AnthropicMessage, SystemMessage } from "./types.js";

export interface IClock {
  now(): number;
}

export interface ICacheStore {
  get(key: string): Promise<number | null>;
  set(key: string, tokenCount: number, ttlMs: number): Promise<void>;
}

export class SystemClock implements IClock {
  now(): number {
    return Date.now();
  }
}

export class MockClock implements IClock {
  private time: number;

  constructor(initialTime = 0) {
    this.time = initialTime;
  }

  now(): number {
    return this.time;
  }

  advance(ms: number): void {
    this.time += ms;
  }

  set(time: number): void {
    this.time = time;
  }
}

export class InMemoryCacheStore implements ICacheStore {
  private readonly entries = new Map<
    string,
    { tokenCount: number; expireAtMs: number }
  >();

  constructor(private readonly clock: IClock) {}

  async get(key: string): Promise<number | null> {
    const entry = this.entries.get(key);
    if (!entry) return null;
    if (this.clock.now() >= entry.expireAtMs) {
      this.entries.delete(key);
      return null;
    }
    return entry.tokenCount;
  }

  async set(key: string, tokenCount: number, ttlMs: number): Promise<void> {
    this.entries.set(key, { tokenCount, expireAtMs: this.clock.now() + ttlMs });
  }
}

function stableStringify(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(",")}]`;
  const keys = Object.keys(value as Record<string, unknown>).sort();
  return `{${keys.map((key) => `${JSON.stringify(key)}:${stableStringify((value as Record<string, unknown>)[key])}`).join(",")}}`;
}

function normalizeSystem(
  system: SystemMessage[] | string | undefined,
): unknown {
  if (!system) return [];
  const blocks: Record<string, unknown>[] =
    typeof system === "string"
      ? [{ type: "text", text: system }]
      : (system as unknown as Record<string, unknown>[]);
  return blocks.map(({ cache_control, type = "text", ...rest }) => {
    void cache_control;
    return { type, ...rest };
  });
}

function normalizeContent(content: string | unknown[]): unknown {
  const blocks: unknown[] =
    typeof content === "string"
      ? [{ type: "text", text: content }]
      : (content as unknown[]);
  return blocks.map((block) => {
    if (typeof block === "object" && block !== null) {
      const { cache_control, ...rest } = block as Record<string, unknown>;
      void cache_control;
      return rest;
    }
    return block;
  });
}

export function computePrefixHash(
  system: SystemMessage[] | string | undefined,
  messages: AnthropicMessage[],
  conversationId?: string,
): string {
  const canonical = {
    conversationId: conversationId ?? null,
    system: normalizeSystem(system),
    messages: messages.map((message) => ({
      role: message.role,
      content: normalizeContent(message.content as string | unknown[]),
    })),
  };
  return crypto
    .createHash("sha256")
    .update(stableStringify(canonical))
    .digest("hex");
}

export const CACHE_KEY_PREFIX = "kiro_cache_sim:";
export const STANDARD_CACHE_TTL_MS = 3 * 60 * 1000;

export function isPreferentialKiroCacheEnabled(
  env: NodeJS.ProcessEnv = process.env,
): boolean {
  return env.PREFERENTIAL_KIRO_CACHE?.trim().toLowerCase() === "true";
}

export function resolveDefaultCacheTtlMs(
  env: NodeJS.ProcessEnv = process.env,
): number {
  return isPreferentialKiroCacheEnabled(env)
    ? 60 * 1000
    : STANDARD_CACHE_TTL_MS;
}

export class CacheSimulator {
  constructor(
    private readonly store: ICacheStore,
    private readonly ttlMs: number = resolveDefaultCacheTtlMs(),
  ) {}

  async simulate(
    system: SystemMessage[] | string | undefined,
    messages: AnthropicMessage[],
    totalContextTokens: number,
    conversationId?: string,
  ): Promise<number> {
    if (totalContextTokens > 0) {
      const fullKey =
        CACHE_KEY_PREFIX + computePrefixHash(system, messages, conversationId);
      try {
        if (Math.random() < (isPreferentialKiroCacheEnabled() ? 0.35 : 0.6)) {
          await this.store.set(fullKey, totalContextTokens, this.ttlMs);
        }
      } catch (error) {
        console.warn("[CacheSimulator] Failed to store cache hash:", error);
      }
    }

    for (let length = messages.length - 1; length >= 1; length -= 1) {
      const key =
        CACHE_KEY_PREFIX +
        computePrefixHash(system, messages.slice(0, length), conversationId);
      try {
        const storedTokens = await this.store.get(key);
        if (storedTokens !== null && storedTokens > 0) return storedTokens;
      } catch (error) {
        console.warn("[CacheSimulator] Cache lookup failed:", error);
        break;
      }
    }
    return 0;
  }
}
