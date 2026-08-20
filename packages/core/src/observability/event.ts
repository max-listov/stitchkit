import type { HttpMethod, McpCallContext, TransportSource } from '../contract';
import type { JsonValue } from './sanitize';

/**
 * A normalised audit event — one shape for a completed call on any surface
 * (an HTTP request, an MCP tool call, an agent tool call). `createObservability`
 * produces it and hands it to the configured surface sink. The project maps it
 * onto its own audit table; stitchkit owns the normalisation.
 */
export interface RequestEvent {
  /** Surface the call arrived on. */
  source: TransportSource;
  /** HTTP verb, or `TOOL` for a tool call. */
  method: string;
  /**
   * The operation's contract verb (`GET` / `POST` / …). Set on **tool** events
   * (whose `method` is `TOOL`) so a single filter can tell a read from a write
   * across HTTP and tool calls — `(event.httpMethod ?? event.method) !== 'GET'`.
   * Omitted on HTTP events, where `method` already is the verb. → ADR 0030.
   */
  httpMethod?: HttpMethod;
  /** Request path — `/api/...` for HTTP, `/{source}/{tool}` for a tool call. */
  path: string;
  /**
   * Stable owning-contract identity of the matched operation — the "service"
   * (contract prefix) and "action" (endpoint key) halves. Set on every surface
   * (HTTP, MCP, agent) from the contract, not parsed from `path`. → ADR 0022.
   */
  serviceName?: string;
  action?: string;
  /**
   * App-defined domain dimensions for the call — e.g. a tenant / project /
   * entity id. An opaque bag the core attaches no meaning to (→ ADR 0021);
   * populated by `setRequestDimensions`. The sink maps it onto its own columns
   * instead of re-deriving identity from the path.
   */
  dimensions?: Record<string, string>;
  /** Tool name — tool calls only. */
  toolName?: string;
  /** Distinguishes a completed operation from an MRTR input-gating round. */
  toolPhase?: 'operation' | 'input-round';
  /** Validated MCP transport attribution, available only on MCP tool calls. */
  mcp?: McpCallContext;
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
  /**
   * Structured error detail — failures only. On HTTP, what the error handler
   * recorded via `setRequestError({ details })` (e.g. the failing validation
   * issues the `errorMessage` string flattens); on a tool call, the failed
   * `ToolResult.details` (sanitised).
   */
  errorDetail?: JsonValue;
  /** Sanitised request payload — the HTTP body or the tool arguments. */
  payload: JsonValue | null;
  /** Item count of the result, when it is a list. */
  resultSize: number | null;
  /** Serialised byte length of the result. */
  responseBytes: number;
  /**
   * Set when the result could not be serialised at all (bigint, a cycle) —
   * distinguishes `responseBytes: 0` "nothing returned" from "unmeasurable".
   */
  resultUnserializable?: boolean;
  /** Resolved user id, when authenticated. */
  userId?: string;
  /** How the caller authenticated, when the app records it on the context. */
  authMethod?: string;
  /** Client id the call was made under (e.g. an OAuth client), when recorded. */
  clientId?: string;
  /** Client IP. */
  ipAddress?: string;
  /** Client user-agent. */
  userAgent?: string;
  /** When the call started. */
  startedAt: Date;
}
