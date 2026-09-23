import type { HttpMethod, TransportSource } from '../contract/define';
import type { McpCallContext } from '../contract/runtime-context';
import type { RequestContextKind } from './context';
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
  /**
   * A call that arrived, or work that ran on its own. Always written, including
   * on requests: a filter that has to read "the absence of `method` means a
   * job" is carrying the same implicit knowledge this field exists to remove.
   */
  kind: RequestContextKind;
  /**
   * What the work is, for work no route names — `agent-loop`, `broadcast-send`.
   * Absent on requests, which are named by method and path.
   */
  name?: string;
  /**
   * HTTP verb, `TOOL` for a tool call, and **absent** for work that did not
   * arrive over a transport. It was required, so a background loop had to write
   * something, and what it wrote was `AGENT` — not a verb, but the absence of
   * one recorded in the field for verbs.
   */
  method?: string;
  /**
   * The operation's contract verb (`GET` / `POST` / …). Set on **tool** events
   * (whose `method` is `TOOL`) so a single filter can tell a read from a write
   * across HTTP and tool calls — `(event.httpMethod ?? event.method) !== 'GET'`.
   * Omitted on HTTP events, where `method` already is the verb. → ADR 0030.
   */
  httpMethod?: HttpMethod;
  /**
   * Request path — `/api/...` for HTTP, `/{source}/{tool}` for a tool call, and
   * absent for work with no transport to have a path on.
   */
  path?: string;
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
  /**
   * Explicit non-failure outcome. Present only for event classes a sink opted
   * into; ordinary success/failure rows retain their released shape.
   */
  outcome?: 'cancelled';
  /**
   * HTTP status — the real status for HTTP, `200` / `400` for a tool call, and
   * absent for work that has no transport to have a status on.
   *
   * This one is the trap the rest of this change would otherwise have walked
   * into. Dropping `method: 'AGENT'` while still demanding a status would have
   * replaced one fabricated transport field with another, in the same row, for
   * the same reason. A job's outcome is `ok`, and `errorCode` when it failed.
   */
  statusCode?: number;
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
