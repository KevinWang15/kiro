import {
  type AnthropicMessage,
  type AnthropicTool,
  type ContentBlock,
  type CountTokensResponse,
  type MessagesRequest,
  type SystemMessage,
} from "./types.ts";
import { renderToolReferences } from "./tool-references.ts";

export type KiroThinkingTokenPercentRange = readonly [number, number];

/**
 * Check if a character is a non-Western character (CJK, Arabic, etc.)
 *
 * Western characters include:
 * - Basic ASCII (U+0000..U+007F)
 * - Latin Extended-A/B (U+0080..U+024F)
 * - Latin Extended Additional (U+1E00..U+1EFF)
 */
function isNonWesternChar(char: string): boolean {
  const code = char.codePointAt(0) || 0;

  // Basic ASCII
  if (code <= 0x007f) return false;
  // Latin Extended-A
  if (code >= 0x0080 && code <= 0x00ff) return false;
  // Latin Extended-B
  if (code >= 0x0100 && code <= 0x024f) return false;
  // Latin Extended Additional
  if (code >= 0x1e00 && code <= 0x1eff) return false;
  // Latin Extended-C/D/E
  if (code >= 0x2c60 && code <= 0x2c7f) return false;
  if (code >= 0xa720 && code <= 0xa7ff) return false;
  if (code >= 0xab30 && code <= 0xab6f) return false;

  return true;
}

export function estimateTokens(text: string): number {
  if (!text) return 0;
  let charUnits = 0;
  for (const char of text) charUnits += isNonWesternChar(char) ? 4 : 1;
  return Math.ceil((charUnits / 4) * 1.3);
}

/**
 * Extract text content from a message
 */
function extractTextFromContent(
  content: string | unknown[],
  toolsByName: ReadonlyMap<string, AnthropicTool> = new Map(),
): string {
  if (typeof content === "string") {
    return content;
  }

  if (!Array.isArray(content)) return "";

  const texts: string[] = [];
  for (const item of content) {
    if (typeof item === "object" && item !== null) {
      const block = item as Record<string, unknown>;
      if (block.type === "text" && typeof block.text === "string") {
        texts.push(block.text);
      } else if (
        block.type === "tool_reference" &&
        typeof block.tool_name === "string"
      ) {
        // Count what convertRequest() actually sends: the expanded definition.
        texts.push(
          renderToolReferences(
            [{ type: "tool_reference", tool_name: block.tool_name }],
            toolsByName,
            (name) => name,
          ),
        );
      } else if (block.type === "tool_use") {
        if (typeof block.name === "string") texts.push(block.name);
        if (block.input) texts.push(JSON.stringify(block.input));
      } else if (block.type === "tool_result") {
        if (typeof block.content === "string") {
          texts.push(block.content);
        } else if (Array.isArray(block.content)) {
          texts.push(extractTextFromContent(block.content, toolsByName));
        }
      }
    }
  }
  return texts.join(" ");
}

/**
 * Estimate input tokens from a complete request
 */
export function estimateInputTokens(
  system: SystemMessage[] | string | undefined,
  messages: AnthropicMessage[],
  tools: AnthropicTool[] | undefined,
): number {
  let total = 0;

  // System messages
  if (system) {
    if (typeof system === "string") {
      total += estimateTokens(system);
    } else {
      for (const msg of system) {
        total += estimateTokens(msg.text);
      }
    }
  }

  // User messages
  const toolsByName = new Map((tools || []).map((tool) => [tool.name, tool]));
  for (const msg of messages) {
    total += estimateTokens(extractTextFromContent(msg.content, toolsByName));
  }

  // Tools
  if (tools) {
    for (const tool of tools) {
      total += estimateTokens(tool.name);
      total += estimateTokens(tool.description || "");
      const schemaJson = JSON.stringify(tool.input_schema || {});
      total += estimateTokens(schemaJson);
    }
  }

  return Math.max(total, 1);
}

/**
 * Add a uniformly random thinking-token percentage to Kiro's estimated output.
 */
export type KiroThinkingTokenSimulationResult = {
  originalOutputTokens: number;
  randomPercent: number;
  addedThinkingTokens: number;
  finalOutputTokens: number;
  status: "disabled" | "no_output" | "applied" | "skipped_unsafe";
};

export function calculateKiroThinkingTokenSimulation(
  originalOutputTokens: number,
  [low, upper]: KiroThinkingTokenPercentRange,
  random: () => number = Math.random,
): KiroThinkingTokenSimulationResult {
  if (low === 0 && upper === 0) {
    return {
      originalOutputTokens,
      randomPercent: 0,
      addedThinkingTokens: 0,
      finalOutputTokens: originalOutputTokens,
      status: "disabled",
    };
  }

  if (originalOutputTokens <= 0) {
    return {
      originalOutputTokens,
      randomPercent: 0,
      addedThinkingTokens: 0,
      finalOutputTokens: originalOutputTokens,
      status: "no_output",
    };
  }

  const randomUnit = random();
  const boundedRandomUnit = Number.isFinite(randomUnit)
    ? Math.min(1, Math.max(0, randomUnit))
    : 0;
  const randomPercent = low + (upper - low) * boundedRandomUnit;
  const candidateOutputTokens = Math.round(
    originalOutputTokens * (1 + randomPercent / 100),
  );
  const isSafe =
    Number.isSafeInteger(candidateOutputTokens) &&
    candidateOutputTokens >= originalOutputTokens;
  const finalOutputTokens = isSafe
    ? candidateOutputTokens
    : originalOutputTokens;

  return {
    originalOutputTokens,
    randomPercent,
    addedThinkingTokens: finalOutputTokens - originalOutputTokens,
    finalOutputTokens,
    status: isSafe ? "applied" : "skipped_unsafe",
  };
}

// Explicit 200K Claude models from https://kiro.dev/docs/models/.
// Unknown models use 1M by operator policy; this is a fallback assumption,
// not automatic discovery of future model context windows.
const KIRO_200K_TOKEN_MODELS = new Set([
  "claude-opus-4-5",
  "claude-sonnet-4",
  "claude-sonnet-4-0",
  "claude-sonnet-4-5",
  "claude-haiku-4-5",
]);

/**
 * Calculate total context tokens (input + output combined) from Kiro's
 * contextUsagePercentage. Use the actual upstream model ID, after routing or
 * fallback, because the percentage is relative to that model's full window.
 */
export function calculateTotalContextTokens(
  percentage: number | null,
  model: string,
): number {
  if (percentage === null || !Number.isFinite(percentage) || percentage <= 0)
    return 0;
  const normalizedModel = model
    .trim()
    .toLowerCase()
    .replace(/^!/, "")
    .replace(/-thinking$/, "")
    .replace(/-\d{8}$/, "")
    .replace(/\./g, "-");
  const contextWindowSize = KIRO_200K_TOKEN_MODELS.has(normalizedModel)
    ? 200_000
    : 1_000_000;
  return Math.round((percentage * contextWindowSize) / 100);
}

export function handleCountTokensRequest(
  req: Pick<MessagesRequest, "model" | "messages" | "system" | "tools">,
): CountTokensResponse {
  const systemMessages =
    typeof req.system === "string" ? [{ text: req.system }] : req.system;
  return {
    input_tokens: Math.max(
      estimateInputTokens(systemMessages, req.messages, req.tools),
      1,
    ),
  };
}
