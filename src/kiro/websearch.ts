/**
 * WebSearch Tool Handler
 *
 * Implements Anthropic WebSearch requests to Kiro MCP conversion.
 *
 * Flow:
 * 1. Detect if request is pure web search (only web_search tool)
 * 2. Extract search query from message
 * 3. Create MCP JSON-RPC request
 * 4. Call MCP API (via shim)
 * 5. Parse search results
 * 6. Generate SSE response stream
 */

import { v4 as uuidv4 } from "uuid";
import { type MessagesRequest, type SseEvent } from "./types.ts";
import { sseEventToString } from "./stream.ts";
import { estimateInputTokens } from "./token.ts";
import { callWebSearchMcpWithConfig, type McpShimConfig } from "./mcp-shim.ts";

// ============================================================================
// Types
// ============================================================================

export interface McpRequest {
  id: string;
  jsonrpc: string;
  method: string;
  params: McpParams;
}

export interface McpParams {
  name: string;
  arguments: McpArguments;
}

export interface McpArguments {
  query?: string;
  path?: string;
  [key: string]: unknown;
}

export interface McpResponse {
  error?: McpError;
  id: string;
  jsonrpc: string;
  result?: McpResult;
}

export interface McpError {
  code?: number;
  message?: string;
}

export interface McpResult {
  content: McpContent[];
  is_error: boolean;
}

export interface McpContent {
  type: string;
  text: string;
}

export interface WebSearchResults {
  results: WebSearchResult[];
  totalResults?: number;
  query?: string;
  error?: string;
}

export interface WebSearchResult {
  title: string;
  url: string;
  snippet?: string;
  publishedDate?: number;
  id?: string;
  domain?: string;
  maxVerbatimWordLimit?: number;
  publicDomain?: boolean;
}

// ============================================================================
// Detection
// ============================================================================

/**
 * Check if request is a pure WebSearch request
 *
 * Condition: tools has exactly one, and name is "web_search"
 */
export function hasWebSearchTool(req: MessagesRequest): boolean {
  if (!req.tools || req.tools.length !== 1) {
    return false;
  }
  return req.tools[0]?.name === "web_search";
}

/**
 * Extract search query from message
 *
 * Reads first message's first content block
 * and strips "Perform a web search for the query: " prefix
 */
export function extractSearchQuery(req: MessagesRequest): string | null {
  const firstMsg = req.messages[0];
  if (!firstMsg) return null;

  let text: string;

  if (typeof firstMsg.content === "string") {
    text = firstMsg.content;
  } else if (Array.isArray(firstMsg.content)) {
    const firstBlock = firstMsg.content[0];
    if (firstBlock?.type === "text" && firstBlock.text) {
      text = firstBlock.text;
    } else {
      return null;
    }
  } else {
    return null;
  }

  // Strip prefix
  const PREFIX = "Perform a web search for the query: ";
  const query = text.startsWith(PREFIX) ? text.substring(PREFIX.length) : text;

  return query.trim() || null;
}

// ============================================================================
// SSE Stream Generation
// ============================================================================

/**
 * Generate search summary text
 */
export function generateSearchSummary(
  query: string,
  results: WebSearchResults | null,
): string {
  let summary = `Here are the search results for "${query}":\n\n`;

  if (results?.results?.length) {
    for (let i = 0; i < results.results.length; i++) {
      const result = results.results[i];
      summary += `${i + 1}. **${result.title}**\n`;

      if (result.snippet) {
        // Truncate without splitting a UTF-16 surrogate pair
        let snippet = result.snippet;
        if (snippet.length > 200) {
          // Find last complete char before 200
          let truncateAt = 200;
          while (
            truncateAt > 0 &&
            (snippet.charCodeAt(truncateAt) & 0xfc00) === 0xdc00
          ) {
            truncateAt--;
          }
          snippet = snippet.substring(0, truncateAt) + "...";
        }
        summary += `   ${snippet}\n`;
      }

      summary += `   Source: ${result.url}\n\n`;
    }
  } else {
    summary += "No results found.\n";
  }

  summary +=
    "\nPlease note that these are web search results and may not be fully accurate or up-to-date.";

  return summary;
}

/**
 * Generate WebSearch SSE events
 */
export function generateWebSearchEvents(
  model: string,
  query: string,
  toolUseId: string,
  searchResults: WebSearchResults | null,
  inputTokens: number,
): SseEvent[] {
  const events: SseEvent[] = [];
  const messageId = `msg_${uuidv4().replace(/-/g, "").substring(0, 24)}`;

  // 1. message_start
  events.push({
    event: "message_start",
    data: {
      type: "message_start",
      message: {
        id: messageId,
        type: "message",
        role: "assistant",
        model,
        content: [],
        stop_reason: null,
        stop_sequence: null,
        usage: {
          input_tokens: inputTokens,
          output_tokens: 0,
          cache_creation_input_tokens: 0,
          cache_read_input_tokens: 0,
        },
      },
    },
  });

  // 2. content_block_start (server_tool_use)
  events.push({
    event: "content_block_start",
    data: {
      type: "content_block_start",
      index: 0,
      content_block: {
        id: toolUseId,
        type: "server_tool_use",
        name: "web_search",
        input: {},
      },
    },
  });

  // 3. content_block_delta (input_json_delta)
  const inputJson = { query };
  events.push({
    event: "content_block_delta",
    data: {
      type: "content_block_delta",
      index: 0,
      delta: {
        type: "input_json_delta",
        partial_json: JSON.stringify(inputJson),
      },
    },
  });

  // 4. content_block_stop (server_tool_use)
  events.push({
    event: "content_block_stop",
    data: {
      type: "content_block_stop",
      index: 0,
    },
  });

  // 5. content_block_start (web_search_tool_result)
  const searchContent = searchResults?.results?.map((r) => ({
    type: "web_search_result",
    title: r.title,
    url: r.url,
    encrypted_content: r.snippet || "",
    page_age: null,
  }));

  events.push({
    event: "content_block_start",
    data: {
      type: "content_block_start",
      index: 1,
      content_block: {
        type: "web_search_tool_result",
        tool_use_id: toolUseId,
        content: searchContent || [],
      },
    },
  });

  // 6. content_block_stop (web_search_tool_result)
  events.push({
    event: "content_block_stop",
    data: {
      type: "content_block_stop",
      index: 1,
    },
  });

  // 7. content_block_start (text)
  events.push({
    event: "content_block_start",
    data: {
      type: "content_block_start",
      index: 2,
      content_block: {
        type: "text",
        text: "",
      },
    },
  });

  // 8. content_block_delta (text_delta) - chunked
  const summary = generateSearchSummary(query, searchResults);
  const chunkSize = 100;

  for (let i = 0; i < summary.length; ) {
    let end = Math.min(i + chunkSize, summary.length);
    // Avoid splitting a UTF-16 surrogate pair
    if (
      end < summary.length &&
      (summary.charCodeAt(end - 1) & 0xfc00) === 0xd800
    ) {
      end--;
    }
    const chunk = summary.substring(i, end);
    i = end;
    events.push({
      event: "content_block_delta",
      data: {
        type: "content_block_delta",
        index: 2,
        delta: {
          type: "text_delta",
          text: chunk,
        },
      },
    });
  }

  // 9. content_block_stop (text)
  events.push({
    event: "content_block_stop",
    data: {
      type: "content_block_stop",
      index: 2,
    },
  });

  // 10. message_delta
  const outputTokens = Math.ceil(summary.length / 4);
  events.push({
    event: "message_delta",
    data: {
      type: "message_delta",
      delta: {
        stop_reason: "end_turn",
        stop_sequence: null,
      },
      usage: {
        output_tokens: outputTokens,
      },
    },
  });

  // 11. message_stop
  events.push({
    event: "message_stop",
    data: {
      type: "message_stop",
    },
  });

  return events;
}

/**
 * Create WebSearch SSE stream string
 */
export function createWebSearchSseStream(
  model: string,
  query: string,
  toolUseId: string,
  searchResults: WebSearchResults | null,
  inputTokens: number,
): string {
  const events = generateWebSearchEvents(
    model,
    query,
    toolUseId,
    searchResults,
    inputTokens,
  );
  return events.map((e) => sseEventToString(e)).join("");
}

// ============================================================================
// Handler
// ============================================================================

export interface WebSearchHandlerResult {
  type: "websearch";
  body: string;
  headers: Record<string, string>;
}

/**
 * Build a non-streaming JSON response for a web search result.
 */
function buildWebSearchJsonResponse(
  model: string,
  query: string,
  toolUseId: string,
  searchResults: WebSearchResults | null,
  inputTokens: number,
): string {
  const messageId = `msg_${uuidv4().replace(/-/g, "").substring(0, 24)}`;
  const summary = generateSearchSummary(query, searchResults);
  const outputTokens = Math.ceil(summary.length / 4);

  const searchContent = searchResults?.results?.map((r) => ({
    type: "web_search_result",
    title: r.title,
    url: r.url,
    encrypted_content: r.snippet || "",
    page_age: null,
  }));

  const response = {
    id: messageId,
    type: "message",
    role: "assistant",
    model,
    content: [
      {
        type: "server_tool_use",
        id: toolUseId,
        name: "web_search",
        input: { query },
      },
      {
        type: "web_search_tool_result",
        tool_use_id: toolUseId,
        content: searchContent || [],
      },
      {
        type: "text",
        text: summary,
      },
    ],
    stop_reason: "end_turn",
    stop_sequence: null,
    usage: {
      input_tokens: inputTokens,
      output_tokens: outputTokens,
      cache_creation_input_tokens: 0,
      cache_read_input_tokens: 0,
    },
  };

  return JSON.stringify(response);
}

/**
 * Handle WebSearch request using MCP Shim
 *
 * This function:
 * 1. Extracts the search query from the request
 * 2. Calls the MCP shim with provided configuration
 * 3. Generates a Claude-compatible SSE or JSON response (based on req.stream)
 *
 * @param req - The MessagesRequest from Claude Code
 * @param config - Optional MCP configuration for Kiro API
 * @returns SSE stream or JSON body with web search results
 */
export async function handleWebSearchRequest(
  req: MessagesRequest,
  config?: McpShimConfig,
): Promise<WebSearchHandlerResult> {
  // 1. Extract search query
  const query = extractSearchQuery(req);
  if (!query) {
    throw new Error("Cannot extract search query from message");
  }

  console.log(`[WebSearch] Processing query: ${query}`);

  const toolUseId = `srvtoolu_${uuidv4().replace(/-/g, "").substring(0, 32)}`;
  const searchResults = await callWebSearchMcpWithConfig(query, config || {});

  if (searchResults.error) {
    console.warn(`[WebSearch] MCP error: ${searchResults.error}`);
  } else if (searchResults.results.length === 0) {
    console.log("[WebSearch] No results returned");
  } else {
    console.log(`[WebSearch] Found ${searchResults.results.length} results`);
  }

  // 4. Estimate input tokens
  const systemMessages =
    typeof req.system === "string"
      ? [{ text: req.system }]
      : Array.isArray(req.system)
        ? req.system
        : undefined;
  const inputTokens = estimateInputTokens(
    systemMessages,
    req.messages,
    req.tools,
  );

  const resultsOrNull = searchResults.results.length > 0 ? searchResults : null;

  // 5. Return streaming or non-streaming response based on request
  if (req.stream) {
    const stream = createWebSearchSseStream(
      req.model,
      query,
      toolUseId,
      resultsOrNull,
      inputTokens,
    );
    return {
      type: "websearch",
      body: stream,
      headers: {
        "content-type": "text/event-stream; charset=utf-8",
        "cache-control": "no-cache",
        connection: "keep-alive",
      },
    };
  } else {
    const body = buildWebSearchJsonResponse(
      req.model,
      query,
      toolUseId,
      resultsOrNull,
      inputTokens,
    );
    return {
      type: "websearch",
      body,
      headers: { "content-type": "application/json" },
    };
  }
}
