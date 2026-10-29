import { createHash } from "node:crypto";
import type { KiroEvent, KiroRequest, MessagesRequest } from "./types.ts";

// Kiro's tool names are limited to 64 characters. Anthropic/MCP names can be
// longer. Keep the translation local to each request, including resumed history.
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

  const valid = (name: string) => /^[a-zA-Z][a-zA-Z0-9_]{0,63}$/.test(name);
  const occupied = new Set([...names].filter(valid));
  const toWire = new Map<string, string>();
  const fromWire = new Map<string, string>();
  for (const name of [...names].sort()) {
    if (valid(name)) continue;
    let alias: string;
    let attempt = 0;
    do {
      const input = attempt === 0 ? name : `${name}\0${attempt}`;
      alias = `kiro_${createHash("sha256").update(input).digest("hex").slice(0, 48)}`;
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
