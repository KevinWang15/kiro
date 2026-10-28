// Claude per-million-token pricing. Cache creation and cache reads have
// distinct rates for each model.
export interface ModelPricing {
  input: number;
  output: number;
  cache_read: number;
  cache_creation: number;
}

// Claude API pricing in USD per million tokens.
// Cache read = 0.1x input, 5-min cache write = 1.25x input.
// More-specific patterns must come before broader ones (first match wins).
// Source: https://docs.anthropic.com/en/docs/about-claude/pricing
export const CLAUDE_PRICING: [pattern: string, pricing: ModelPricing][] = [
  // Fable 5 ($10/$50), twice Opus 4.5+.
  [
    "fable",
    { input: 10.0, output: 50.0, cache_read: 1.0, cache_creation: 12.5 },
  ],
  // Opus 4.5+ ($5/$25)
  [
    "opus-4-6",
    { input: 5.0, output: 25.0, cache_read: 0.5, cache_creation: 6.25 },
  ],
  [
    "opus-4-5",
    { input: 5.0, output: 25.0, cache_read: 0.5, cache_creation: 6.25 },
  ],
  // Opus 5.5 ($4/$20), 20% below Opus 5 / Opus 4.5+ rates; cache read = 5% of input.
  [
    "opus-5-5",
    { input: 4.0, output: 20.0, cache_read: 0.2, cache_creation: 5.0 },
  ],
  ["opus", { input: 5.0, output: 25.0, cache_read: 0.5, cache_creation: 6.25 }],
  // Sonnet 5 / 5.5 ($2/$10); the September 2026 increase to $3/$15 was cancelled.
  // Sonnet 5.5 cache reads were halved to $0.10 on October 7, 2026.
  [
    "sonnet-5-5",
    { input: 2.0, output: 10.0, cache_read: 0.1, cache_creation: 2.5 },
  ],
  [
    "sonnet-5",
    { input: 2.0, output: 10.0, cache_read: 0.2, cache_creation: 2.5 },
  ],
  // Sonnet 4.x models ($3/$15)
  [
    "sonnet",
    { input: 3.0, output: 15.0, cache_read: 0.3, cache_creation: 3.75 },
  ],
  // Haiku 5.5 short prompts ($0.10/$0.50); prompts over 100K total input tokens
  // bill at the long-prompt tier in CLAUDE_LONG_PROMPT_PRICING.
  [
    "haiku-5-5",
    { input: 0.1, output: 0.5, cache_read: 0.01, cache_creation: 0.125 },
  ],
  // Haiku 4.5 ($1/$5)
  ["haiku", { input: 1.0, output: 5.0, cache_read: 0.1, cache_creation: 1.25 }],
];

// Models with a prompt-size price cliff: when the total prompt (uncached +
// cache reads + cache writes) exceeds the threshold, all token types bill at
// these rates. Cache rates follow Anthropic's conventions (read = 10% and
// write = 125% of the tier's input rate).
export const CLAUDE_LONG_PROMPT_PRICING: [
  pattern: string,
  threshold: number,
  pricing: ModelPricing,
][] = [
  // Haiku 5.5: prompts over 100K tokens bill at $0.50/$2.50.
  [
    "haiku-5-5",
    100_000,
    { input: 0.5, output: 2.5, cache_read: 0.05, cache_creation: 0.625 },
  ],
];

export interface UsageTokens {
  input_tokens: number;
  output_tokens: number;
  cache_read_input_tokens: number;
  cache_creation_input_tokens: number;
}

export interface CostBreakdown {
  input_cost_usd: number;
  output_cost_usd: number;
  cache_read_cost_usd: number;
  cache_creation_cost_usd: number;
  total_cost_usd: number;
}

export function calculateClaudeCost(
  model: string,
  usage: UsageTokens,
): CostBreakdown {
  const lower = model.toLowerCase();
  let pricing: ModelPricing | undefined;

  // Check more-specific keys first, then broader ones (first match wins)
  for (const [pattern, value] of CLAUDE_PRICING) {
    if (lower.includes(pattern)) {
      pricing = value;
      break;
    }
  }
  if (!pricing) {
    console.warn(`No pricing found for model: ${model}`);
    return {
      input_cost_usd: 0,
      output_cost_usd: 0,
      cache_read_cost_usd: 0,
      cache_creation_cost_usd: 0,
      total_cost_usd: 0,
    };
  }

  // Prompt-size price cliffs apply when the total prompt (uncached + cache
  // reads + cache writes) exceeds the model's threshold.
  const totalInputTokens =
    usage.input_tokens +
    usage.cache_read_input_tokens +
    usage.cache_creation_input_tokens;
  for (const [
    pattern,
    threshold,
    longPromptPricing,
  ] of CLAUDE_LONG_PROMPT_PRICING) {
    if (lower.includes(pattern) && totalInputTokens > threshold) {
      pricing = longPromptPricing;
      break;
    }
  }

  const input_cost_usd = (usage.input_tokens / 1_000_000) * pricing.input;
  const output_cost_usd = (usage.output_tokens / 1_000_000) * pricing.output;
  const cache_read_cost_usd =
    (usage.cache_read_input_tokens / 1_000_000) * pricing.cache_read;
  const cache_creation_cost_usd =
    (usage.cache_creation_input_tokens / 1_000_000) * pricing.cache_creation;

  const total_cost_usd =
    input_cost_usd +
    output_cost_usd +
    cache_read_cost_usd +
    cache_creation_cost_usd;

  return {
    input_cost_usd: Math.round(input_cost_usd * 1_000_000) / 1_000_000, // Round to 6 decimal places
    output_cost_usd: Math.round(output_cost_usd * 1_000_000) / 1_000_000,
    cache_read_cost_usd:
      Math.round(cache_read_cost_usd * 1_000_000) / 1_000_000,
    cache_creation_cost_usd:
      Math.round(cache_creation_cost_usd * 1_000_000) / 1_000_000,
    total_cost_usd: Math.round(total_cost_usd * 1_000_000) / 1_000_000,
  };
}
