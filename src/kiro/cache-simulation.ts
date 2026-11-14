import * as crypto from "node:crypto";
import { type AnthropicMessage, type SystemMessage } from "./types.ts";

export interface IClock {
  now(): number;
}

export interface ICacheStore {
  get(key: string): Promise<number | null>;
  set(key: string, tokenCount: number, ttlMs: number): Promise<void>;
  /** Live entries among `keys`; missing or expired keys are left out. */
  getMany(keys: string[]): Promise<Map<string, number>>;
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

  async getMany(keys: string[]): Promise<Map<string, number>> {
    const found = new Map<string, number>();
    for (const key of keys) {
      const tokenCount = await this.get(key);
      if (tokenCount !== null) found.set(key, tokenCount);
    }
    return found;
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

// hashes[k] identifies the conversation ID, system prompt and first k
// messages. Each hash chains the previous one (fixed-length hex) with the next
// message, so all prefixes cost one pass over the conversation.
function computePrefixHashes(
  system: SystemMessage[] | string | undefined,
  messages: AnthropicMessage[],
  conversationId?: string,
): string[] {
  let hash = crypto
    .createHash("sha256")
    .update(
      stableStringify({
        conversationId: conversationId ?? null,
        system: normalizeSystem(system),
      }),
    )
    .digest("hex");
  const hashes = [hash];
  for (const message of messages) {
    hash = crypto
      .createHash("sha256")
      .update(hash)
      .update(
        stableStringify({
          role: message.role,
          content: normalizeContent(message.content as string | unknown[]),
        }),
      )
      .digest("hex");
    hashes.push(hash);
  }
  return hashes;
}

export function computePrefixHash(
  system: SystemMessage[] | string | undefined,
  messages: AnthropicMessage[],
  conversationId?: string,
): string {
  return computePrefixHashes(system, messages, conversationId).at(-1)!;
}

export const CACHE_KEY_PREFIX = "kiro_cache_sim:";
// Same as Anthropic's default prompt cache lifetime.
export const STANDARD_CACHE_TTL_MS = 5 * 60 * 1000;

export class CacheSimulator {
  constructor(
    private readonly store: ICacheStore,
    private readonly ttlMs: number = STANDARD_CACHE_TTL_MS,
  ) {}

  async simulate(
    system: SystemMessage[] | string | undefined,
    messages: AnthropicMessage[],
    totalContextTokens: number,
    conversationId?: string,
  ): Promise<number> {
    const keys = computePrefixHashes(system, messages, conversationId).map(
      (hash) => CACHE_KEY_PREFIX + hash,
    );
    if (totalContextTokens > 0) {
      const fullKey = keys[messages.length];
      try {
        await this.store.set(fullKey, totalContextTokens, this.ttlMs);
      } catch (error) {
        console.warn("[CacheSimulator] Failed to store cache hash:", error);
      }
    }

    // Prefixes shorter than the request, longest first.
    const candidates = keys.slice(1, messages.length).reverse();
    let found: Map<string, number>;
    try {
      found = await this.store.getMany(candidates);
    } catch (error) {
      console.warn("[CacheSimulator] Cache lookup failed:", error);
      return 0;
    }
    for (const key of candidates) {
      const storedTokens = found.get(key);
      if (storedTokens !== undefined && storedTokens > 0) return storedTokens;
    }
    return 0;
  }
}
