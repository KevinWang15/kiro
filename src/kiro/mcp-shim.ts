import axios from "axios";
import { v4 as uuidv4 } from "uuid";
import * as crypto from "node:crypto";
import * as os from "node:os";
import { buildAgentFromProxy } from "../proxy.ts";
import { getKiroRuntimeBaseUrl, getKiroRuntimeHost } from "./constants.ts";
import type { McpRequest, McpResponse, WebSearchResults } from "./websearch.ts";

export interface McpShimConfig {
  region?: string;
  runtimeRegion?: string;
  accessToken?: string;
  refreshToken?: string;
  clientIdHash?: string;
  authMethod?: string;
  provider?: string;
  profileArn?: string;
  proxy?: {
    type?: string;
    url?: string;
    basicAuthUsername?: string | null;
    basicAuthPassword?: string | null;
  } | null;
  timeoutMs?: number;
  kiroVersion?: string;
}

function generateMachineId(config: McpShimConfig): string {
  const uniqueKey = config.refreshToken
    ? `KotlinNativeAPI/${config.refreshToken}`
    : config.clientIdHash ||
      config.accessToken?.slice(-32) ||
      "KIRO_DEFAULT_MACHINE";
  return crypto.createHash("sha256").update(uniqueKey).digest("hex");
}

function buildMcpHeaders(config: McpShimConfig): Record<string, string> {
  const version = config.kiroVersion || "0.9.2";
  const machineId = generateMachineId(config);
  const nodeVersion = process.version.replace("v", "");
  const headers: Record<string, string> = {
    "content-type": "application/json",
    "x-amz-user-agent": `aws-sdk-js/1.0.27 KiroIDE-${version}-${machineId}`,
    "user-agent": `aws-sdk-js/1.0.27 ua/2.1 os/${os.platform()} lang/js md/nodejs#${nodeVersion} api/codewhispererstreaming#1.0.27 m/E KiroIDE-${version}-${machineId}`,
    host: getKiroRuntimeHost(config),
    "amz-sdk-invocation-id": uuidv4(),
    "amz-sdk-request": "attempt=1; max=3",
    Authorization: `Bearer ${config.accessToken}`,
    Connection: "close",
  };
  if (config.profileArn) headers["x-amzn-kiro-profile-arn"] = config.profileArn;
  if (
    ["api_key", "apikey"].includes(
      config.authMethod?.trim().toLowerCase() || "",
    )
  )
    headers.tokentype = "API_KEY";
  if (config.authMethod === "external_idp" || config.provider === "ExternalIdp")
    headers.TokenType = "EXTERNAL_IDP";
  return headers;
}

function mcpError(requestId: string, message: string): McpResponse {
  return { id: requestId, jsonrpc: "2.0", error: { code: -32603, message } };
}

function throwOnAuthError(error: { message?: string }): void {
  const statusCode = Number(error.message?.match(/:\s*(\d{3})\s*-/)?.[1]);
  if ([401, 402, 403].includes(statusCode)) {
    const errorWithStatus = new Error(error.message) as Error & {
      statusCode?: number;
    };
    errorWithStatus.statusCode = statusCode;
    throw errorWithStatus;
  }
}

async function callMcp(
  request: McpRequest,
  config: McpShimConfig,
): Promise<McpResponse> {
  if (!config.accessToken)
    return mcpError(request.id, "No access token available for MCP request");
  const httpsAgent = buildAgentFromProxy(config.proxy || undefined);
  try {
    const response = await axios({
      method: "POST",
      url: `${getKiroRuntimeBaseUrl(config)}/mcp`,
      headers: buildMcpHeaders(config),
      data: request,
      timeout: config.timeoutMs || 30000,
      validateStatus: () => true,
      httpsAgent: httpsAgent || undefined,
      ...(httpsAgent ? { proxy: false as const } : {}),
    });
    if (response.status >= 200 && response.status < 300)
      return response.data as McpResponse;
    const suffix = `${response.status} - ${JSON.stringify(response.data)}`;
    if (response.status === 401 || response.status === 403)
      return mcpError(request.id, `Authentication failed: ${suffix}`);
    if (response.status === 429)
      return mcpError(request.id, `Rate limited: ${suffix}`);
    return mcpError(request.id, `MCP request failed: ${suffix}`);
  } catch (error) {
    return mcpError(
      request.id,
      `MCP request error: ${(error as Error).message}`,
    );
  }
}

export async function callWebSearchMcpWithConfig(
  query: string,
  config: McpShimConfig,
): Promise<WebSearchResults> {
  const request: McpRequest = {
    id: `web_search_${Date.now()}`,
    jsonrpc: "2.0",
    method: "tools/call",
    params: { name: "web_search", arguments: { query } },
  };
  const response = await callMcp(request, config);
  if (response.error) {
    throwOnAuthError(response.error);
    return {
      results: [],
      totalResults: 0,
      query,
      error: response.error.message || "Unknown MCP error",
    };
  }
  if (!response.result?.content?.[0]?.text)
    return { results: [], totalResults: 0, query };
  try {
    return { ...JSON.parse(response.result.content[0].text), query };
  } catch {
    return {
      results: [],
      totalResults: 0,
      query,
      error: "Failed to parse search results",
    };
  }
}
