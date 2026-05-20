import type { TransportSource } from '../contract';
import type { JsonValue } from './sanitize';

/**
 * A normalised audit event — one shape for a completed call on any surface
 * (an HTTP request, an MCP tool call, an agent tool call). `createAuditHook`
 * produces it and hands it to the project's `write` sink. The project maps it
 * onto its own audit table; stitchkit owns the normalisation.
 */
export interface RequestEvent {
  /** Surface the call arrived on. */
  source: TransportSource;
  /** HTTP verb, or `TOOL` for a tool call. */
  method: string;
  /** Request path — `/api/...` for HTTP, `/{source}/{tool}` for a tool call. */
  path: string;
  /** Tool name — tool calls only. */
  toolName?: string;
  /** W3C trace id — correlates every span of one logical request. */
  traceId: string;
  /** W3C span id — unique to this call. */
  spanId: string;
  /** Parent span id, when this call is nested under another. */
  parentSpanId?: string;
  /** Whether the call succeeded. */
  ok: boolean;
  /** HTTP status — the real status for HTTP, `200` / `400` for a tool call. */
  statusCode: number;
  /** Wall-clock duration. */
  durationMs: number;
  /** Error code — failures only. */
  errorCode?: string;
  /** Error message — failures only. */
  errorMessage?: string;
  /** Sanitised request payload — the HTTP body or the tool arguments. */
  payload: JsonValue | null;
  /** Item count of the result, when it is a list. */
  resultSize: number | null;
  /** Serialised byte length of the result. */
  responseBytes: number;
  /** Resolved user id, when authenticated. */
  userId?: string;
  /** Client IP. */
  ipAddress?: string;
  /** Client user-agent. */
  userAgent?: string;
  /** When the call started. */
  startedAt: Date;
}
