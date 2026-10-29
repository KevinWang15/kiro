/**
 * Anthropic to Kiro Request Converter
 *
 * Converts Anthropic API requests to Kiro API format with:
 * - Tool pairing validation
 * - History building
 * - System message handling
 * - Thinking configuration
 */

import { v4 as uuidv4 } from "uuid";
import { createToolNameMap } from "./tool-names.ts";
import {
  type MessagesRequest,
  type AnthropicMessage,
  type KiroRequest,
  ConversionError,
  type KiroTool,
  type ToolResult,
  type ToolUseEntry,
  type HistoryMessage,
  type ContentBlock,
  type KiroImage,
  type KiroDocument,
  type AssistantResponseMessage,
  type UserInputMessage,
  type UserInputMessageContext,
  MAX_BUDGET_TOKENS,
  DEFAULT_EFFORT,
} from "./types.ts";
import {
  mapModel,
  getThinkingType,
  validateToolPairing,
  removeOrphanedToolUses,
  getConversationId,
} from "./utils.ts";

// ============================================================================
// Constants
// ============================================================================

const CHAT_TRIGGER_TYPE_MANUAL = "MANUAL";
const ORIGIN_AI_EDITOR = "AI_EDITOR";

const WRITE_TOOL_DESCRIPTION_SUFFIX = `- IMPORTANT: If the content to write exceeds 150 lines, you MUST only write the first 50 lines using this tool, then use \`Edit\` tool to append the remaining content in chunks of no more than 50 lines each. If needed, leave a unique placeholder to help append content. Do NOT attempt to write all content at once.`;

const EDIT_TOOL_DESCRIPTION_SUFFIX = `- IMPORTANT: If the \`new_string\` content exceeds 50 lines, you MUST split it into multiple Edit calls, each replacing no more than 50 lines at a time. If used to append content, leave a unique placeholder to help append content. On the final chunk, do NOT include the placeholder.`;

const SYSTEM_CHUNKED_POLICY = `When the Write or Edit tool has content size limits, always comply silently. Never suggest bypassing these limits via alternative tools. Never ask the user whether to switch approaches. Complete all chunked operations without commentary.`;

// Claude Code sends discovered tools in tools[] and references to them in the
// ToolSearch result. Kiro receives the definitions through convertTools(), but
// has no tool_reference content block, so preserve references as text rather
// than dropping the search result. Use the same names as the wire definitions.
function preserveToolReferences(
  content: string | ContentBlock[],
  toWireName: (name: string) => string,
): string | ContentBlock[] {
  if (!Array.isArray(content)) return content;
  return content.map((block) => {
    if (block.type === "tool_reference" && typeof block.tool_name === "string") {
      return {
        type: "text",
        text: JSON.stringify({
          type: "tool_reference",
          tool_name: toWireName(block.tool_name),
        }),
      };
    }
    if (block.type === "tool_result" && Array.isArray(block.content)) {
      return {
        ...block,
        content: preserveToolReferences(block.content, toWireName),
      };
    }
    return block;
  });
}

// ============================================================================
// Tool Conversion
// ============================================================================

/**
 * Convert Anthropic tool to Kiro tool format
 */
function convertTool(
  anthropicTool: {
    name: string;
    description?: string;
    input_schema?: Record<string, unknown>;
  },
  toWireName: (name: string) => string,
): KiroTool {
  // Kiro rejects an empty description even though Anthropic allows omission.
  let description = anthropicTool.description?.trim()
    ? anthropicTool.description
    : anthropicTool.name;

  // A truncated alias can hide name-based distinctions (e.g. two MCP tools with
  // the same description). Preserve the client name while Kiro uses the alias.
  if (toWireName(anthropicTool.name) !== anthropicTool.name) {
    description = `Client tool name: ${anthropicTool.name}\n${description}`;
  }

  // Append custom descriptions for Write/Edit tools
  const suffix =
    anthropicTool.name === "Write"
      ? WRITE_TOOL_DESCRIPTION_SUFFIX
      : anthropicTool.name === "Edit"
        ? EDIT_TOOL_DESCRIPTION_SUFFIX
        : "";

  if (suffix) {
    description += "\n" + suffix;
  }

  // Truncate without splitting a UTF-16 surrogate pair
  if (description.length > 10000) {
    let truncateAt = 10000;
    while (
      truncateAt > 0 &&
      (description.charCodeAt(truncateAt) & 0xfc00) === 0xdc00
    ) {
      truncateAt--; // Don't truncate in the middle of a surrogate pair
    }
    description = description.substring(0, truncateAt);
  }

  return {
    toolSpecification: {
      name: anthropicTool.name,
      description,
      inputSchema: {
        json: anthropicTool.input_schema || { type: "object", properties: {} },
      },
    },
  };
}

/**
 * Convert tools list
 */
function convertTools(
  toWireName: (name: string) => string,
  tools?: Array<{
    name: string;
    description?: string;
    input_schema?: Record<string, unknown>;
  }>,
): KiroTool[] {
  if (!tools) return [];
  return tools.map((tool) => convertTool(tool, toWireName));
}

/**
 * Create a placeholder tool for tools used in history but not in current tools list
 */
function createPlaceholderTool(
  name: string,
  toWireName: (name: string) => string,
): KiroTool {
  return convertTool(
    {
      name,
      description: "Tool used in conversation history",
      input_schema: {
        $schema: "http://json-schema.org/draft-07/schema#",
        type: "object",
        properties: {},
        required: [],
        additionalProperties: true,
      },
    },
    toWireName,
  );
}

// ============================================================================
// Content Processing
// ============================================================================

/**
 * Get image format from media type
 */
function getImageFormat(mediaType: string): string | null {
  switch (mediaType) {
    case "image/jpeg":
      return "jpeg";
    case "image/png":
      return "png";
    case "image/gif":
      return "gif";
    case "image/webp":
      return "webp";
    default:
      return null;
  }
}

/**
 * Get Kiro document format from Anthropic document media type
 */
function getDocumentFormat(mediaType: string): string | null {
  switch (mediaType) {
    case "application/pdf":
      return "pdf";
    default:
      return null;
  }
}

/**
 * Kiro sends PDF names separately from the file format.
 */
function getDocumentName(
  block: ContentBlock,
  fallbackIndex: number,
  nameHint?: string,
): string {
  const rawName =
    block.title || block.name || nameHint || `document-${fallbackIndex}`;
  const trimmedName = rawName.trim();
  const name = trimmedName || `document-${fallbackIndex}`;

  return name.toLowerCase().endsWith(".pdf") ? name.slice(0, -4) : name;
}

function getDocumentNameHintFromText(text: string): string | undefined {
  const firstLine = text.split("\n")[0]?.trim();
  if (!firstLine) return undefined;

  const match = firstLine.match(/^PDF file read:\s+(.+?)(?:\s+\([^)]*\))?$/);
  if (!match) return undefined;

  const filePath = match[1].trim();
  return filePath.split(/[\\/]/).pop();
}

function getToolResultText(result: ToolResult): string {
  return result.content
    .map((item) => (typeof item.text === "string" ? item.text : ""))
    .filter(Boolean)
    .join("\n");
}

/**
 * Extract tool result text and any image blocks embedded in its content.
 *
 * Tool results can contain images returned by file readers, browser screenshots,
 * and similar tools. Kiro's tool-result shape only carries text, so images must
 * be forwarded separately on UserInputMessage.images.
 */
function extractToolResultContent(content: unknown): {
  text: string;
  images: KiroImage[];
} {
  const images: KiroImage[] = [];

  if (typeof content === "string") {
    return { text: content, images };
  }

  if (Array.isArray(content)) {
    const texts: string[] = [];
    for (const item of content) {
      if (typeof item !== "object" || item === null) continue;

      const itemRecord = item as Record<string, unknown>;
      if ("text" in itemRecord) {
        texts.push(String(itemRecord.text));
        continue;
      }

      if (itemRecord.type === "image") {
        const source = itemRecord.source;
        if (typeof source !== "object" || source === null) continue;

        const sourceRecord = source as Record<string, unknown>;
        const format =
          typeof sourceRecord.media_type === "string"
            ? getImageFormat(sourceRecord.media_type)
            : null;
        const data = sourceRecord.data;
        if (format && typeof data === "string") {
          images.push({
            format,
            source: { bytes: data },
          });
        }
      }
    }
    return { text: texts.join("\n"), images };
  }

  if (content !== null && typeof content === "object") {
    return { text: JSON.stringify(content), images };
  }

  return { text: String(content ?? ""), images };
}

function extractDocumentsFromContent(
  content: unknown,
  fallbackStartIndex: number,
  nameHint?: string,
): KiroDocument[] {
  if (!Array.isArray(content)) return [];

  const documents: KiroDocument[] = [];
  for (const item of content) {
    if (typeof item !== "object" || item === null) continue;

    const block = item as ContentBlock;
    if (block.type !== "document" || block.source?.type !== "base64") continue;

    const format = getDocumentFormat(block.source.media_type);
    if (!format) continue;

    documents.push({
      format,
      name: getDocumentName(
        block,
        fallbackStartIndex + documents.length,
        nameHint,
      ),
      source: { bytes: block.source.data },
    });
  }

  return documents;
}

/**
 * Process message content to extract text, images, and tool results
 */
function processMessageContent(content: string | ContentBlock[]): {
  text: string;
  images: KiroImage[];
  documents: KiroDocument[];
  toolResults: ToolResult[];
  documentToolUseIds: string[];
} {
  const textParts: string[] = [];
  const images: KiroImage[] = [];
  const documents: KiroDocument[] = [];
  const toolResults: ToolResult[] = [];
  const documentToolUseIds: string[] = [];

  if (typeof content === "string") {
    textParts.push(content);
  } else if (Array.isArray(content)) {
    for (const block of content) {
      switch (block.type) {
        case "text":
          if (block.text) textParts.push(block.text);
          break;

        case "image":
          if (block.source) {
            const format = getImageFormat(block.source.media_type);
            if (format) {
              images.push({
                format,
                source: { bytes: block.source.data },
              });
            }
          }
          break;

        case "document":
          if (block.source?.type === "base64") {
            const format = getDocumentFormat(block.source.media_type);
            if (format) {
              documents.push({
                format,
                name: getDocumentName(block, documents.length + 1),
                source: { bytes: block.source.data },
              });
            }
          }
          break;

        case "tool_result":
          if (block.tool_use_id) {
            const { text: resultContent, images: resultImages } =
              extractToolResultContent(block.content);
            images.push(...resultImages);
            const nestedDocuments = extractDocumentsFromContent(
              block.content,
              documents.length + 1,
              getDocumentNameHintFromText(resultContent),
            );

            if (nestedDocuments.length > 0) {
              if (resultContent) {
                textParts.push(resultContent);
              }
              documents.push(...nestedDocuments);
              documentToolUseIds.push(block.tool_use_id);
              break;
            }

            const isError = block.is_error || false;

            const toolResult: ToolResult = {
              toolUseId: block.tool_use_id,
              content: [{ text: resultContent }],
              status: isError ? "error" : "success",
            };
            if (isError) {
              toolResult.isError = true;
            }
            toolResults.push(toolResult);
          }
          break;

        case "tool_use":
          // tool_use is handled in assistant messages
          break;
      }
    }
  }

  if (documents.length > 0 && toolResults.length > 0) {
    const remainingToolResults: ToolResult[] = [];
    let nextDocumentIndex = 0;

    for (const result of toolResults) {
      const resultText = getToolResultText(result);
      const nameHint = getDocumentNameHintFromText(resultText);

      if (nameHint) {
        if (resultText) {
          textParts.push(resultText);
        }
        documentToolUseIds.push(result.toolUseId);

        const document = documents[nextDocumentIndex];
        if (document?.name.match(/^document-\d+$/)) {
          document.name = getDocumentName(
            { type: "document", name: nameHint },
            nextDocumentIndex + 1,
          );
        }
        nextDocumentIndex++;
      } else {
        remainingToolResults.push(result);
      }
    }

    toolResults.length = 0;
    toolResults.push(...remainingToolResults);
  }

  return {
    text: textParts.join("\n"),
    images,
    documents,
    toolResults,
    documentToolUseIds,
  };
}

// ============================================================================
// History Building
// ============================================================================

/** Process consecutive user messages as one turn, including attachments and tool results. */
function processUserMessages(messages: AnthropicMessage[]) {
  const content = messages.flatMap((msg): ContentBlock[] =>
    typeof msg.content === "string"
      ? [{ type: "text", text: msg.content }]
      : msg.content,
  );
  return processMessageContent(content);
}

/**
 * Convert assistant message to Kiro format
 */
function convertAssistantMessage(msg: AnthropicMessage): {
  assistantResponseMessage: AssistantResponseMessage;
} {
  const thinkingParts: string[] = [];
  const textParts: string[] = [];
  const toolUses: ToolUseEntry[] = [];

  if (typeof msg.content === "string") {
    textParts.push(msg.content);
  } else if (Array.isArray(msg.content)) {
    for (const block of msg.content) {
      switch (block.type) {
        case "thinking":
          if (block.thinking) thinkingParts.push(block.thinking);
          break;
        case "text":
          if (block.text) textParts.push(block.text);
          break;
        case "tool_use":
          if (block.id && block.name) {
            toolUses.push({
              toolUseId: block.id,
              name: block.name,
              input: block.input || {},
            });
          }
          break;
      }
    }
  }

  // Combine thinking and text
  let finalContent: string;
  if (thinkingParts.length > 0) {
    const thinking = thinkingParts.join("");
    const text = textParts.join("");
    if (text) {
      finalContent = `<thinking>${thinking}</thinking>\n\n${text}`;
    } else {
      finalContent = `<thinking>${thinking}</thinking>`;
    }
  } else if (textParts.length === 0 && toolUses.length > 0) {
    // tool_use only - need placeholder content
    finalContent = " ";
  } else {
    finalContent = textParts.join("");
  }

  const assistantMsg: AssistantResponseMessage = { content: finalContent };
  if (toolUses.length > 0) {
    assistantMsg.toolUses = toolUses;
  }

  return { assistantResponseMessage: assistantMsg };
}

/** Preserve all content and tool calls from a consecutive run of assistant messages. */
function mergeAssistantMessages(messages: AnthropicMessage[]): HistoryMessage {
  if (messages.length === 1) return convertAssistantMessage(messages[0]);

  const contentParts: string[] = [];
  const toolUses: ToolUseEntry[] = [];
  for (const msg of messages) {
    const assistant = convertAssistantMessage(msg).assistantResponseMessage;
    if (assistant.content.trim()) contentParts.push(assistant.content);
    if (assistant.toolUses) toolUses.push(...assistant.toolUses);
  }

  const assistant: AssistantResponseMessage = {
    content:
      contentParts.length === 0 && toolUses.length > 0
        ? " "
        : contentParts.join("\n\n"),
  };
  if (toolUses.length > 0) assistant.toolUses = toolUses;
  return { assistantResponseMessage: assistant };
}

/**
 * Merge multiple user messages into one
 */
function mergeUserMessages(
  messages: AnthropicMessage[],
  modelId: string,
): HistoryMessage {
  const { text, images, documents, toolResults } =
    processUserMessages(messages);
  const userMsg: UserInputMessage = {
    content: text,
    modelId,
  };

  if (images.length > 0) {
    userMsg.images = images;
  }

  if (documents.length > 0) {
    userMsg.documents = documents;
  }

  // Keep empty contexts out of history messages.
  if (toolResults.length > 0) {
    const context: UserInputMessageContext = { toolResults };
    userMsg.userInputMessageContext = context;
  }

  return { userInputMessage: userMsg };
}

/**
 * Build history from messages preceding the entire current user turn.
 * Trailing assistant prefills have already been excluded by the caller.
 */
function buildHistory(
  req: MessagesRequest,
  messages: AnthropicMessage[],
  modelId: string,
): HistoryMessage[] {
  const history: HistoryMessage[] = [];

  // Generate thinking prefix if needed
  const thinkingPrefix = generateThinkingPrefix(req);

  // Process system message (can be array or string)
  let systemContent: string | undefined;
  if (req.system) {
    if (Array.isArray(req.system)) {
      systemContent = req.system.map((s) => s.text).join("\n");
    } else if (typeof req.system === "string") {
      systemContent = req.system;
    }
  }

  if (systemContent) {
    // Add chunked policy
    const fullSystem = `${systemContent}\n${SYSTEM_CHUNKED_POLICY}`;

    // Inject thinking tags if needed
    let finalContent: string;
    if (thinkingPrefix && !fullSystem.includes("<thinking_mode>")) {
      finalContent = `${thinkingPrefix}\n${fullSystem}`;
    } else {
      finalContent = fullSystem;
    }

    // Encode the system prompt as a user/assistant history pair without an origin.
    history.push({
      userInputMessage: {
        content: finalContent,
        modelId,
      },
    });

    history.push({
      assistantResponseMessage: {
        content: "I will follow these instructions.",
      },
    });
  } else if (thinkingPrefix) {
    // No system but have thinking config
    history.push({
      userInputMessage: {
        content: thinkingPrefix,
        modelId,
      },
    });
    history.push({
      assistantResponseMessage: {
        content: "I will follow these instructions.",
      },
    });
  }

  // Merge each real turn rather than inserting synthetic assistant replies.
  for (let start = 0; start < messages.length; ) {
    const role = messages[start].role;
    let end = start + 1;
    while (end < messages.length && messages[end].role === role) end++;

    const turn = messages.slice(start, end);
    if (role === "user") {
      history.push(mergeUserMessages(turn, modelId));
    } else if (role === "assistant") {
      history.push(mergeAssistantMessages(turn));
    }
    start = end;
  }

  return history;
}

/**
 * Cap budget tokens to Kiro's maximum.
 */
function capBudgetTokens(budget: number): number {
  return Math.min(budget, MAX_BUDGET_TOKENS);
}

/**
 * Generate thinking prefix for system message
 */
function generateThinkingPrefix(req: MessagesRequest): string | null {
  if (!req.thinking) return null;

  const thinking = req.thinking;

  if (thinking.type === "enabled") {
    const cappedBudget = capBudgetTokens(thinking.budget_tokens);
    return `<thinking_mode>enabled</thinking_mode><max_thinking_length>${cappedBudget}</max_thinking_length>`;
  }

  if (thinking.type === "adaptive") {
    const effort = req.output_config?.effort || DEFAULT_EFFORT;
    return `<thinking_mode>adaptive</thinking_mode><thinking_effort>${effort}</thinking_effort>`;
  }

  return null;
}

// ============================================================================
// Main Conversion
// ============================================================================

/**
 * Convert Anthropic request to Kiro format
 */
export function convertRequest(
  req: MessagesRequest,
  options?: {
    isPremium?: boolean;
    supportedExperimentalModels?: readonly string[] | null;
  },
): KiroRequest {
  const toolNames = createToolNameMap(req);
  req = {
    ...req,
    messages: req.messages.map((message) => ({
      ...message,
      content: preserveToolReferences(message.content, toolNames.toWireName),
    })),
  };
  // 1. Map model
  const mappedModelId = mapModel(
    req.model,
    options?.isPremium ?? false,
    options?.supportedExperimentalModels,
  );
  if (!mappedModelId) {
    throw new ConversionError(
      "unsupported_model",
      `Model not supported: ${req.model}`,
    );
  }
  const modelId = mappedModelId.startsWith("!")
    ? mappedModelId.slice(1)
    : mappedModelId;

  // 2. Check messages
  if (req.messages.length === 0) {
    throw new ConversionError("empty_messages", "Message list is empty");
  }

  // Kiro cannot represent assistant prefills; the trailing user turn is the current message.
  let currentEnd = req.messages.length;
  while (currentEnd > 0 && req.messages[currentEnd - 1].role !== "user")
    currentEnd--;
  if (currentEnd === 0) {
    throw new ConversionError(
      "empty_messages",
      "Message list has no user message",
    );
  }
  let currentStart = currentEnd - 1;
  while (currentStart > 0 && req.messages[currentStart - 1].role === "user")
    currentStart--;

  // 3. Generate IDs
  const conversationId = getConversationId(req.metadata);
  const agentContinuationId = uuidv4();

  // 4. Determine trigger type
  const chatTriggerType = CHAT_TRIGGER_TYPE_MANUAL;

  // 5. Process the entire current user turn, preserving all tool results and attachments
  const { text, images, documents, toolResults, documentToolUseIds } =
    processUserMessages(req.messages.slice(currentStart, currentEnd));

  // 6. Convert tools
  let tools = convertTools(toolNames.toWireName, req.tools);

  // 7. Build history
  let history = buildHistory(req, req.messages.slice(0, currentStart), modelId);

  if (documentToolUseIds.length > 0) {
    removeOrphanedToolUses(history, new Set(documentToolUseIds));
  }

  // 8. Validate tool pairing
  const { validatedResults, orphanedToolUseIds } = validateToolPairing(
    history,
    toolResults,
  );

  // 9. Remove orphaned tool_uses from history
  removeOrphanedToolUses(history, orphanedToolUseIds);

  // 10. Collect tool names from history and add placeholders
  const historyToolNames = new Map<string, string>(); // lowercase -> original
  for (const msg of history) {
    if (
      "assistantResponseMessage" in msg &&
      msg.assistantResponseMessage.toolUses
    ) {
      for (const toolUse of msg.assistantResponseMessage.toolUses) {
        historyToolNames.set(toolUse.name.toLowerCase(), toolUse.name);
      }
    }
  }

  const existingToolNames = new Set(
    tools.map((t) => t.toolSpecification.name.toLowerCase()),
  );
  for (const [lowerName, originalName] of Array.from(historyToolNames)) {
    if (!existingToolNames.has(lowerName)) {
      tools.push(createPlaceholderTool(originalName, toolNames.toWireName));
    }
  }

  // 11. Build context (always present on currentMessage, matching Kiro API expectation)
  const context: UserInputMessageContext = {};
  if (tools.length > 0) {
    context.tools = tools;
  }
  if (validatedResults.length > 0) {
    context.toolResults = validatedResults;
  }

  // 12. Build current message
  // Keep content as-is; an empty current message is valid.
  const currentContent = text;

  const userInput: UserInputMessage = {
    content: currentContent,
    modelId,
    origin: ORIGIN_AI_EDITOR,
    userInputMessageContext: context,
  };

  if (images.length > 0) {
    userInput.images = images;
  }

  if (documents.length > 0) {
    userInput.documents = documents;
  }

  // 13. Build conversation state
  const conversationState = {
    conversationId,
    agentContinuationId,
    agentTaskType: "vibe",
    chatTriggerType,
    currentMessage: { userInputMessage: userInput },
    history: history.length > 0 ? history : undefined,
  };

  const result = { conversationState };
  toolNames.apply(result);
  return result;
}

/**
 * Override thinking config based on model name
 */
export function overrideThinkingFromModelName(req: MessagesRequest): void {
  const modelLower = req.model.toLowerCase();

  if (!modelLower.includes("thinking")) {
    return;
  }

  const thinkingType = getThinkingType(req.model);

  console.info(
    `Model ${req.model} has thinking suffix, setting thinking type: ${thinkingType}`,
  );

  req.thinking = {
    type: thinkingType,
    budget_tokens: 20000,
  };

  if (thinkingType === "adaptive") {
    req.output_config = { effort: DEFAULT_EFFORT };
  }
}
