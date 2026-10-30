/**
 * Kiro API Type Definitions
 *
 * Defines the types for Kiro API requests/responses and Anthropic compatibility
 */

// ============================================================================
// Anthropic API Types
// ============================================================================

export interface AnthropicMessage {
  role: string;
  content: string | ContentBlock[];
}

export interface ContentBlock {
  type: string;
  text?: string;
  thinking?: string;
  tool_use_id?: string;
  tool_name?: string;
  content?: string | ContentBlock[];
  name?: string;
  title?: string;
  input?: Record<string, unknown>;
  id?: string;
  is_error?: boolean;
  source?: ImageSource;
}

export interface ImageSource {
  type: string;
  media_type: string;
  data: string;
}

export interface AnthropicTool {
  name: string;
  description?: string;
  input_schema?: Record<string, unknown>;
  defer_loading?: boolean;
}

export interface SystemMessage {
  text: string;
  cache_control?: { type: string };
}

export const MAX_BUDGET_TOKENS = 24576;

export interface ThinkingConfig {
  type: string;
  budget_tokens: number;
  /** "omitted" asks for thinking blocks without their text. */
  display?: string;
}

/**
 * Check if thinking is enabled (either 'enabled' or 'adaptive' type)
 */
export function isThinkingEnabled(
  thinking: ThinkingConfig | undefined,
): boolean {
  if (!thinking) return false;
  return thinking.type === "enabled" || thinking.type === "adaptive";
}

/**
 * The thinking display the client gets: what it asked for, else the model's
 * default. Per the Anthropic docs, "omitted" is the default on Claude 5
 * models, Opus 4.7/4.8 and Mythos; older models default to "summarized".
 */
export function resolveThinkingDisplay(
  model: string,
  thinking: ThinkingConfig | undefined,
): string {
  if (thinking?.display) return thinking.display;
  const name = model.toLowerCase();
  if (name.includes("mythos")) return "omitted";
  const match = /claude-[a-z]+-(\d+)(?:[-.](\d{1,2})(?!\d))?/.exec(name);
  if (!match) return "summarized";
  const major = Number(match[1]);
  const minor = Number(match[2] ?? 0);
  const omitted = major >= 5 || (major === 4 && minor >= 7 && name.includes("opus"));
  return omitted ? "omitted" : "summarized";
}

export interface OutputConfig {
  effort: string;
}

/**
 * Default effort level for adaptive thinking
 */
export const DEFAULT_EFFORT = "high";

export interface Metadata {
  user_id?: string;
}

export interface MessagesRequest {
  model: string;
  max_tokens?: number;
  messages: AnthropicMessage[];
  stream?: boolean;
  system?: SystemMessage[] | string;
  tools?: AnthropicTool[];
  tool_choice?: unknown;
  thinking?: ThinkingConfig;
  output_config?: OutputConfig;
  metadata?: Metadata;
}

// ============================================================================
// Kiro API Types
// ============================================================================

export interface KiroRequest {
  conversationState: ConversationState;
  profileArn?: string;
}

export interface ConversationState {
  conversationId: string;
  agentContinuationId?: string;
  agentTaskType?: string;
  chatTriggerType: string;
  currentMessage: CurrentMessage;
  history?: HistoryMessage[];
}

export interface CurrentMessage {
  userInputMessage: UserInputMessage;
}

export interface UserInputMessage {
  content: string;
  modelId: string;
  origin?: string;
  images?: KiroImage[];
  documents?: KiroDocument[];
  userInputMessageContext?: UserInputMessageContext;
}

export interface UserInputMessageContext {
  tools?: KiroTool[];
  toolResults?: ToolResult[];
}

export interface KiroImage {
  format: string;
  source: {
    bytes: string;
  };
}

export interface KiroDocument {
  format: string;
  name: string;
  source: {
    bytes: string;
  };
}

export interface KiroTool {
  toolSpecification: {
    name: string;
    description: string;
    inputSchema: {
      json: Record<string, unknown>;
    };
  };
}

export interface ToolResult {
  toolUseId: string;
  content: Array<Record<string, unknown>>;
  status?: string;
  isError?: boolean;
}

export interface ToolUseEntry {
  toolUseId: string;
  name: string;
  input: Record<string, unknown>;
}

export type HistoryMessage =
  | { userInputMessage: UserInputMessage }
  | { assistantResponseMessage: AssistantResponseMessage };

export interface AssistantResponseMessage {
  content: string;
  toolUses?: ToolUseEntry[];
}

// ============================================================================
// Event Stream Types
// ============================================================================

export type KiroEvent =
  | { type: "assistantResponse"; content: string }
  | { type: "toolUse"; data: ToolUseEvent }
  | { type: "reasoning"; text: string; signature?: string }
  | { type: "contextUsage"; data: { percentage: number } }
  | { type: "creditConsumption"; data: { amount: number } }
  | { type: "error"; errorCode: string; errorMessage: string }
  | { type: "exception"; exceptionType: string; message: string };

export interface ToolUseEvent {
  name: string;
  toolUseId: string;
  input: string;
  stop: boolean;
}

// ============================================================================
// SSE Types
// ============================================================================

export interface SseEvent {
  event: string;
  data: Record<string, unknown>;
}

export interface BlockState {
  blockType: string;
  started: boolean;
  stopped: boolean;
}

export interface CountTokensResponse {
  input_tokens: number;
}

export class ConversionError extends Error {
  constructor(
    public readonly code: "unsupported_model" | "empty_messages",
    message: string,
  ) {
    super(message);
    this.name = "ConversionError";
  }
}
