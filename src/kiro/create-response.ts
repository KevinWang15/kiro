// Kiro's CreateResponse API (POST /v1/responses), the chat API the Kiro IDE
// uses for accounts in its create_response_api experiment.
//
// Kiro answers generateAssistantResponse for some of those accounts with 429
// USER_REQUEST_RATE_EXCEEDED on every request, while the same account works
// on CreateResponse (yetone/magpie#5703; reproduced here on 2026-11-23: same
// account, same minute, 429 on one API and 200 on the other). Like the IDE,
// the adapter reads each account's feature configuration and uses the API
// Kiro assigned it.
//
// The request is built from the generateAssistantResponse request the
// converter already produces, and the server-sent events are decoded into
// the same KiroEvents, so streaming, thinking, tools, cache simulation and
// billing work unchanged. The wire format follows Kiro IDE 1.4.121 as
// implemented by @magpie-community/opencode-kiro-auth 0.1.33+.

import { createHash, randomUUID } from "node:crypto";
import { AccountCache } from "./account-cache.ts";
import { fieldEffort } from "./model-fields.ts";
import type {
  HistoryMessage,
  KiroEvent,
  KiroRequest,
  UserInputMessage,
} from "./types.ts";

export type KiroModelApi = "generateAssistantResponse" | "createResponse";

// The IDE finds a feature in its configuration under sha256(salt + name).
const FEATURE_KEY_SALT = "kiro-feature-config-key-salt-3e9b1d7a";
export const featureConfigKey = (name: string): string =>
  createHash("sha256").update(FEATURE_KEY_SALT + name).digest("hex");
export const CREATE_RESPONSE_FEATURE_KEY = featureConfigKey("create_response_api");
export const CREATE_RESPONSE_ARM = "create_response";

export function modelApiFromFeatureConfig(
  configuration: Record<string, unknown>,
): KiroModelApi {
  return configuration[CREATE_RESPONSE_FEATURE_KEY] === CREATE_RESPONSE_ARM
    ? "createResponse"
    : "generateAssistantResponse";
}

// The IDE's ExperimentConfigService: a configuration is kept 15 minutes per
// sign-in (token and profile), retried after a minute when it can't be read,
// and must arrive within 5s; otherwise the request stays on
// generateAssistantResponse.
export const FEATURE_CONFIG_TTL_MS = 15 * 60_000;
export const FEATURE_CONFIG_RETRY_MS = 60_000;
export const FEATURE_CONFIG_TIMEOUT_MS = 5_000;

export class ModelApiSelector {
  private readonly configurations: AccountCache<Record<string, unknown>>;

  constructor(now: () => number = Date.now) {
    this.configurations = new AccountCache(
      "feature configuration",
      FEATURE_CONFIG_TTL_MS,
      FEATURE_CONFIG_RETRY_MS,
      now,
    );
  }

  async select(
    accountId: number,
    identity: string,
    load: () => Promise<Record<string, unknown>>,
  ): Promise<KiroModelApi> {
    return modelApiFromFeatureConfig(
      (await this.configurations.get(accountId, identity, load)) ?? {},
    );
  }
}

export function parseFeatureConfiguration(data: unknown): Record<string, unknown> {
  const configuration = (data as { configuration?: unknown } | null)?.configuration;
  return configuration && typeof configuration === "object" && !Array.isArray(configuration)
    ? (configuration as Record<string, unknown>)
    : {};
}

// ============================================================================
// Headers
// ============================================================================

// Kiro only reports experiment assignments to a client that names the IDE's
// agent (KAS/<version>) in its user agent; without it, featureConfiguration
// returns the defaults and no create_response_api entry. 0.66.89 is the agent
// shipped with Kiro IDE 1.4.121.
export const KIRO_AGENT_VERSION = "0.66.89";

export type KiroIdeIdentity = {
  kiroVersion: string;
  machineId: string;
  osName: string;
  osRelease: string;
  nodeVersion: string;
};

const userAgentPart = (value: string) =>
  value.replace(/[^!$%&'*+\-.^_`|~\w#]/g, "-");

function ideApp(identity: KiroIdeIdentity): string {
  return `KiroIDE-${identity.kiroVersion}-${identity.machineId}-KAS/${KIRO_AGENT_VERSION} acp-client/kiro-ide`;
}

// The IDE's KiroRuntime SDK client, which reads the feature configuration.
export function featureConfigHeaders(
  accessToken: string,
  identity: KiroIdeIdentity,
  profileArn: string | undefined,
  tokenType: string | undefined,
): Record<string, string> {
  const app = ideApp(identity);
  const headers: Record<string, string> = {
    authorization: `Bearer ${accessToken}`,
    accept: "application/json",
    "amz-sdk-invocation-id": randomUUID(),
    "amz-sdk-request": "attempt=1; max=1",
    "x-amz-user-agent": `aws-sdk-js/1.0.0 ${app}`,
    "user-agent": `aws-sdk-js/1.0.0 ua/2.1 os/${userAgentPart(identity.osName)}#${userAgentPart(identity.osRelease)} lang/js md/nodejs#${identity.nodeVersion} api/kiroruntime#1.0.0 m/N ${app}`,
    "x-amzn-kiro-client-attribution": "kiro-ide",
  };
  if (profileArn) headers["x-amzn-kiro-profile-arn"] = profileArn;
  if (tokenType) headers.tokentype = tokenType;
  return headers;
}

export function featureConfigQuery(kiroVersion: string): Record<string, string> {
  return { origin: "AI_EDITOR", version: kiroVersion };
}

// The IDE's sendCreateResponseRaw: a plain fetch with its own few headers.
export function createResponseHeaders(
  accessToken: string,
  identity: KiroIdeIdentity,
  profileArn: string | undefined,
  tokenType: string | undefined,
): Record<string, string> {
  const headers: Record<string, string> = {
    "content-type": "application/json",
    accept: "text/event-stream",
    authorization: `Bearer ${accessToken}`,
    "x-amzn-kiro-origin": "AI_EDITOR",
    "x-amzn-codewhisperer-optout": "true",
    "user-agent": ideApp(identity),
    "x-amzn-kiro-attempt": "1;max=3",
  };
  if (profileArn) headers["x-amzn-kiro-profile"] = profileArn;
  if (tokenType) headers.TokenType = tokenType;
  return headers;
}

// ============================================================================
// Request body
// ============================================================================

type ResponsesInputItem = Record<string, unknown>;

export interface CreateResponseRequest {
  model: string;
  input: ResponsesInputItem[];
  tools?: Array<Record<string, unknown>>;
  stream: true;
  origin: string;
  profileArn?: string;
  metadata: Record<string, string>;
  reasoning?: { type?: string; effort?: string };
}

function userInputItems(message: UserInputMessage): ResponsesInputItem[] {
  const items: ResponsesInputItem[] = [];
  for (const result of message.userInputMessageContext?.toolResults ?? []) {
    items.push({
      type: "function_call_output",
      call_id: result.toolUseId,
      output: result.content
        .map((part) => (typeof part.text === "string" ? part.text : JSON.stringify(part.json ?? part)))
        .join("\n"),
    });
  }
  const parts: ResponsesInputItem[] = [];
  for (const image of message.images ?? []) {
    if (!image.source?.bytes) continue;
    parts.push({
      type: "input_image",
      image_url: `data:image/${image.format.toLowerCase()};base64,${image.source.bytes}`,
    });
  }
  for (const document of message.documents ?? []) {
    if (!document.source?.bytes) continue;
    parts.push({
      type: "input_file",
      filename: `${document.name}.${document.format.toLowerCase()}`,
      file_data: `data:${documentMediaType(document.format)};base64,${document.source.bytes}`,
    });
  }
  const text = typeof message.content === "string" ? message.content : "";
  if (parts.length) {
    items.push({
      role: "user",
      content: [...(text ? [{ type: "input_text", text }] : []), ...parts],
    });
  } else if (text) {
    items.push({ role: "user", content: text });
  }
  return items;
}

function documentMediaType(format: string): string {
  const lower = format.toLowerCase();
  switch (lower) {
    case "pdf":
      return "application/pdf";
    case "txt":
      return "text/plain";
    case "md":
      return "text/markdown";
    case "csv":
      return "text/csv";
    case "html":
      return "text/html";
    default:
      return `application/${lower}`;
  }
}

function historyItems(entry: HistoryMessage): ResponsesInputItem[] {
  if ("userInputMessage" in entry) return userInputItems(entry.userInputMessage);
  const message = entry.assistantResponseMessage;
  const items: ResponsesInputItem[] = [];
  if (message.reasoningContent) {
    // The IDE replays Kiro's reasoning union as the item's encrypted content.
    items.push({ type: "reasoning", encrypted_content: JSON.stringify(message.reasoningContent) });
  }
  if (message.content) items.push({ role: "assistant", content: message.content });
  for (const toolUse of message.toolUses ?? []) {
    items.push({
      type: "function_call",
      call_id: toolUse.toolUseId,
      name: toolUse.name,
      arguments: JSON.stringify(toolUse.input ?? {}),
    });
  }
  return items;
}

// The IDE's buildCreateResponseRequest: the conversation as input items, the
// current message's tools as functions, the conversation in metadata, and the
// model fields as one `reasoning` object (its buildReasoningField). The
// system prompt stays at the head of the first user message, as the IDE sends
// it without its system_field_injection feature.
export function toCreateResponseRequest(request: KiroRequest): CreateResponseRequest {
  const state = request.conversationState;
  const current = state.currentMessage.userInputMessage;
  const input: ResponsesInputItem[] = [];
  for (const entry of state.history ?? []) input.push(...historyItems(entry));
  input.push(...userInputItems(current));
  const tools = (current.userInputMessageContext?.tools ?? []).map((tool) => ({
    type: "function",
    name: tool.toolSpecification.name,
    description: tool.toolSpecification.description,
    parameters: tool.toolSpecification.inputSchema.json,
  }));
  const fields = request.additionalModelRequestFields;
  const effort = fieldEffort(fields);
  return {
    model: current.modelId,
    input,
    ...(tools.length ? { tools } : {}),
    stream: true,
    origin: current.origin ?? "AI_EDITOR",
    ...(request.profileArn ? { profileArn: request.profileArn } : {}),
    metadata: {
      "kiro:agent_mode": state.agentTaskType ?? "vibe",
      "kiro:conversation_id": state.conversationId,
    },
    ...(fields
      ? {
          reasoning: {
            ...(fields.thinking ? { type: fields.thinking.type } : {}),
            ...(effort ? { effort } : {}),
          },
        }
      : {}),
  };
}

// ============================================================================
// Response stream
// ============================================================================

// The longest event line the IDE reads.
const MAX_LINE_LENGTH = 4 << 20;

// Incomplete-response reasons the IDE knows. content_filter is a refusal, as
// CONTENT_FILTERED is on generateAssistantResponse.
const INCOMPLETE_STOP_REASONS: Record<string, string> = {
  max_output_tokens: "max_tokens",
};

type FunctionCall = {
  callId: string;
  name: string;
  streamedArguments: boolean;
  closed: boolean;
};

function record(value: unknown): Record<string, unknown> | undefined {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

const nonEmptyString = (value: unknown): string | undefined =>
  typeof value === "string" && value.length > 0 ? value : undefined;

/**
 * Decodes CreateResponse server-sent events into the KiroEvents that
 * generateAssistantResponse's event stream produces (the IDE's
 * parseCreateResponseSse does the same mapping).
 */
export class CreateResponseDecoder {
  private buffer = "";
  private readonly decoder = new TextDecoder();
  private readonly calls = new Map<string, FunctionCall>(); // by item id and call id
  private currentCall: FunctionCall | undefined;
  private reasoningStreamed = false;
  private refusalStreamed = false;

  feed(chunk: Uint8Array): KiroEvent[] {
    this.buffer += this.decoder.decode(chunk, { stream: true });
    const lines = this.buffer.split("\n");
    this.buffer = lines.pop() ?? "";
    if (this.buffer.length > MAX_LINE_LENGTH)
      throw new Error("Kiro CreateResponse stream sent an event line over 4 MiB");
    return lines.flatMap((line) => this.line(line));
  }

  finish(): KiroEvent[] {
    this.buffer += this.decoder.decode();
    const rest = this.buffer;
    this.buffer = "";
    return rest ? this.line(rest) : [];
  }

  private line(rawLine: string): KiroEvent[] {
    const line = rawLine.replace(/\r$/, "");
    if (!line.startsWith("data:")) return [];
    const data = line.slice(5).trim();
    if (!data || data === "[DONE]") return [];
    let event: Record<string, unknown>;
    try {
      event = JSON.parse(data);
    } catch {
      throw new Error(`Kiro CreateResponse stream sent invalid JSON: ${data.slice(0, 200)}`);
    }
    return this.event(event);
  }

  private event(event: Record<string, unknown>): KiroEvent[] {
    const type = typeof event.type === "string" ? event.type : "";
    const item = record(event.item);
    switch (type) {
      case "response.output_text.delta":
        return typeof event.delta === "string" && event.delta
          ? [{ type: "assistantResponse", content: event.delta }]
          : [];

      case "response.reasoning_text.delta":
      case "response.reasoning.delta":
        if (typeof event.delta !== "string" || !event.delta) return [];
        this.reasoningStreamed = true;
        return [{ type: "reasoning", text: event.delta }];

      case "response.refusal.delta":
        if (typeof event.delta !== "string" || !event.delta) return [];
        this.refusalStreamed = true;
        return [{ type: "assistantResponse", content: event.delta }];

      case "response.refusal.done":
        return !this.refusalStreamed && nonEmptyString(event.refusal)
          ? [{ type: "assistantResponse", content: event.refusal as string }]
          : [];

      case "response.output_item.added":
        if (item?.type !== "function_call") return [];
        return this.startCall(item);

      case "response.function_call_arguments.delta": {
        const call = this.callFor(event);
        if (!call || typeof event.delta !== "string") return [];
        call.streamedArguments = true;
        return event.delta
          ? [{ type: "toolUse", data: { toolUseId: call.callId, name: call.name, input: event.delta, stop: false } }]
          : [];
      }

      case "response.function_call_arguments.done": {
        const call = this.callFor(event);
        return call ? this.closeCall(call, event.arguments) : [];
      }

      case "response.output_item.done":
        if (item?.type === "function_call") {
          const call = this.calls.get(String(item.id ?? "")) ?? this.calls.get(String(item.call_id ?? ""));
          return call ? this.closeCall(call, item.arguments) : [];
        }
        if (item?.type === "reasoning") return this.reasoningDone(item);
        return [];

      case "response.completed":
      case "response.incomplete":
        return this.completed(type, record(event.response) ?? {});

      case "error":
        return [this.failure(type, record(event.error) ?? event, event)];

      case "response.failed":
        return [this.failure(type, record(record(event.response)?.error) ?? {}, event)];

      default:
        return [];
    }
  }

  private startCall(item: Record<string, unknown>): KiroEvent[] {
    const callId = nonEmptyString(item.call_id) ?? nonEmptyString(item.id) ?? "";
    const call: FunctionCall = {
      callId,
      name: typeof item.name === "string" ? item.name : "",
      streamedArguments: false,
      closed: false,
    };
    this.calls.set(callId, call);
    if (nonEmptyString(item.id)) this.calls.set(item.id as string, call);
    this.currentCall = call;
    const initial = typeof item.arguments === "string" ? item.arguments : "";
    if (initial) call.streamedArguments = true;
    return [{ type: "toolUse", data: { toolUseId: call.callId, name: call.name, input: initial, stop: false } }];
  }

  private callFor(event: Record<string, unknown>): FunctionCall | undefined {
    const id = nonEmptyString(event.item_id) ?? nonEmptyString(event.call_id);
    return (id && this.calls.get(id)) || this.currentCall;
  }

  private closeCall(call: FunctionCall, finalArguments: unknown): KiroEvent[] {
    if (call.closed) return [];
    call.closed = true;
    if (this.currentCall === call) this.currentCall = undefined;
    const input = !call.streamedArguments && typeof finalArguments === "string" ? finalArguments : "";
    return [{ type: "toolUse", data: { toolUseId: call.callId, name: call.name, input, stop: true } }];
  }

  // The finished reasoning item carries Kiro's reasoning union, the same one
  // replayed in history: {reasoningText: {text, signature}} or
  // {redactedContent}.
  private reasoningDone(item: Record<string, unknown>): KiroEvent[] {
    let content: Record<string, unknown> | undefined;
    try {
      content = record(JSON.parse(String(item.encrypted_content)));
    } catch {
      content = undefined;
    }
    const events: KiroEvent[] = [];
    const reasoningText = record(content?.reasoningText);
    const signature = nonEmptyString(reasoningText?.signature);
    if (signature) {
      const text = !this.reasoningStreamed && typeof reasoningText?.text === "string" ? reasoningText.text : "";
      events.push({ type: "reasoning", text, signature });
    }
    const redactedContent = nonEmptyString(content?.redactedContent);
    if (redactedContent) events.push({ type: "reasoning", text: "", redactedContent });
    this.reasoningStreamed = false;
    return events;
  }

  private completed(type: string, response: Record<string, unknown>): KiroEvent[] {
    const events: KiroEvent[] = [];
    const usage = record(response.usage);
    const percentage = usage?.["kiro:context_usage_percentage"];
    if (typeof percentage === "number" && Number.isFinite(percentage))
      events.push({ type: "contextUsage", data: { percentage } });
    const credits = record(usage?.["kiro:credits"]);
    if (typeof credits?.value === "number" && Number.isFinite(credits.value))
      events.push({ type: "creditConsumption", data: { amount: credits.value } });

    const incomplete = type === "response.incomplete" || response.status === "incomplete";
    const reason = incomplete ? nonEmptyString(record(response.incomplete_details)?.reason) : undefined;
    if (reason === "content_filter") {
      events.push({
        type: "refusal",
        stopReason: "CONTENT_FILTERED",
        message: "Kiro filtered the response content",
        upstream: { eventType: type, payload: response },
      });
    } else if (incomplete && !(reason && INCOMPLETE_STOP_REASONS[reason])) {
      events.push({
        type: "error",
        errorCode: reason ?? "incomplete",
        errorMessage: `Kiro ended the response incomplete (${reason ?? "no reason given"})`,
        upstream: { eventType: type, payload: response },
      });
    } else {
      events.push({ type: "responseEnd", ...(reason ? { stopReason: INCOMPLETE_STOP_REASONS[reason] } : {}) });
    }
    return events;
  }

  private failure(
    type: string,
    error: Record<string, unknown>,
    payload: Record<string, unknown>,
  ): KiroEvent {
    const code = nonEmptyString(error.code) ?? nonEmptyString(error.type) ?? type;
    const message = nonEmptyString(error.message) ?? `CreateResponse stream failed (${code})`;
    return {
      type: "error",
      errorCode: code,
      errorMessage: message,
      upstream: { eventType: type, payload },
    };
  }
}
