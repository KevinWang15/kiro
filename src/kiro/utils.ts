/**
 * Utility Functions for Kiro Handler
 *
 * Includes:
 * - Thinking tag detection
 * - Tool pairing validation
 * - Session ID extraction
 * - UTF-16-safe string operations
 */

import { v4 as uuidv4 } from "uuid";
import { type ToolResult, type HistoryMessage } from "./types.ts";


// ============================================================================
// Thinking Tag Detection
// ============================================================================

/**
 * Characters that wrap tags when used in code/quoted contexts
 * Real thinking tags should NOT be wrapped by these
 */
// A tag counts as quoted (mentioned, not used) when it is wrapped in a
// matching pair of quotes or backticks, e.g. `<thinking>` or "</thinking>".
// Ordinary punctuation next to a tag ("prime.</thinking>") does not count.
const QUOTE_PAIRS: Record<string, string> = { "`": "`", '"': '"', "'": "'", "“": "”", "‘": "’" };

function isWrappedInQuotes(buffer: string, pos: number, tagLength: number): boolean {
  const open = buffer[pos - 1];
  const close = QUOTE_PAIRS[open];
  return close !== undefined && buffer[pos + tagLength] === close;
}

// Inside a fenced code block (an odd number of ``` fences before pos).
function isInsideCodeFence(buffer: string, pos: number): boolean {
  return ((buffer.slice(0, pos).match(/```/g) || []).length) % 2 === 1;
}

function isQuotedTag(buffer: string, pos: number, tagLength: number): boolean {
  return isWrappedInQuotes(buffer, pos, tagLength) || isInsideCodeFence(buffer, pos);
}

/**
 * Split a complete Kiro reply into its thinking and answer text, the same way
 * the streaming path does: one leading <thinking>…</thinking> block (found with
 * the same tag-detection helpers), one newline after <thinking> dropped, the
 * blank line after </thinking> dropped. Text before the block stays in the
 * answer. If the closing tag never arrives, everything after <thinking> is
 * thinking (the reply was cut off mid-reasoning).
 */
export function splitThinking(content: string): { thinking: string; text: string } {
  const start = findRealThinkingStartTag(content);
  if (start === null) return { thinking: "", text: content };
  const before = content.slice(0, start);
  let rest = content.slice(start + "<thinking>".length);
  if (rest.startsWith("\n")) rest = rest.slice(1);
  const end = findRealThinkingEndTag(rest) ?? findRealThinkingEndTagAtBufferEnd(rest);
  if (end === null) return { thinking: rest, text: before.trim() ? before : "" };
  const thinking = rest.slice(0, end);
  let after = rest.slice(end + "</thinking>".length);
  after = after.replace(/^\n{1,2}/, "");
  const text = before.trim() ? before + after : after;
  return { thinking, text };
}

/**
 * Find the real <thinking> start tag: the first one not quoted (see
 * isQuotedTag), e.g. `<thinking>`, "<thinking>" or one inside a code fence.
 */
export function findRealThinkingStartTag(buffer: string): number | null {
  const TAG = "<thinking>";
  let searchStart = 0;

  while (true) {
    const pos = buffer.indexOf(TAG, searchStart);
    if (pos === -1) return null;

    if (!isQuotedTag(buffer, pos, TAG.length)) {
      return pos;
    }

    // Skip and continue searching
    searchStart = pos + 1;
  }
}

/**
 * Find the real </thinking> end tag while text is still arriving: not quoted
 * (see isQuotedTag) and followed by a blank line (\n\n). Returns null until
 * enough text has arrived to tell.
 */
export function findRealThinkingEndTag(buffer: string): number | null {
  const TAG = "</thinking>";
  let searchStart = 0;

  while (true) {
    const pos = buffer.indexOf(TAG, searchStart);
    if (pos === -1) return null;

    if (isQuotedTag(buffer, pos, TAG.length)) {
      searchStart = pos + 1;
      continue;
    }

    // Check if followed by double newline
    const afterPos = pos + TAG.length;
    const afterContent = buffer.substring(afterPos);

    // If not enough content to check, wait for more
    if (afterContent.length < 2) {
      return null;
    }

    // Real end tag must be followed by \n\n
    if (afterContent.startsWith("\n\n")) {
      return pos;
    }

    searchStart = pos + 1;
  }
}

/**
 * Find the real </thinking> end tag once no more text is coming (end of reply,
 * or a tool call starts): not quoted and followed only by whitespace.
 */
export function findRealThinkingEndTagAtBufferEnd(
  buffer: string,
): number | null {
  const TAG = "</thinking>";
  let searchStart = 0;

  while (true) {
    const pos = buffer.indexOf(TAG, searchStart);
    if (pos === -1) return null;

    if (isQuotedTag(buffer, pos, TAG.length)) {
      searchStart = pos + 1;
      continue;
    }

    // Check if followed only by whitespace
    const afterPos = pos + TAG.length;
    const afterContent = buffer.substring(afterPos);

    if (afterContent.trim().length === 0) {
      return pos;
    }

    searchStart = pos + 1;
  }
}

/**
 * Find a safe UTF-16 code-unit boundary for slicing
 *
 * Prevents slicing in the middle of a surrogate pair
 */
export function findCharBoundary(s: string, target: number): number {
  if (target >= s.length) return s.length;
  if (target <= 0) return 0;

  // For JavaScript strings (UTF-16), character boundaries are at each code unit
  // except when we have surrogate pairs (4-byte UTF-16 sequences for code points > U+FFFF)
  // If we're in the middle of a surrogate pair (low surrogate), move back

  const char = s.charCodeAt(target);
  // Low surrogate range: 0xDC00 - 0xDFFF
  // If we're at a low surrogate, the actual boundary is one position back
  if (char >= 0xdc00 && char <= 0xdfff && target > 0) {
    // Check if the previous character is a high surrogate
    const prev = s.charCodeAt(target - 1);
    if (prev >= 0xd800 && prev <= 0xdbff) {
      return target - 1;
    }
  }

  return target;
}

// ============================================================================
// Session ID Extraction
// ============================================================================

/**
 * Extract session UUID from user_id
 *
 * Claude Code format: user_xxx_account__session_uuid
 * Example: user_0dede..._account__session_8bb5523b-ec7c-4540-a9ca-beb6d79f1552
 */
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * Claude Code's session ID from metadata.user_id. Two formats exist:
 *   JSON:   {"device_id":"…","account_uuid":"…","session_id":"<uuid>"}   (current)
 *   legacy: user_<hash>_account_<uuid>_session_<uuid>
 */
export function extractSessionId(userId: string): string | null {
  const trimmed = userId.trim();
  if (trimmed.startsWith("{")) {
    try {
      const sessionId = JSON.parse(trimmed)?.session_id;
      return typeof sessionId === "string" && UUID_PATTERN.test(sessionId) ? sessionId : null;
    } catch {
      return null;
    }
  }
  const match = /session_([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})/i.exec(trimmed);
  return match ? match[1] : null;
}

/**
 * Generate or extract conversation ID
 */
export function getConversationId(metadata?: { user_id?: string }): string {
  if (metadata?.user_id) {
    const sessionId = extractSessionId(metadata.user_id);
    if (sessionId) return sessionId;
  }
  return uuidv4();
}

// ============================================================================
// Tool Pairing Validation
// ============================================================================

/**
 * Collect all tool_use_ids from history messages
 */
export function collectToolUseIdsFromHistory(
  history: HistoryMessage[],
): Set<string> {
  const ids = new Set<string>();

  for (const msg of history) {
    if ("assistantResponseMessage" in msg) {
      const toolUses = msg.assistantResponseMessage.toolUses;
      if (toolUses) {
        for (const toolUse of toolUses) {
          ids.add(toolUse.toolUseId);
        }
      }
    }
  }

  return ids;
}

/**
 * Collect tool_use_ids that already have results in history
 */
export function collectToolResultIdsFromHistory(
  history: HistoryMessage[],
): Set<string> {
  const ids = new Set<string>();

  for (const msg of history) {
    if ("userInputMessage" in msg) {
      const results = msg.userInputMessage.userInputMessageContext?.toolResults;
      if (results) {
        for (const result of results) {
          ids.add(result.toolUseId);
        }
      }
    }
  }

  return ids;
}

/**
 * Validate tool_use/tool_result pairing
 *
 * Returns:
 * - validatedResults: tool_results that have matching tool_uses
 * - orphanedToolUseIds: tool_use_ids without matching tool_results
 */
export function validateToolPairing(
  history: HistoryMessage[],
  currentToolResults: ToolResult[],
): {
  validatedResults: ToolResult[];
  orphanedToolUseIds: Set<string>;
} {
  const allToolUseIds = collectToolUseIdsFromHistory(history);
  const historyToolResultIds = collectToolResultIdsFromHistory(history);

  // Find unpaired tool_uses (not yet have results)
  const unpairedToolUseIds = new Set<string>();
  for (const id of Array.from(allToolUseIds)) {
    if (!historyToolResultIds.has(id)) {
      unpairedToolUseIds.add(id);
    }
  }

  // Filter current tool_results
  const validatedResults: ToolResult[] = [];

  for (const result of currentToolResults) {
    if (unpairedToolUseIds.has(result.toolUseId)) {
      // Valid pairing
      validatedResults.push(result);
      unpairedToolUseIds.delete(result.toolUseId);
    } else if (allToolUseIds.has(result.toolUseId)) {
      // Duplicate - tool_use already has result in history
      console.warn(
        `Skipping duplicate tool_result: tool_use_id=${result.toolUseId}`,
      );
    } else {
      // Orphaned - no matching tool_use
      console.warn(
        `Skipping orphaned tool_result: no matching tool_use, tool_use_id=${result.toolUseId}`,
      );
    }
  }

  // Log orphaned tool_uses
  for (const orphanedId of Array.from(unpairedToolUseIds)) {
    console.warn(
      `Detected orphaned tool_use: no matching tool_result, tool_use_id=${orphanedId}`,
    );
  }

  return { validatedResults, orphanedToolUseIds: unpairedToolUseIds };
}

/**
 * Remove orphaned tool_uses from history
 *
 * Kiro API requires every tool_use to have a matching tool_result
 */
export function removeOrphanedToolUses(
  history: HistoryMessage[],
  orphanedIds: Set<string>,
): void {
  if (orphanedIds.size === 0) return;

  for (const msg of history) {
    if ("assistantResponseMessage" in msg) {
      const toolUses = msg.assistantResponseMessage.toolUses;
      if (toolUses) {
        const originalLen = toolUses.length;
        const filtered = toolUses.filter(
          (tu) => !orphanedIds.has(tu.toolUseId),
        );

        if (filtered.length === 0) {
          delete msg.assistantResponseMessage.toolUses;
        } else if (filtered.length !== originalLen) {
          msg.assistantResponseMessage.toolUses = filtered;
          console.debug(
            `Removed ${originalLen - filtered.length} orphaned tool_uses from history`,
          );
        }
      }
    }
  }
}

// ============================================================================
// Model Mapping
// ============================================================================

function normalizeExperimentalModelName(model: string): string {
  return model.trim().toLowerCase();
}

function toDottedClaudeVersionAlias(model: string): string | null {
  // Only used as an extra supportedExperimentalModels lookup key.
  const trimmed = model.trim();
  const match = /^(claude-.+)-(\d{1,2})-(\d{1,2})(?:-[^-]+)?$/i.exec(trimmed);
  return match ? `${match[1]}-${match[2]}.${match[3]}` : null;
}

export function getSupportedKiroExperimentalModelId(
  model: string,
  supportedExperimentalModels?: readonly string[] | null,
): string | null {
  if (
    !Array.isArray(supportedExperimentalModels) ||
    supportedExperimentalModels.length === 0
  ) {
    return null;
  }

  const candidates = [model];
  const dottedAlias = toDottedClaudeVersionAlias(model);
  if (dottedAlias) {
    candidates.push(dottedAlias);
  }

  for (const candidate of candidates) {
    const normalizedCandidate = normalizeExperimentalModelName(candidate);
    const supported = supportedExperimentalModels.some(
      (supportedModel) =>
        typeof supportedModel === "string" &&
        normalizeExperimentalModelName(supportedModel) === normalizedCandidate,
    );
    if (supported) {
      return candidate;
    }
  }

  return null;
}

export function supportsKiroExperimentalModel(
  model: string,
  supportedExperimentalModels?: readonly string[] | null,
): boolean {
  return (
    getSupportedKiroExperimentalModelId(model, supportedExperimentalModels) !==
    null
  );
}

/**
 * Translate an Anthropic model name to the Kiro model ID for the same model.
 *
 * This only rewrites the name format (dashes to a dotted version, date
 * suffix dropped); it never swaps in a different model. If Kiro doesn't
 * serve the requested model, its own error is returned to the client.
 *   claude-opus-4-6-20260101  -> claude-opus-4.6
 *   claude-sonnet-4-5         -> claude-sonnet-4.5
 *   claude-opus-5-5           -> claude-opus-5.5
 *   !<id>                     -> <id> sent as-is (escape hatch)
 */
export function mapModel(
  model: string,
  supportedExperimentalModels?: readonly string[] | null,
): string | null {
  if (typeof model !== "string" || !model.trim()) return null;
  if (model.startsWith("!")) return model;
  const supported = getSupportedKiroExperimentalModelId(
    model,
    supportedExperimentalModels,
  );
  if (supported) return supported;
  return toKiroModelId(model);
}

/** "claude-<family>-<major>-<minor>[-<date>]" -> "claude-<family>-<major>.<minor>". */
export function toKiroModelId(model: string): string {
  const trimmed = model.trim().toLowerCase();
  const match = /^(claude-[a-z]+)-(\d{1,2})[-.](\d{1,2})(?:-\d{8})?$/.exec(trimmed);
  if (match) return `${match[1]}-${match[2]}.${match[3]}`;
  // Already dotted, or a single-number version, with an optional date suffix.
  return trimmed.replace(/-\d{8}$/, "");
}

/**
 * Determine thinking type based on model
 * - Opus 4.6: adaptive
 * - Others: enabled
 */
export function getThinkingType(model: string): "enabled" | "adaptive" {
  const lower = model.toLowerCase();
  const isOpus46 =
    lower.includes("opus") && (lower.includes("4-6") || lower.includes("4.6"));
  return isOpus46 ? "adaptive" : "enabled";
}
