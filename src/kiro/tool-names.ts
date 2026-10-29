import { createHash } from "node:crypto";
import type { KiroEvent, KiroRequest, MessagesRequest } from "./types.ts";

// Kiro accepts tool names of 1-64 characters from [A-Za-z0-9_-] (verified
// against the live API; ':' '/' ' ' and 65+ chars are rejected). Claude Code
// already sanitizes MCP names to that charset, so length is the usual trigger.
const KIRO_TOOL_NAME = /^[A-Za-z0-9_-]{1,64}$/;
const ALIAS_HASH_LENGTH = 8;

export function isValidKiroToolName(name: string): boolean {
  return KIRO_TOOL_NAME.test(name);
}

// Keep as much of the original name as fits so the model can still read it,
// and append a short hash so names sharing a long prefix stay distinct.
function readableAlias(name: string, attempt: number): string {
  const input = attempt === 0 ? name : `${name}\0${attempt}`;
  const hash = createHash("sha256").update(input).digest("hex").slice(0, ALIAS_HASH_LENGTH);
  const stem = name
    .replace(/[^A-Za-z0-9_-]/g, "_")
    .slice(0, 64 - ALIAS_HASH_LENGTH - 1);
  return `${stem}_${hash}`;
}

// Keep the translation local to each request, including resumed history.
export function createToolNameMap(request: MessagesRequest) {
  const names = new Set<string>();
  for (const tool of request.tools || []) {
    if (typeof tool.name === "string") names.add(tool.name);
  }
  for (const message of request.messages) {
    if (!Array.isArray(message.content)) continue;
    for (const block of message.content) {
      if (block.type === "tool_use" && typeof block.name === "string")
        names.add(block.name);
    }
  }

  const occupied = new Set([...names].filter(isValidKiroToolName));
  const toWire = new Map<string, string>();
  const fromWire = new Map<string, string>();
  for (const name of [...names].sort()) {
    if (isValidKiroToolName(name)) continue;
    let alias: string;
    let attempt = 0;
    // Retries only happen on a hash collision with another declared name, so
    // in practice every name maps to its attempt-0 alias on every turn.
    do {
      alias = readableAlias(name, attempt);
      attempt++;
    } while (occupied.has(alias));
    occupied.add(alias);
    toWire.set(name, alias);
    fromWire.set(alias, name);
  }

  return {
    toWireName(name: string): string {
      return toWire.get(name) || name;
    },
    apply(upstream: KiroRequest): void {
      const state = upstream.conversationState;
      const tools = state.currentMessage.userInputMessage
        .userInputMessageContext?.tools;
      for (const tool of tools || []) {
        const spec = tool.toolSpecification;
        spec.name = toWire.get(spec.name) || spec.name;
      }
      for (const message of state.history || []) {
        if (!("assistantResponseMessage" in message)) continue;
        for (const tool of message.assistantResponseMessage.toolUses || [])
          tool.name = toWire.get(tool.name) || tool.name;
      }
    },
    restore(event: KiroEvent): KiroEvent {
      if (event.type !== "toolUse") return event;
      const original = fromWire.get(event.data.name);
      return original
        ? { ...event, data: { ...event.data, name: original } }
        : event;
    },
  };
}
