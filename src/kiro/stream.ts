/**
 * Streaming and SSE Management
 *
 * Implements:
 * - SSE state management with proper event sequencing
 * - Thinking block processing
 * - Tool use handling
 * - Context usage tracking
 */

import { v4 as uuidv4 } from "uuid";
import { type BlockState, type KiroEvent, type SseEvent, type ToolUseEvent } from "./types.ts";
import {
  findCharBoundary,
  findRealThinkingEndTag,
  findRealThinkingEndTagAtBufferEnd,
  findRealThinkingStartTag,
} from "./utils.ts";
import { calculateTotalContextTokens, estimateTokens } from "./token.ts";

// ============================================================================
// SSE State Manager
// ============================================================================

/**
 * Manages SSE event state to ensure proper sequencing:
 * 1. message_start - only once
 * 2. content_block_start -> delta -> stop
 * 3. message_delta - only once, after all content blocks
 * 4. message_stop - at the end
 */
export class SseStateManager {
  private messageStarted = false;
  private messageDeltaSent = false;
  private messageEnded = false;
  private activeBlocks = new Map<number, BlockState>();
  private nextBlockIndex = 0;
  private hasToolUse = false;
  private stopReason: string | null = null;

  /**
   * Get the next block index
   */
  getNextBlockIndex(): number {
    const index = this.nextBlockIndex;
    this.nextBlockIndex++;
    return index;
  }

  /**
   * Set the stop reason
   */
  setStopReason(reason: string): void {
    this.stopReason = reason;
  }

  /**
   * Check if block is open for a specific type
   */
  isBlockOpenOfType(index: number, expectedType: string): boolean {
    const block = this.activeBlocks.get(index);
    return block
      ? block.started && !block.stopped && block.blockType === expectedType
      : false;
  }

  /**
   * Check if we have any non-thinking blocks
   */
  hasNonThinkingBlocks(): boolean {
    for (const block of Array.from(this.activeBlocks.values())) {
      if (block.blockType !== "thinking") {
        return true;
      }
    }
    return false;
  }

  /**
   * Get the final stop reason
   */
  getStopReason(): string {
    if (this.stopReason) return this.stopReason;
    if (this.hasToolUse) return "tool_use";
    return "end_turn";
  }

  /**
   * Handle message_start event
   */
  handleMessageStart(data: Record<string, unknown>): SseEvent | null {
    if (this.messageStarted) {
      return null;
    }
    this.messageStarted = true;
    return { event: "message_start", data };
  }

  /**
   * Handle content_block_start event
   */
  handleContentBlockStart(
    index: number,
    blockType: string,
    data: Record<string, unknown>,
  ): SseEvent[] {
    const events: SseEvent[] = [];

    // If this is a tool_use block, close any open text blocks first
    if (blockType === "tool_use") {
      this.hasToolUse = true;
      for (const [blockIndex, block] of Array.from(
        this.activeBlocks.entries(),
      )) {
        if (block.blockType === "text" && block.started && !block.stopped) {
          events.push({
            event: "content_block_stop",
            data: { type: "content_block_stop", index: blockIndex },
          });
          block.stopped = true;
        }
      }
    }

    // Check if block already exists
    const existingBlock = this.activeBlocks.get(index);
    if (existingBlock) {
      if (existingBlock.started) {
        return events;
      }
      existingBlock.started = true;
    } else {
      const newBlock: BlockState = {
        blockType,
        started: true,
        stopped: false,
      };
      this.activeBlocks.set(index, newBlock);
    }

    events.push({ event: "content_block_start", data });
    return events;
  }

  /**
   * Handle content_block_delta event
   */
  handleContentBlockDelta(
    index: number,
    data: Record<string, unknown>,
  ): SseEvent | null {
    const block = this.activeBlocks.get(index);
    if (!block) {
      return null;
    }
    if (!block.started || block.stopped) {
      return null;
    }
    return { event: "content_block_delta", data };
  }

  /**
   * Handle content_block_stop event
   */
  handleContentBlockStop(index: number): SseEvent | null {
    const block = this.activeBlocks.get(index);
    if (!block) return null;
    if (block.stopped) {
      return null;
    }
    block.stopped = true;
    return {
      event: "content_block_stop",
      data: { type: "content_block_stop", index },
    };
  }

  /**
   * Generate final events (message_delta and message_stop)
   */
  generateFinalEvents(inputTokens: number, outputTokens: number): SseEvent[] {
    const events: SseEvent[] = [];

    // Close all unclosed blocks
    for (const [index, block] of Array.from(this.activeBlocks.entries())) {
      if (block.started && !block.stopped) {
        events.push({
          event: "content_block_stop",
          data: { type: "content_block_stop", index },
        });
        block.stopped = true;
      }
    }

    // Send message_delta
    if (!this.messageDeltaSent) {
      this.messageDeltaSent = true;
      events.push({
        event: "message_delta",
        data: {
          type: "message_delta",
          delta: {
            stop_reason: this.getStopReason(),
            stop_sequence: null,
          },
          usage: {
            input_tokens: inputTokens,
            output_tokens: outputTokens,
          },
        },
      });
    }

    // Send message_stop
    if (!this.messageEnded) {
      this.messageEnded = true;
      events.push({
        event: "message_stop",
        data: { type: "message_stop" },
      });
    }

    return events;
  }
}

// ============================================================================
// Stream Context
// ============================================================================

/**
 * Context for processing Kiro events and converting to SSE
 */
export class StreamContext {
  public stateManager: SseStateManager;
  public model: string;
  public messageId: string;
  public inputTokens: number;
  public contextInputTokens: number | null = null;
  public outputTokens = 0;
  public thinkingEnabled: boolean;

  // Thinking state
  private thinkingBuffer = "";
  private inThinkingBlock = false;
  private thinkingExtracted = false;
  private thinkingBlockIndex: number | null = null;
  private textBlockIndex: number | null = null;
  private toolBlockIndices = new Map<string, number>();
  private stripThinkingLeadingNewline = false;

  constructor(model: string, inputTokens: number, thinkingEnabled: boolean) {
    this.stateManager = new SseStateManager();
    this.model = model;
    this.messageId = `msg_${uuidv4().replace(/-/g, "")}`;
    this.inputTokens = inputTokens;
    this.thinkingEnabled = thinkingEnabled;
  }

  /**
   * Create message_start event
   */
  createMessageStartEvent(): Record<string, unknown> {
    return {
      type: "message_start",
      message: {
        id: this.messageId,
        type: "message",
        role: "assistant",
        content: [],
        model: this.model,
        stop_reason: null,
        stop_sequence: null,
        usage: {
          input_tokens: this.inputTokens,
          output_tokens: 1,
        },
      },
    };
  }

  /**
   * Generate initial events (message_start + text block start)
   */
  generateInitialEvents(): SseEvent[] {
    const events: SseEvent[] = [];

    // message_start
    const msgStart = this.createMessageStartEvent();
    const handled = this.stateManager.handleMessageStart(msgStart);
    if (handled) events.push(handled);

    // If thinking enabled, don't create text block yet
    // It will be created after thinking block is processed
    if (this.thinkingEnabled) {
      return events;
    }

    // Create initial text block
    const textIndex = this.stateManager.getNextBlockIndex();
    this.textBlockIndex = textIndex;
    const blockEvents = this.stateManager.handleContentBlockStart(
      textIndex,
      "text",
      {
        type: "content_block_start",
        index: textIndex,
        content_block: { type: "text", text: "" },
      },
    );
    events.push(...blockEvents);

    return events;
  }

  /**
   * Process a Kiro event
   */
  processKiroEvent(event: KiroEvent, modifiedModel: string): SseEvent[] {
    switch (event.type) {
      case "assistantResponse":
        return this.processAssistantResponse(event.content);
      case "toolUse":
        return this.processToolUse(event.data);
      case "contextUsage":
        // Calculate actual input tokens from percentage
        const actualInputTokens = calculateTotalContextTokens(
          event.data.percentage,
          modifiedModel,
        );
        this.contextInputTokens = actualInputTokens;
        if (event.data.percentage >= 100) {
          this.stateManager.setStopReason("model_context_window_exceeded");
        }
        return [];
      case "exception":
        return [];
      case "error":
        return [];
      default:
        return [];
    }
  }

  /**
   * Process assistant response content
   */
  private processAssistantResponse(content: string): SseEvent[] {
    if (!content) return [];

    this.outputTokens += estimateTokens(content);

    if (this.thinkingEnabled) {
      return this.processContentWithThinking(content);
    }

    return this.createTextDeltaEvents(content);
  }

  /**
   * Process content with thinking tags
   */
  private processContentWithThinking(content: string): SseEvent[] {
    const events: SseEvent[] = [];
    this.thinkingBuffer += content;

    while (true) {
      if (!this.inThinkingBlock && !this.thinkingExtracted) {
        // Looking for <thinking> start
        const startPos = findRealThinkingStartTag(this.thinkingBuffer);

        if (startPos !== null) {
          // Send content before thinking as text (if not just whitespace)
          const beforeThinking = this.thinkingBuffer.substring(0, startPos);
          if (beforeThinking.trim()) {
            events.push(...this.createTextDeltaEvents(beforeThinking));
          }

          // Enter thinking block
          this.inThinkingBlock = true;
          this.stripThinkingLeadingNewline = true;
          this.thinkingBuffer = this.thinkingBuffer.substring(
            startPos + "<thinking>".length,
          );

          // Create thinking block
          const thinkingIndex = this.stateManager.getNextBlockIndex();
          this.thinkingBlockIndex = thinkingIndex;
          const startEvents = this.stateManager.handleContentBlockStart(
            thinkingIndex,
            "thinking",
            {
              type: "content_block_start",
              index: thinkingIndex,
              content_block: { type: "thinking", thinking: "" },
            },
          );
          events.push(...startEvents);
        } else {
          // No start tag found, keep buffering
          // But flush safe content if it looks like regular text
          const targetLen = Math.max(
            0,
            this.thinkingBuffer.length - "<thinking>".length,
          );
          const safeLen = findCharBoundary(this.thinkingBuffer, targetLen);
          if (safeLen > 0) {
            const safeContent = this.thinkingBuffer.substring(0, safeLen);
            if (safeContent.trim()) {
              events.push(...this.createTextDeltaEvents(safeContent));
              this.thinkingBuffer = this.thinkingBuffer.substring(safeLen);
            }
          }
          break;
        }
      } else if (this.inThinkingBlock) {
        // Strip leading newline after <thinking>
        if (this.stripThinkingLeadingNewline) {
          if (this.thinkingBuffer.startsWith("\n")) {
            this.thinkingBuffer = this.thinkingBuffer.substring(1);
            this.stripThinkingLeadingNewline = false;
          } else if (this.thinkingBuffer.length > 0) {
            this.stripThinkingLeadingNewline = false;
          }
        }

        // Looking for </thinking> end
        const endPos = findRealThinkingEndTag(this.thinkingBuffer);

        if (endPos !== null) {
          // Extract thinking content
          const thinkingContent = this.thinkingBuffer.substring(0, endPos);
          if (thinkingContent && this.thinkingBlockIndex !== null) {
            events.push(
              this.createThinkingDeltaEvent(
                this.thinkingBlockIndex,
                thinkingContent,
              ),
            );
          }

          // Exit thinking block
          this.inThinkingBlock = false;
          this.thinkingExtracted = true;

          // Close thinking block
          if (this.thinkingBlockIndex !== null) {
            events.push(
              this.createThinkingDeltaEvent(this.thinkingBlockIndex, ""),
            );
            const stopEvent = this.stateManager.handleContentBlockStop(
              this.thinkingBlockIndex,
            );
            if (stopEvent) events.push(stopEvent);
          }

          // Skip </thinking>\n\n
          this.thinkingBuffer = this.thinkingBuffer.substring(
            endPos + "</thinking>\n\n".length,
          );
        } else {
          // No end tag yet, flush safe content
          const targetLen = Math.max(
            0,
            this.thinkingBuffer.length - "</thinking>\n\n".length,
          );
          const safeLen = findCharBoundary(this.thinkingBuffer, targetLen);
          if (safeLen > 0) {
            const safeContent = this.thinkingBuffer.substring(0, safeLen);
            if (safeContent && this.thinkingBlockIndex !== null) {
              events.push(
                this.createThinkingDeltaEvent(
                  this.thinkingBlockIndex,
                  safeContent,
                ),
              );
            }
            this.thinkingBuffer = this.thinkingBuffer.substring(safeLen);
          }
          break;
        }
      } else {
        // Thinking extracted, remaining content as text
        if (this.thinkingBuffer) {
          const remaining = this.thinkingBuffer;
          this.thinkingBuffer = "";
          events.push(...this.createTextDeltaEvents(remaining));
        }
        break;
      }
    }

    return events;
  }

  /**
   * Create text delta events
   */
  private createTextDeltaEvents(text: string): SseEvent[] {
    const events: SseEvent[] = [];

    // Check if current text block was closed (e.g., by tool_use)
    if (this.textBlockIndex !== null) {
      if (!this.stateManager.isBlockOpenOfType(this.textBlockIndex, "text")) {
        this.textBlockIndex = null;
      }
    }

    // Get or create text block index
    let textIndex = this.textBlockIndex;
    if (textIndex === null) {
      textIndex = this.stateManager.getNextBlockIndex();
      this.textBlockIndex = textIndex;

      const startEvents = this.stateManager.handleContentBlockStart(
        textIndex,
        "text",
        {
          type: "content_block_start",
          index: textIndex,
          content_block: { type: "text", text: "" },
        },
      );
      events.push(...startEvents);
    }

    // Send delta
    const deltaEvent = this.stateManager.handleContentBlockDelta(textIndex, {
      type: "content_block_delta",
      index: textIndex,
      delta: { type: "text_delta", text },
    });
    if (deltaEvent) events.push(deltaEvent);

    return events;
  }

  /**
   * Create thinking delta event
   */
  private createThinkingDeltaEvent(index: number, thinking: string): SseEvent {
    return {
      event: "content_block_delta",
      data: {
        type: "content_block_delta",
        index,
        delta: { type: "thinking_delta", thinking },
      },
    };
  }

  /**
   * Process tool use event
   */
  private processToolUse(toolUse: ToolUseEvent): SseEvent[] {
    const events: SseEvent[] = [];

    // Handle thinking boundary before tool_use
    if (this.thinkingEnabled && this.inThinkingBlock) {
      const endPos = findRealThinkingEndTagAtBufferEnd(this.thinkingBuffer);
      if (endPos !== null) {
        const thinkingContent = this.thinkingBuffer.substring(0, endPos);
        if (thinkingContent && this.thinkingBlockIndex !== null) {
          events.push(
            this.createThinkingDeltaEvent(
              this.thinkingBlockIndex,
              thinkingContent,
            ),
          );
        }

        this.inThinkingBlock = false;
        this.thinkingExtracted = true;

        if (this.thinkingBlockIndex !== null) {
          events.push(
            this.createThinkingDeltaEvent(this.thinkingBlockIndex, ""),
          );
          const stopEvent = this.stateManager.handleContentBlockStop(
            this.thinkingBlockIndex,
          );
          if (stopEvent) events.push(stopEvent);
        }

        const afterPos = endPos + "</thinking>".length;
        const remaining = this.thinkingBuffer.substring(afterPos).trimStart();
        this.thinkingBuffer = "";
        if (remaining) {
          events.push(...this.createTextDeltaEvents(remaining));
        }
      }
    }

    // Flush any buffered text before tool_use
    if (
      this.thinkingEnabled &&
      !this.inThinkingBlock &&
      !this.thinkingExtracted &&
      this.thinkingBuffer
    ) {
      const buffered = this.thinkingBuffer;
      this.thinkingBuffer = "";
      events.push(...this.createTextDeltaEvents(buffered));
    }

    // Get or allocate block index
    let blockIndex = this.toolBlockIndices.get(toolUse.toolUseId);
    if (blockIndex === undefined) {
      blockIndex = this.stateManager.getNextBlockIndex();
      this.toolBlockIndices.set(toolUse.toolUseId, blockIndex);
    }

    // Start tool_use block
    const startEvents = this.stateManager.handleContentBlockStart(
      blockIndex,
      "tool_use",
      {
        type: "content_block_start",
        index: blockIndex,
        content_block: {
          type: "tool_use",
          id: toolUse.toolUseId,
          name: toolUse.name,
          input: {},
        },
      },
    );
    events.push(...startEvents);

    // Send input delta
    if (toolUse.input) {
      this.outputTokens += Math.ceil(toolUse.input.length / 4);
      const deltaEvent = this.stateManager.handleContentBlockDelta(blockIndex, {
        type: "content_block_delta",
        index: blockIndex,
        delta: {
          type: "input_json_delta",
          partial_json: toolUse.input,
        },
      });
      if (deltaEvent) events.push(deltaEvent);
    }

    // Close block if complete
    if (toolUse.stop) {
      const stopEvent = this.stateManager.handleContentBlockStop(blockIndex);
      if (stopEvent) events.push(stopEvent);
    }

    return events;
  }

  /**
   * Generate final events
   */
  generateFinalEvents(): SseEvent[] {
    const events: SseEvent[] = [];

    // Flush thinking buffer
    if (this.thinkingEnabled && this.thinkingBuffer) {
      if (this.inThinkingBlock) {
        const endPos = findRealThinkingEndTagAtBufferEnd(this.thinkingBuffer);
        if (endPos !== null) {
          const thinkingContent = this.thinkingBuffer.substring(0, endPos);
          if (thinkingContent && this.thinkingBlockIndex !== null) {
            events.push(
              this.createThinkingDeltaEvent(
                this.thinkingBlockIndex,
                thinkingContent,
              ),
            );
          }

          if (this.thinkingBlockIndex !== null) {
            events.push(
              this.createThinkingDeltaEvent(this.thinkingBlockIndex, ""),
            );
            const stopEvent = this.stateManager.handleContentBlockStop(
              this.thinkingBlockIndex,
            );
            if (stopEvent) events.push(stopEvent);
          }

          this.inThinkingBlock = false;
          this.thinkingExtracted = true;

          const afterPos = endPos + "</thinking>".length;
          const remaining = this.thinkingBuffer.substring(afterPos).trimStart();
          if (remaining) {
            events.push(...this.createTextDeltaEvents(remaining));
          }
        } else {
          // Still in thinking, flush remaining
          if (this.thinkingBlockIndex !== null) {
            events.push(
              this.createThinkingDeltaEvent(
                this.thinkingBlockIndex,
                this.thinkingBuffer,
              ),
            );
            events.push(
              this.createThinkingDeltaEvent(this.thinkingBlockIndex, ""),
            );
            const stopEvent = this.stateManager.handleContentBlockStop(
              this.thinkingBlockIndex,
            );
            if (stopEvent) events.push(stopEvent);
          }
        }
      } else {
        // Not in thinking, flush as text
        events.push(...this.createTextDeltaEvents(this.thinkingBuffer));
      }
      this.thinkingBuffer = "";
    }

    // If only thinking was produced, add empty text block so content array isn't empty
    if (
      this.thinkingEnabled &&
      this.thinkingBlockIndex !== null &&
      !this.stateManager.hasNonThinkingBlocks()
    ) {
      events.push(...this.createTextDeltaEvents(" "));
    }

    // Generate final events with correct input tokens
    const finalInputTokens = this.contextInputTokens ?? this.inputTokens;
    events.push(
      ...this.stateManager.generateFinalEvents(
        finalInputTokens,
        this.outputTokens,
      ),
    );

    return events;
  }
}

// ============================================================================
// SSE Utilities
// ============================================================================

/**
 * Convert SSE event to string format
 */
export function sseEventToString(event: SseEvent): string {
  return `event: ${event.event}\ndata: ${JSON.stringify(event.data)}\n\n`;
}

// ============================================================================
// Buffered Stream Context - For Claude Code accurate token counts
// ============================================================================

export class BufferedStreamContext {
  private readonly inner: StreamContext;
  private readonly eventBuffer: SseEvent[] = [];
  private initialEventsGenerated = false;

  constructor(
    model: string,
    estimatedInputTokens: number,
    thinkingEnabled: boolean,
  ) {
    this.inner = new StreamContext(
      model,
      estimatedInputTokens,
      thinkingEnabled,
    );
  }

  processAndBuffer(event: KiroEvent, modifiedModel: string): void {
    this.ensureInitialEvents();
    this.eventBuffer.push(...this.inner.processKiroEvent(event, modifiedModel));
  }

  finishAndGetAllEvents(): SseEvent[] {
    this.ensureInitialEvents();
    this.eventBuffer.push(...this.inner.generateFinalEvents());
    return this.eventBuffer;
  }

  private ensureInitialEvents(): void {
    if (this.initialEventsGenerated) return;
    this.eventBuffer.push(...this.inner.generateInitialEvents());
    this.initialEventsGenerated = true;
  }
}
