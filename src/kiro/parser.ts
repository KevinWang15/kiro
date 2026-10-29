/**
 * AWS Event Stream Binary Parser
 *
 * Implements proper AWS Event Stream frame parsing with:
 * - Prelude CRC validation
 * - Message CRC validation
 * - Header parsing
 * - Payload extraction
 * - Error recovery
 */

import { type KiroEvent, type ToolUseEvent } from "./types.ts";

// AWS Event Stream constants
const PRELUDE_SIZE = 12; // 4 (total_len) + 4 (header_len) + 4 (prelude_crc)
const MIN_FRAME_SIZE = 16;
const MAX_FRAME_SIZE = 16 * 1024 * 1024; // 16MB max
const MAX_BUFFER_SIZE = 16 * 1024 * 1024;
const MAX_ERRORS = 5;

/**
 * CRC32 lookup table for AWS Event Stream
 */
const CRC32_TABLE = new Uint32Array(256);
(function initCrc32Table() {
  for (let i = 0; i < 256; i++) {
    let crc = i;
    for (let j = 0; j < 8; j++) {
      crc = crc & 1 ? 0xedb88320 ^ (crc >>> 1) : crc >>> 1;
    }
    CRC32_TABLE[i] = crc >>> 0;
  }
})();

/**
 * Calculate CRC32 checksum
 */
function crc32(data: Uint8Array, start = 0, end = data.length): number {
  let crc = 0xffffffff;
  for (let i = start; i < end; i++) {
    crc = (CRC32_TABLE[(crc ^ data[i]) & 0xff] ^ (crc >>> 8)) >>> 0;
  }
  return ~crc >>> 0;
}

/**
 * Read 32-bit big-endian integer
 */
function readUInt32BE(data: Uint8Array, offset: number): number {
  return (
    ((data[offset] << 24) |
      (data[offset + 1] << 16) |
      (data[offset + 2] << 8) |
      data[offset + 3]) >>>
    0
  );
}

/**
 * Parser state
 */
enum ParserState {
  READY = "ready",
  PARSING = "parsing",
  RECOVERING = "recovering",
  STOPPED = "stopped",
}

/**
 * Parse error types
 */
class ParseError extends Error {
  constructor(
    public readonly code:
      | "buffer_overflow"
      | "message_too_small"
      | "message_too_large"
      | "prelude_crc_mismatch"
      | "message_crc_mismatch"
      | "too_many_errors",
    message: string,
  ) {
    super(message);
    this.name = "ParseError";
  }
}

/**
 * Event Stream Frame
 */
interface Frame {
  headers: Map<string, unknown>;
  payload: Uint8Array;
}

/**
 * Event Stream Decoder
 *
 * Parses AWS Event Stream binary format with proper CRC validation
 * and error recovery.
 */
export class EventStreamDecoder {
  private buffer: Uint8Array;
  private bufferLength: number;
  private state: ParserState;
  private framesDecoded: number;
  private errorCount: number;
  private bytesSkipped: number;

  constructor() {
    this.buffer = new Uint8Array(8192);
    this.bufferLength = 0;
    this.state = ParserState.READY;
    this.framesDecoded = 0;
    this.errorCount = 0;
    this.bytesSkipped = 0;
  }

  /**
   * Feed data into the decoder
   */
  feed(data: Buffer | Uint8Array): void {
    const newLength = this.bufferLength + data.length;

    if (newLength > MAX_BUFFER_SIZE) {
      throw new ParseError(
        "buffer_overflow",
        `Buffer overflow: ${newLength} > ${MAX_BUFFER_SIZE}`,
      );
    }

    // Grow buffer if needed
    if (newLength > this.buffer.length) {
      const newBuffer = new Uint8Array(
        Math.max(newLength, this.buffer.length * 2),
      );
      newBuffer.set(this.buffer.subarray(0, this.bufferLength));
      this.buffer = newBuffer;
    }

    // Copy new data
    this.buffer.set(data, this.bufferLength);
    this.bufferLength = newLength;

    // Recover from error state
    if (this.state === ParserState.RECOVERING) {
      this.state = ParserState.READY;
    }
  }

  /**
   * Try to parse a frame from the buffer
   */
  private parseFrame(): Frame | null {
    if (this.bufferLength < MIN_FRAME_SIZE) {
      return null;
    }

    const totalLength = readUInt32BE(this.buffer, 0);

    // Validate frame size
    if (totalLength < MIN_FRAME_SIZE) {
      throw new ParseError(
        "message_too_small",
        `Message too small: ${totalLength}`,
      );
    }
    if (totalLength > MAX_FRAME_SIZE) {
      throw new ParseError(
        "message_too_large",
        `Message too large: ${totalLength}`,
      );
    }
    if (this.bufferLength < totalLength) {
      return null; // Need more data
    }

    // Validate prelude CRC (first 8 bytes)
    const preludeCrc = readUInt32BE(this.buffer, 8);
    const calculatedPreludeCrc = crc32(this.buffer, 0, 8);
    if (preludeCrc !== calculatedPreludeCrc) {
      throw new ParseError(
        "prelude_crc_mismatch",
        `Prelude CRC mismatch: ${preludeCrc} !== ${calculatedPreludeCrc}`,
      );
    }

    // Validate message CRC (last 4 bytes)
    const messageCrc = readUInt32BE(this.buffer, totalLength - 4);
    const calculatedMessageCrc = crc32(this.buffer, 0, totalLength - 4);
    if (messageCrc !== calculatedMessageCrc) {
      throw new ParseError(
        "message_crc_mismatch",
        `Message CRC mismatch: ${messageCrc} !== ${calculatedMessageCrc}`,
      );
    }

    const headerLength = readUInt32BE(this.buffer, 4);
    const payloadStart = PRELUDE_SIZE + headerLength;
    const payloadLength = totalLength - PRELUDE_SIZE - headerLength - 4; // -4 for CRC

    // Extract payload - MUST copy before buffer is modified by copyWithin
    const payloadView = this.buffer.subarray(
      payloadStart,
      payloadStart + payloadLength,
    );
    const payload = new Uint8Array(payloadView); // Copy to new array

    // Parse headers (simplified - we mainly care about :event-type)
    const headers = this.parseHeaders(PRELUDE_SIZE, headerLength);

    // Consume the frame
    this.buffer.copyWithin(0, totalLength, this.bufferLength);
    this.bufferLength -= totalLength;

    return { headers, payload };
  }

  /**
   * Parse headers section
   */
  private parseHeaders(offset: number, length: number): Map<string, unknown> {
    const headers = new Map<string, unknown>();
    let pos = offset;
    const end = offset + length;

    while (pos < end) {
      // Bounds check before reading name length
      if (pos >= this.bufferLength) break;

      // Read header name length (1 byte)
      const nameLen = this.buffer[pos++];

      // Validate name length
      if (nameLen === 0) {
        // Invalid header, skip remaining
        break;
      }

      // Bounds check before reading name
      if (pos + nameLen > this.bufferLength) break;

      // Read header name
      const nameBytes = this.buffer.subarray(pos, pos + nameLen);
      const name = Buffer.from(nameBytes).toString("utf-8");
      pos += nameLen;

      // Bounds check before reading type
      if (pos >= this.bufferLength) break;

      // Read header type (1 byte)
      const type = this.buffer[pos++];

      // Read header value based on type
      switch (type) {
        case 0x00: // bool true
          headers.set(name, true);
          break;
        case 0x01: // bool false
          headers.set(name, false);
          break;
        case 0x02: // byte
          if (pos < this.bufferLength) {
            headers.set(name, this.buffer[pos++]);
          }
          break;
        case 0x03: // short (2 bytes)
          if (pos + 2 <= this.bufferLength) {
            headers.set(name, (this.buffer[pos] << 8) | this.buffer[pos + 1]);
            pos += 2;
          }
          break;
        case 0x04: // int (4 bytes)
          if (pos + 4 <= this.bufferLength) {
            headers.set(name, readUInt32BE(this.buffer, pos) | 0);
            pos += 4;
          }
          break;
        case 0x05: // long (8 bytes)
          pos += 8; // Skip for now
          break;
        case 0x06: // bytes
        case 0x07: // string
          // String/bytes use 2-byte length (u16), not 4 bytes
          if (pos + 2 <= this.bufferLength) {
            const len = (this.buffer[pos] << 8) | this.buffer[pos + 1];
            pos += 2;
            if (pos + len <= this.bufferLength) {
              const valueBytes = this.buffer.subarray(pos, pos + len);
              const value = Buffer.from(valueBytes).toString("utf-8");
              pos += len;
              headers.set(name, value);
            }
          }
          break;
        case 0x08: // timestamp
          pos += 8; // Skip for now
          break;
        case 0x09: // uuid
          pos += 16; // Skip for now
          break;
        default:
          // Unknown type, skip remaining headers
          pos = end;
      }
    }

    return headers;
  }

  /**
   * Try to recover from parse error
   */
  private tryRecover(error: ParseError): void {
    if (this.bufferLength === 0) return;

    switch (error.code) {
      case "prelude_crc_mismatch":
      case "message_too_small":
      case "message_too_large":
        // Skip 1 byte and try again
        this.buffer.copyWithin(0, 1, this.bufferLength);
        this.bufferLength--;
        this.bytesSkipped++;
        break;

      case "message_crc_mismatch":
        // Try to skip entire frame if we can determine its length
        if (this.bufferLength >= 4) {
          const totalLength = readUInt32BE(this.buffer, 0);
          if (
            totalLength >= MIN_FRAME_SIZE &&
            totalLength <= this.bufferLength
          ) {
            this.buffer.copyWithin(0, totalLength, this.bufferLength);
            this.bufferLength -= totalLength;
            this.bytesSkipped += totalLength;
            return;
          }
        }
        // Fallback to byte skip
        this.buffer.copyWithin(0, 1, this.bufferLength);
        this.bufferLength--;
        this.bytesSkipped++;
        break;

      default:
        // Generic recovery: skip 1 byte
        this.buffer.copyWithin(0, 1, this.bufferLength);
        this.bufferLength--;
        this.bytesSkipped++;
    }
  }

  /**
   * Decode the next frame
   */
  decode(): Frame | null {
    if (this.state === ParserState.STOPPED) {
      return null;
    }

    if (this.bufferLength === 0) {
      this.state = ParserState.READY;
      return null;
    }

    this.state = ParserState.PARSING;

    try {
      const frame = this.parseFrame();
      if (frame) {
        this.framesDecoded++;
        this.errorCount = 0;
        this.state = ParserState.READY;
        return frame;
      }
      this.state = ParserState.READY;
      return null;
    } catch (error) {
      this.errorCount++;

      if (this.errorCount >= MAX_ERRORS) {
        this.state = ParserState.STOPPED;
        return null;
      }

      if (error instanceof ParseError) {
        this.tryRecover(error);
        this.state = ParserState.RECOVERING;
      }

      return null;
    }
  }

  /**
   * Decode all available frames
   */
  decodeAll(): Frame[] {
    const frames: Frame[] = [];
    let lastLen = -1;

    while (this.bufferLength > 0 && this.bufferLength !== lastLen) {
      lastLen = this.bufferLength;
      const frame = this.decode();

      if (frame) {
        frames.push(frame);
      } else if (this.state === ParserState.RECOVERING) {
        this.state = ParserState.READY;
      } else {
        break;
      }
    }

    return frames;
  }

  /**
   * Get decoder stats
   */
  getStats(): {
    state: ParserState;
    framesDecoded: number;
    errorCount: number;
    bytesSkipped: number;
    bufferLength: number;
  } {
    return {
      state: this.state,
      framesDecoded: this.framesDecoded,
      errorCount: this.errorCount,
      bytesSkipped: this.bytesSkipped,
      bufferLength: this.bufferLength,
    };
  }
}

/**
 * Parse payload JSON into KiroEvent
 *
 * Note: For 'error' and 'exception' message types, payload is plain text, not JSON.
 * We need headers to determine the message type.
 */
export function parseEventPayload(
  payload: Uint8Array,
  headers?: Map<string, unknown>,
): KiroEvent | null {
  const text = Buffer.from(payload).toString("utf-8");

  // Check message type from headers
  const messageType = headers?.get(":message-type") as string | undefined;
  const eventType = headers?.get(":event-type") as string | undefined;

  // Handle error message type (payload is plain text)
  if (messageType === "error") {
    const errorCode = (headers?.get(":error-code") as string) || "UnknownError";
    return {
      type: "error",
      errorCode,
      errorMessage: text,
    };
  }

  // Handle exception message type (payload is plain text)
  if (messageType === "exception") {
    const exceptionType =
      (headers?.get(":exception-type") as string) || "UnknownException";
    return {
      type: "exception",
      exceptionType,
      message: text,
    };
  }

  // Handle meteringEvent from :event-type header
  if (eventType === "meteringEvent") {
    try {
      const data = JSON.parse(text);
      if (data.usage !== undefined) {
        return { type: "creditConsumption", data: { amount: data.usage } };
      }
    } catch {
      return null;
    }
  }

  // For 'event' message type (and default), payload is JSON
  try {
    const data = JSON.parse(text);

    // Check for content
    if (data.content !== undefined && !data.followupPrompt) {
      return { type: "assistantResponse", content: data.content };
    }

    // Check for tool use
    if (data.name && data.toolUseId) {
      const toolUse: ToolUseEvent = {
        name: data.name,
        toolUseId: data.toolUseId,
        input: data.input || "",
        stop: data.stop || false,
      };
      return { type: "toolUse", data: toolUse };
    }

    // Check for context usage
    if (data.contextUsagePercentage !== undefined) {
      return {
        type: "contextUsage",
        data: { percentage: data.contextUsagePercentage },
      };
    }

    // Check for error (embedded in JSON, though typically errors use :message-type header)
    if (data.errorCode) {
      return {
        type: "error",
        errorCode: data.errorCode,
        errorMessage: data.errorMessage || "",
      };
    }

    // Check for exception (embedded in JSON, though typically exceptions use :message-type header)
    if (data.exceptionType) {
      return {
        type: "exception",
        exceptionType: data.exceptionType,
        message: data.message || "",
      };
    }

    return null;
  } catch {
    // JSON parse failed - could be an error/exception with plain text payload
    // but without proper headers
    return null;
  }
}
