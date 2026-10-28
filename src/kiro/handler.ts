import { v4 as uuidv4 } from "uuid";
import * as crypto from "crypto";
import * as os from "os";
import type { ProviderExtraConfig } from "./provider.js";
import {
  isThinkingEnabled,
  KiroEvent,
  KiroRequest,
  MessagesRequest,
  SseEvent,
} from "./types.js";
import { EventStreamDecoder, parseEventPayload } from "./parser.js";
import { convertRequest, overrideThinkingFromModelName } from "./converter.js";
import {
  calculateKiroThinkingTokenSimulation,
  calculateTotalContextTokens,
  estimateInputTokens,
  estimateTokens,
} from "./token.js";
import {
  CacheSimulator,
  InMemoryCacheStore,
  SystemClock,
  isPreferentialKiroCacheEnabled,
} from "./cache-simulation.js";
import {
  BufferedStreamContext,
  sseEventToString,
  StreamContext,
} from "./stream.js";
import { getConversationId } from "./utils.js";
import { calculateClaudeCost } from "../usage/pricing.js";
import { getKiroRuntimeHost } from "./constants.js";
import { config } from "../config.js";
import { isExternalIdpAccount } from "../accounts/credential-utils.js";

// ============================================================================
// Constants
// ============================================================================

const KIRO_VERSION = "0.9.2";

const KIRO_INPUT_TOO_LONG_PATTERNS = [
  /\bprompt is too long\b/i,
  /\binput is too long\b/i,
  /\binput too long\b/i,
] as const;
const KIRO_IMPROPERLY_FORMED_REQUEST_PATTERNS = [
  /\bimproperly formed request\b/i,
] as const;

type KiroToolUse = { id: string; name: string; input: Record<string, unknown> };

type KiroAnalysisResult = {
  content: Array<Record<string, unknown>>;
  toolUses: KiroToolUse[];
  stopReason: string;
  inputTokens: number;
  outputTokens: number;
  cacheReadInputTokens: number;
  cacheCreationInputTokens: number;
  costHeaders: Record<string, string>;
};

export type KiroStreamSink = {
  onChunk: (chunk: string) => Promise<void> | void;
};

export type KiroStreamResult = {
  internalHeaders: Record<string, string>;
};

export type KiroUnrecoverableErrorReason =
  | "input_too_long"
  | "improperly_formed_request";

function isKiroFailureEvent(
  event: KiroEvent,
): event is Extract<KiroEvent, { type: "error" | "exception" }> {
  return event.type === "error" || event.type === "exception";
}

function getKiroFailureMessage(
  event: Extract<KiroEvent, { type: "error" | "exception" }>,
): string {
  if (event.type === "error") {
    const details = event.errorMessage ? `: ${event.errorMessage}` : "";
    return `Kiro upstream error ${event.errorCode}${details}`;
  }

  const details = event.message ? `: ${event.message}` : "";
  return `Kiro upstream exception ${event.exceptionType}${details}`;
}

function buildAnthropicInvalidRequestError(
  message: string,
): Record<string, unknown> {
  return {
    type: "error",
    error: {
      type: "invalid_request_error",
      message,
    },
  };
}

const ANTHROPIC_BILLING_HEADER_LINE_PATTERN =
  /(x-anthropic-billing-header\s*:\s*)([^\r\n]*)/gi;
const CCH_BILLING_HEADER_PARAM_PATTERN = /^cch\s*=/i;

function stripCchFromAnthropicBillingHeaderText(text: string): string {
  return text.replace(
    ANTHROPIC_BILLING_HEADER_LINE_PATTERN,
    (match, prefix, value) => {
      let removed = false;
      const keptParams = String(value)
        .split(";")
        .map((param) => param.trim())
        .filter((param) => {
          if (!param) return false;
          if (CCH_BILLING_HEADER_PARAM_PATTERN.test(param)) {
            removed = true;
            return false;
          }
          return true;
        });

      if (!removed) return match;
      return keptParams.length > 0
        ? `${prefix}${keptParams.join("; ")};`
        : prefix;
    },
  );
}

export function sanitizePreferentialKiroCacheRequestBody(
  requestBody: MessagesRequest,
): void {
  if (!isPreferentialKiroCacheEnabled()) return;

  if (typeof requestBody.system === "string") {
    requestBody.system = stripCchFromAnthropicBillingHeaderText(
      requestBody.system,
    );
    return;
  }

  if (!Array.isArray(requestBody.system)) return;

  for (const systemBlock of requestBody.system) {
    if (typeof systemBlock?.text === "string") {
      systemBlock.text = stripCchFromAnthropicBillingHeaderText(
        systemBlock.text,
      );
    }
  }
}

// ============================================================================
// Utility Functions
// ============================================================================

/**
 * Generate machine ID from config
 */
export function generateMachineId(config: ProviderExtraConfig | null): string {
  // Use refreshToken (unique per user session) to avoid all users sharing the same machineId.
  // clientId is an application ID shared across all IdC users — not suitable as a fingerprint.
  const uniqueKey = config?.refreshToken
    ? `KotlinNativeAPI/${config.refreshToken}`
    : config?.clientIdHash || "KIRO_DEFAULT_MACHINE";
  return crypto.createHash("sha256").update(uniqueKey).digest("hex");
}

/**
 * Get system runtime info
 */
export function getSystemRuntimeInfo(): {
  osName: string;
  nodeVersion: string;
} {
  const osPlatform = os.platform();
  const nodeVersion = process.version.replace("v", "");

  return { osName: osPlatform, nodeVersion };
}

function isExternalIdpConfig(
  extraConfig?: ProviderExtraConfig | null,
): boolean {
  return isExternalIdpAccount(extraConfig || {});
}

/**
 * Build request headers (shared between streaming API and getUsageLimits)
 * Supports different API modes via apiName parameter
 */
export function buildHeaders(
  apiKey: string,
  extraConfig?: ProviderExtraConfig | null,
  apiName: "streaming" | "usageLimits" = "streaming",
): Record<string, string> {
  const kiroVersion = KIRO_VERSION;
  const machineId = generateMachineId(extraConfig || null);
  const { osName, nodeVersion } = getSystemRuntimeInfo();

  // Different headers for different API endpoints
  const headers: Record<string, string> = {
    authorization: `Bearer ${apiKey}`,
    host: getKiroRuntimeHost(extraConfig),
    "amz-sdk-invocation-id": uuidv4(),
    connection: "close",
  };

  headers["x-amz-user-agent"] =
    `aws-sdk-js/1.0.27 KiroIDE-${kiroVersion}-${machineId}`;
  headers["user-agent"] =
    `aws-sdk-js/1.0.27 ua/2.1 os/${osName} lang/js md/nodejs#${nodeVersion} api/codewhispererstreaming#1.0.27 m/E KiroIDE-${kiroVersion}-${machineId}`;

  const authMethod = extraConfig?.authMethod?.trim().toLowerCase();
  if (authMethod === "api_key" || authMethod === "apikey") {
    headers.tokentype = "API_KEY";
  } else if (isExternalIdpConfig(extraConfig)) {
    headers.TokenType = "EXTERNAL_IDP";
  }

  if (apiName === "usageLimits") {
    // Headers for getUsageLimits API
    headers["amz-sdk-request"] = "attempt=1; max=1";
  } else {
    // Headers for streaming API (default)
    headers["content-type"] = "application/json";
    headers["x-amzn-codewhisperer-optout"] = "true";
    headers["x-amzn-kiro-agent-mode"] = "vibe";
    headers["amz-sdk-request"] = "attempt=1; max=3";
  }

  return headers;
}

/**
 * Ensure the model is a Claude model
 */
function ensureClaudeModel(model?: string): void {
  if (!model || !model.toLowerCase().includes("claude")) {
    throw new Error("Kiro provider only supports Claude models.");
  }
}

function stringifyKiroErrorPayload(response?: unknown, error?: string): string {
  const parts: string[] = [];

  if (typeof error === "string" && error.trim()) {
    parts.push(error);
  }

  if (Buffer.isBuffer(response)) {
    parts.push(response.toString("utf-8"));
  } else if (typeof response === "string") {
    parts.push(response);
  } else if (response !== undefined && response !== null) {
    try {
      parts.push(JSON.stringify(response));
    } catch {
      // Ignore serialization errors and fall back to what we already have.
    }
  }

  return parts.join(" ");
}

export function getKiroUnrecoverableErrorReason(
  statusCode?: number | null,
  response?: unknown,
  error?: string,
): KiroUnrecoverableErrorReason | undefined {
  if (statusCode != null && (statusCode < 400 || statusCode >= 500)) {
    return undefined;
  }

  const payload = stringifyKiroErrorPayload(response, error);
  if (!payload) return undefined;

  if (KIRO_INPUT_TOO_LONG_PATTERNS.some((pattern) => pattern.test(payload))) {
    return "input_too_long";
  }

  if (
    KIRO_IMPROPERLY_FORMED_REQUEST_PATTERNS.some((pattern) =>
      pattern.test(payload),
    )
  ) {
    return "improperly_formed_request";
  }

  return undefined;
}

// ============================================================================
// Response Building
// ============================================================================

/**
 * Build Anthropic message response (non-streaming)
 */
function buildClaudeMessage(
  content: Array<Record<string, unknown>>,
  toolUses: Array<{ id: string; name: string; input: Record<string, unknown> }>,
  model: string,
  inputTokens: number,
  cacheCreationInputTokens: number,
  outputTokens: number,
  stopReason: string,
  cacheReadInputTokens: number = 0,
): Record<string, unknown> {
  const messageId = `msg_${uuidv4().replace(/-/g, "")}`;

  const responseContent: Array<Record<string, unknown>> = [...content];

  // Add tool uses
  for (const toolUse of toolUses) {
    responseContent.push({
      type: "tool_use",
      id: toolUse.id,
      name: toolUse.name,
      input: toolUse.input,
    });
  }

  return {
    id: messageId,
    type: "message",
    role: "assistant",
    model,
    stop_reason: stopReason,
    stop_sequence: null,
    usage: {
      input_tokens: inputTokens,
      output_tokens: outputTokens,
      cache_creation_input_tokens: cacheCreationInputTokens,
      cache_read_input_tokens: cacheReadInputTokens,
    },
    content: responseContent,
  };
}

// ============================================================================
// Main Handler Class
// ============================================================================

export default class KiroApiProviderHandler {
  private readonly cacheSimulator: CacheSimulator;

  constructor(cacheSimulator?: CacheSimulator) {
    this.cacheSimulator =
      cacheSimulator ??
      new CacheSimulator(new InMemoryCacheStore(new SystemClock()));
  }

  /**
   * Build request headers
   */
  buildHeaders(
    apiKey: string,
    extraConfig?: ProviderExtraConfig | null,
  ): Record<string, string> {
    return buildHeaders(apiKey, extraConfig, "streaming");
  }

  /**
   * Transform Anthropic request to Kiro request
   */
  transformRequestBody(
    originalBody: MessagesRequest,
    extraConfig: ProviderExtraConfig | null,
  ): KiroRequest {
    sanitizePreferentialKiroCacheRequestBody(originalBody);
    ensureClaudeModel(originalBody?.model);

    // Override thinking config from model name if needed
    overrideThinkingFromModelName(originalBody);

    const result = convertRequest(originalBody, {
      isPremium: extraConfig?.isPremium ?? false,
      supportedExperimentalModels: extraConfig?.supportedExperimentalModels,
    });

    const request: KiroRequest = {
      conversationState: result.conversationState,
    };

    if (extraConfig?.profileArn) {
      request.profileArn = extraConfig.profileArn;
    }

    return request;
  }

  private decodeEvents(responseBody: Buffer | string): KiroEvent[] {
    const decoder = new EventStreamDecoder();

    if (Buffer.isBuffer(responseBody)) {
      decoder.feed(responseBody);
    } else {
      decoder.feed(Buffer.from(responseBody, "utf-8"));
    }

    const frames = decoder.decodeAll();
    const events: KiroEvent[] = [];

    for (const frame of frames) {
      const event = parseEventPayload(frame.payload, frame.headers);
      if (event) events.push(event);
    }

    return events;
  }

  private async analyzeEvents(
    events: KiroEvent[],
    requestBody: MessagesRequest,
    modifiedRequestBody: KiroRequest,
  ): Promise<KiroAnalysisResult> {
    let textContent = "";
    const toolUses: KiroToolUse[] = [];
    let hasToolUse = false;
    let stopReason = "end_turn";
    let contextTotalTokens: number | null = null;
    let creditConsumption: number | null = null;

    const toolJsonBuffers = new Map<string, string>();

    for (const event of events) {
      switch (event.type) {
        case "assistantResponse":
          textContent += event.content;
          break;

        case "toolUse": {
          hasToolUse = true;
          const buffer = toolJsonBuffers.get(event.data.toolUseId) || "";
          toolJsonBuffers.set(event.data.toolUseId, buffer + event.data.input);

          if (event.data.stop) {
            const fullInput = toolJsonBuffers.get(event.data.toolUseId) || "{}";
            let input: Record<string, unknown>;
            try {
              input = JSON.parse(fullInput);
            } catch {
              input = {};
            }

            toolUses.push({
              id: event.data.toolUseId,
              name: event.data.name,
              input,
            });
          }
          break;
        }

        case "contextUsage":
          if (event.data.percentage > 0) {
            contextTotalTokens = calculateTotalContextTokens(
              event.data.percentage,
              modifiedRequestBody.conversationState.currentMessage
                .userInputMessage.modelId,
            );
          }
          if (event.data.percentage >= 100) {
            stopReason = "model_context_window_exceeded";
          }
          break;

        case "creditConsumption":
          creditConsumption = event.data.amount;
          break;

        case "exception":
        case "error":
          throw new Error(getKiroFailureMessage(event));
      }
    }

    if (hasToolUse && stopReason === "end_turn") {
      stopReason = "tool_use";
    }

    const content: Array<Record<string, unknown>> = [];
    if (textContent.trim()) {
      content.push({ type: "text", text: textContent });
    }

    const totalContextTokens = contextTotalTokens ?? 0;
    const conversationId = getConversationId(requestBody.metadata);
    const prevTotalContextTokens = await this.cacheSimulator.simulate(
      requestBody.system,
      requestBody.messages,
      totalContextTokens,
      conversationId,
    );

    let cacheCreationInputTokens: number;
    let cacheReadInputTokens: number;
    let inputTokens: number;
    let outputTokens: number;

    const N = requestBody.messages.length;
    const sysEst = estimateInputTokens(
      requestBody.system,
      [],
      requestBody.tools,
    );
    const newMsgEst = estimateInputTokens(
      undefined,
      [requestBody.messages[N - 1]],
      undefined,
    );

    let prevTurnEst = 0;
    if (N >= 3) {
      prevTurnEst = estimateInputTokens(
        undefined,
        requestBody.messages.slice(N - 3, N - 1),
        undefined,
      );
    }

    let histEst = 0;
    if (N >= 5) {
      histEst = estimateInputTokens(
        undefined,
        requestBody.messages.slice(0, N - 3),
        undefined,
      );
    }

    const outputTextEst = estimateTokens(textContent);
    const outputToolEst = toolUses.reduce(
      (sum, tu) => sum + estimateTokens(JSON.stringify(tu.input)),
      0,
    );
    const outEst = outputTextEst + outputToolEst;

    if (totalContextTokens > 0) {
      const prevTotal = prevTotalContextTokens;
      const delta = Math.max(0, totalContextTokens - prevTotal);

      if (prevTotal === 0) {
        outputTokens = outEst;
        const remainingInput = Math.max(0, delta - outputTokens);

        const inputSideEst = sysEst + histEst + prevTurnEst + newMsgEst;
        if (inputSideEst > 0) {
          inputTokens = Math.round((remainingInput * newMsgEst) / inputSideEst);
          cacheCreationInputTokens = Math.max(0, remainingInput - inputTokens);
        } else {
          cacheCreationInputTokens = remainingInput;
          inputTokens = 0;
        }
        cacheReadInputTokens = 0;
      } else {
        const newTotalEst = newMsgEst + outEst;
        if (newTotalEst > 0) {
          outputTokens = Math.round((delta * outEst) / newTotalEst);
          inputTokens = Math.max(0, delta - outputTokens);
        } else {
          outputTokens = 0;
          inputTokens = delta;
        }

        const readEst = sysEst + histEst;
        const creationEst = prevTurnEst;
        const cachedTotalEst = readEst + creationEst;

        if (cachedTotalEst > 0) {
          cacheReadInputTokens = Math.round(
            (prevTotal * readEst) / cachedTotalEst,
          );
          cacheCreationInputTokens = Math.max(
            0,
            prevTotal - cacheReadInputTokens,
          );
        } else {
          cacheReadInputTokens = prevTotal;
          cacheCreationInputTokens = 0;
        }
      }
    } else {
      outputTokens = outEst;
      inputTokens = newMsgEst;

      if (N === 1) {
        cacheReadInputTokens = 0;
        cacheCreationInputTokens = sysEst;
      } else {
        cacheReadInputTokens = sysEst + histEst;
        cacheCreationInputTokens = prevTurnEst;
      }
    }

    inputTokens = Math.max(1, inputTokens);
    const thinkingTokenRange = config.thinkingTokenPercentRange;
    const thinkingTokenSimulation = calculateKiroThinkingTokenSimulation(
      outputTokens,
      thinkingTokenRange,
    );
    outputTokens = thinkingTokenSimulation.finalOutputTokens;

    // Server-side only: no simulation metadata is added to response content or headers.
    if (thinkingTokenRange[0] !== 0 || thinkingTokenRange[1] !== 0) {
      const sampledPercent = thinkingTokenSimulation.randomPercent;
      console.info(
        `[KiroTokenEstimation] thinking-token simulation range=[${thinkingTokenRange[0]},${thinkingTokenRange[1]}]% sampled=${sampledPercent}% formula=round(${thinkingTokenSimulation.originalOutputTokens}*(1+${sampledPercent}/100)) original_output_tokens=${thinkingTokenSimulation.originalOutputTokens} added_thinking_tokens=${thinkingTokenSimulation.addedThinkingTokens} final_output_tokens=${thinkingTokenSimulation.finalOutputTokens} status=${thinkingTokenSimulation.status}`,
      );
    }

    const costBreakdown = calculateClaudeCost(requestBody.model, {
      input_tokens: inputTokens,
      output_tokens: outputTokens,
      cache_read_input_tokens: cacheReadInputTokens,
      cache_creation_input_tokens: cacheCreationInputTokens,
    });

    const costHeaders: Record<string, string> = {
      "x-cost-usd": String(costBreakdown.total_cost_usd),
      "x-cost-input-usd": String(costBreakdown.input_cost_usd),
      "x-cost-output-usd": String(costBreakdown.output_cost_usd),
      "x-cost-cache-read-usd": String(costBreakdown.cache_read_cost_usd),
      "x-cost-cache-creation-usd": String(
        costBreakdown.cache_creation_cost_usd,
      ),
      "x-usage-input-tokens": String(inputTokens),
      "x-usage-output-tokens": String(outputTokens),
      "x-usage-cache-read-input-tokens": String(cacheReadInputTokens),
      "x-usage-cache-creation-input-tokens": String(cacheCreationInputTokens),
    };

    if (creditConsumption !== null) {
      costHeaders["x-kiro-credit-consumption"] = String(creditConsumption);
    }

    return {
      content,
      toolUses,
      stopReason,
      inputTokens,
      outputTokens,
      cacheReadInputTokens,
      cacheCreationInputTokens,
      costHeaders,
    };
  }

  private buildBufferedStreamBody(
    events: KiroEvent[],
    requestBody: MessagesRequest,
    modifiedRequestBody: KiroRequest,
    analysis: KiroAnalysisResult,
  ): string {
    const thinkingEnabled = isThinkingEnabled(requestBody.thinking);
    const ctx = new BufferedStreamContext(
      requestBody.model,
      0,
      thinkingEnabled,
    );

    for (const event of events) {
      ctx.processAndBuffer(
        event,
        modifiedRequestBody.conversationState.currentMessage.userInputMessage
          .modelId,
      );
    }

    const sseEvents = ctx.finishAndGetAllEvents();

    for (const sseEvent of sseEvents) {
      if (sseEvent.event === "message_start") {
        const message = sseEvent.data.message as
          | Record<string, unknown>
          | undefined;
        if (message) {
          message.usage = {
            input_tokens: analysis.inputTokens,
            output_tokens: 0,
            cache_creation_input_tokens: analysis.cacheCreationInputTokens,
            cache_read_input_tokens: analysis.cacheReadInputTokens,
          };
        }
      }
      if (sseEvent.event === "message_delta") {
        sseEvent.data.usage = { output_tokens: analysis.outputTokens };
      }
    }

    return sseEvents.map(sseEventToString).join("");
  }

  async streamResponse(
    responseStream: AsyncIterable<Buffer | Uint8Array>,
    requestBody: MessagesRequest,
    modifiedRequestBody: KiroRequest,
    sink: KiroStreamSink,
  ): Promise<KiroStreamResult> {
    const decoder = new EventStreamDecoder();
    const thinkingEnabled = isThinkingEnabled(requestBody.thinking);
    const estimatedInputTokens = estimateInputTokens(
      requestBody.system,
      requestBody.messages,
      requestBody.tools,
    );
    const ctx = new StreamContext(
      requestBody.model,
      estimatedInputTokens,
      thinkingEnabled,
    );
    const events: KiroEvent[] = [];
    let initialEventsGenerated = false;

    const emitSseEvent = async (event: SseEvent): Promise<void> => {
      await sink.onChunk(sseEventToString(event));
    };

    const ensureInitialEvents = async (): Promise<void> => {
      if (initialEventsGenerated) return;
      initialEventsGenerated = true;
      for (const event of ctx.generateInitialEvents()) {
        await emitSseEvent(event);
      }
    };

    for await (const chunk of responseStream) {
      decoder.feed(Buffer.from(chunk));

      while (true) {
        const frame = decoder.decode();
        if (!frame) {
          const stats = decoder.getStats();
          if (stats.state === "stopped") {
            throw new Error(
              `Kiro event stream decoder stopped after ${stats.errorCount} parse errors`,
            );
          }
          break;
        }

        const event = parseEventPayload(frame.payload, frame.headers);
        if (!event) continue;
        if (isKiroFailureEvent(event)) {
          throw new Error(getKiroFailureMessage(event));
        }

        events.push(event);
        await ensureInitialEvents();

        for (const sseEvent of ctx.processKiroEvent(
          event,
          modifiedRequestBody.conversationState.currentMessage.userInputMessage
            .modelId,
        )) {
          await emitSseEvent(sseEvent);
        }
      }
    }

    const finalDecoderStats = decoder.getStats();
    if (finalDecoderStats.state === "stopped") {
      throw new Error(
        `Kiro event stream decoder stopped after ${finalDecoderStats.errorCount} parse errors`,
      );
    }
    if (finalDecoderStats.bufferLength > 0) {
      throw new Error(
        `Kiro event stream ended with ${finalDecoderStats.bufferLength} undecoded trailing bytes`,
      );
    }

    const analysis = await this.analyzeEvents(
      events,
      requestBody,
      modifiedRequestBody,
    );
    await ensureInitialEvents();

    const finalEvents = ctx.generateFinalEvents();
    for (const sseEvent of finalEvents) {
      if (sseEvent.event === "message_delta") {
        sseEvent.data.usage = {
          input_tokens: analysis.inputTokens,
          output_tokens: analysis.outputTokens,
          cache_creation_input_tokens: analysis.cacheCreationInputTokens,
          cache_read_input_tokens: analysis.cacheReadInputTokens,
        };
      }
      await emitSseEvent(sseEvent);
    }

    return { internalHeaders: analysis.costHeaders };
  }

  /**
   * Transform Kiro responses to Anthropic JSON or SSE.
   *
   * Input token count is derived from contextUsagePercentage and the
   * upstream model's context window, with estimation as a fallback.
   */
  async transformResponseBody(
    statusCode: number,
    responseBody: Buffer | string,
    requestBody: MessagesRequest,
    modifiedRequestBody: KiroRequest,
  ): Promise<{ body: unknown; headers?: Record<string, string> }> {
    if (statusCode != 200) {
      let responseString: string;
      if (Buffer.isBuffer(responseBody)) {
        responseString = responseBody.toString();
        if (
          (statusCode == 403 || statusCode == 429) &&
          (responseString.indexOf("Due to suspicious activity") >= 0 ||
            responseString.indexOf(" Kiro ") >= 0 ||
            responseString.indexOf(" kiro ") >= 0 ||
            responseString.indexOf("https://app.kiro.dev/account/usage") >= 0 ||
            responseString.indexOf(
              "https://support.aws.amazon.com/#/contacts/kiro",
            ) >= 0 ||
            responseString.indexOf("https://aws.amazon.com/contact-us/") >= 0)
        ) {
          responseString = `{"message":"Server is having temporary issues, please try again later"}`;
        }
      } else {
        responseString = Buffer.from(responseBody, "utf-8").toString();
      }

      const parsedBody = JSON.parse(responseString);
      if (
        getKiroUnrecoverableErrorReason(
          statusCode,
          parsedBody,
          responseString,
        ) === "input_too_long"
      ) {
        return {
          body: buildAnthropicInvalidRequestError("Prompt is too long"),
          headers: { "content-type": "application/json" },
        };
      }

      return { body: parsedBody };
    }

    const events = this.decodeEvents(responseBody);
    const analysis = await this.analyzeEvents(
      events,
      requestBody,
      modifiedRequestBody,
    );

    // ── Streaming path ──────────────────────────────────────────────────────
    if (requestBody.stream) {
      return {
        body: this.buildBufferedStreamBody(
          events,
          requestBody,
          modifiedRequestBody,
          analysis,
        ),
        headers: {
          "content-type": "text/event-stream; charset=utf-8",
          ...analysis.costHeaders,
        },
      };
    }

    // ── Non-streaming path ──────────────────────────────────────────────────
    const response = buildClaudeMessage(
      analysis.content,
      analysis.toolUses,
      requestBody.model,
      analysis.inputTokens,
      analysis.cacheCreationInputTokens,
      analysis.outputTokens,
      analysis.stopReason,
      analysis.cacheReadInputTokens,
    );

    return {
      body: response,
      headers: { "content-type": "application/json", ...analysis.costHeaders },
    };
  }
}
