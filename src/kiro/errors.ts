import type { KiroFailureDetails } from "./types.ts";

export function errorRecord(value: unknown): Record<string, unknown> | undefined {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined;
}

function firstString(...values: unknown[]): string | undefined {
  return values.find((value): value is string => typeof value === "string" && value.length > 0);
}

export function upstreamErrorMessage(payload: unknown, fallback: string): string {
  const body = errorRecord(payload);
  const nested = errorRecord(body?.error);
  return firstString(body?.message, body?.errorMessage, nested?.message, body?.explanation) ?? fallback;
}

export function upstreamErrorCode(payload: unknown, fallback: string): string {
  const body = errorRecord(payload);
  const nested = errorRecord(body?.error);
  return firstString(body?.code, body?.errorCode, nested?.code, body?.reason, body?.__type) ?? fallback;
}

export class KiroUpstreamError extends Error {
  constructor(
    public readonly code: string,
    message: string,
    public readonly source: "refusal" | "error" | "exception" | "http",
    public readonly upstream?: KiroFailureDetails,
    public readonly statusCode = 502,
    public readonly errorType = "api_error",
  ) {
    super(message);
    this.name = "KiroUpstreamError";
  }

  static fromHttp(status: number, payload: unknown): KiroUpstreamError {
    const fallback = typeof payload === "string" && payload
      ? payload.replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim()
      : `Kiro returned HTTP ${status}`;
    return new KiroUpstreamError(
      upstreamErrorCode(payload, `HTTP_${status}`),
      upstreamErrorMessage(payload, fallback),
      "http",
      { payload },
      status,
      status === 401 ? "authentication_error" : status === 403 ? "permission_error" : "api_error",
    );
  }
}

export class KiroRefusalError extends KiroUpstreamError {
  constructor(code: string, message: string, upstream?: KiroFailureDetails) {
    super(code, message, "refusal", upstream, 403, "permission_error");
    this.name = "KiroRefusalError";
  }
}

export interface KiroErrorDiagnostics {
  id: string;
  source: KiroUpstreamError["source"];
  code: string;
  upstream_status?: number;
  upstream_request_id?: string;
  message_type?: string;
  event_type?: string;
  payload?: unknown;
  account_id: number;
  requested_model: string;
  upstream_model?: string;
  conversation_id?: string;
  replay?: Record<string, number>;
}

export function kiroErrorResponse(error: KiroUpstreamError, diagnostics: KiroErrorDiagnostics) {
  const labels = [
    `source=${diagnostics.event_type ?? diagnostics.message_type ?? error.source}`,
    `code=${error.code}`,
    ...(diagnostics.upstream_status !== undefined ? [`upstream_http=${diagnostics.upstream_status}`] : []),
    ...(diagnostics.upstream_request_id ? [`request_id=${diagnostics.upstream_request_id}`] : []),
    `diagnostic_id=${diagnostics.id}`,
  ];
  // CLI clients often show only error.message. Include the provider's original
  // metadata there as well as in the structured diagnostics, without truncation.
  const payload = error.upstream?.payload;
  if (payload !== undefined && payload !== error.message)
    labels.push(`details=${JSON.stringify(payload)}`);
  return {
    type: "error",
    error: {
      type: error.errorType,
      code: error.code,
      message: `${error.message} [Kiro ${labels.join("; ")}]`,
      upstream: diagnostics,
    },
  };
}
