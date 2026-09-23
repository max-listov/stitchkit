import type { TransportSource } from './define';

// ─── Runtime Context (built by transport, loose types) ───

/**
 * Shallow-merge a contract-wide `meta` default with an endpoint's own — endpoint
 * keys win. Returns `undefined` when neither side declares anything, because
 * readers test `method.meta?.x` and an empty object would read as "declared".
 * One level deep by design: a deep merge invites "how do I unset an inherited
 * key", which has no answer without a sentinel. → ADR 0036.
 */
export function mergeMeta(
  contractMeta: Record<string, unknown> | undefined,
  endpointMeta: Record<string, unknown> | undefined,
): Record<string, unknown> | undefined {
  if (!contractMeta) return endpointMeta;
  // Copy even when there is nothing to merge: returning the contract's own object
  // would alias it across every endpoint AND across every later `implement` of the
  // same contract, so one hook mutating `endpoint.meta` would corrupt all of them.
  // Identity is then consistent — a `MethodDef` always owns its `meta`.
  if (!endpointMeta) return { ...contractMeta };
  return { ...contractMeta, ...endpointMeta };
}

/** Self-reported MCP host identity. Attribution only — never an auth principal. */
export interface McpClientInfo {
  name: string;
  version: string;
}

/** Outcome of one opt-in MCP multi-round input attempt. */
export type McpRoundOutcome =
  | 'input_required'
  | 'declined'
  | 'cancelled'
  | 'invalid'
  | 'complete';

/**
 * Validated metadata for the active managed MCP tool call.
 *
 * `clientInfo` is supplied by the MCP host. It is useful for display and
 * operational attribution, but MUST NOT be used for authentication,
 * authorization, tenant selection or rate limiting.
 */
export interface McpCallContext {
  era: 'modern' | 'legacy';
  method: string;
  toolName: string;
  protocolVersion?: string;
  clientInfo?: McpClientInfo;
  outcome?: McpRoundOutcome;
  round?: number;
  /**
   * The host's progress token for this call, when it asked for progress.
   *
   * Declarative, like everything else on this type: it says the host is
   * listening. Reporting is `ctx.reportProgress`, which is a function and
   * therefore deliberately NOT here — this type is also the type of
   * `RequestEvent.mcp`, and an audit row's shape must not claim to carry
   * behaviour.
   */
  progressToken?: string | number;
}

/**
 * One progress update a tool handler sends to the host mid-call.
 *
 * `progress` is a number the protocol requires. It is optional here because a
 * handler often has a stage to name and no scale to name it on — "uploading",
 * "rendering frame 12" — and the honest answer to "how far along" is then the
 * ordinal of the update itself, which is what gets sent. That is a fact about
 * what happened, not a percentage nobody measured; `total` stays absent, so a
 * host renders it as an unbounded counter rather than a bar at 3%.
 */
export interface McpProgressUpdate {
  /** Human-facing stage, shown by the host while the call is still running. */
  message?: string;
  /** How far along, on whatever scale `total` implies. */
  progress?: number;
  /** The scale, when the operation knows it. */
  total?: number;
}

/**
 * Send one progress update for the call in flight.
 *
 * Present on every tool call and a no-op unless the host asked for progress by
 * sending a token, so a handler never branches on transport. It never throws
 * and never rejects: a message about work must not be able to kill the work it
 * describes. Fire-and-forget — the returned promise settles when the
 * notification has been handed to the transport, and ignoring it is correct.
 */
export type McpReportProgress = (update: McpProgressUpdate) => Promise<void>;

export interface RuntimeContext {
  params: unknown;
  input: unknown;
  files?: Record<string, unknown>;
  /** Original decoded JSON request text when the endpoint declares `rawBody: true`. */
  rawBody?: string;
  source: TransportSource;
  /**
   * The raw Web `Request`, its parsed `URL` and `Headers` — set on the HTTP
   * transport (and reachable in every lifecycle hook, including `onError` on a
   * validation failure). Absent on the non-HTTP transports (MCP / agent / CLI /
   * a bring-your-own lane), which carry no `Request`, so they are optional and a
   * reader narrows them. Web Fetch types only — the core stays Fetch-clean
   * (→ ADR 0013).
   */
  req?: Request;
  url?: URL;
  headers?: Headers;
  traceId?: string;
  spanId?: string;
  ipAddress?: string;
  userAgent?: string;
  /** Transport cancellation for the active call (MCP and future cancellable lanes). */
  signal?: AbortSignal;
  /** Validated metadata for an MCP call; absent on every other transport. */
  mcp?: McpCallContext;
  /**
   * Report progress on the call in flight.
   *
   * Present on every TOOL call — MCP, agent and CLI — and a no-op wherever
   * nobody is listening, so a handler never branches on transport to say what
   * it is doing. Absent on the HTTP transport, which has no channel for it;
   * that is why the field is optional and a handler that also serves HTTP
   * writes `ctx.reportProgress?.(…)`.
   */
  reportProgress?: McpReportProgress;
  [key: string]: unknown;
}

// ─── Handler Context (typed, inferred from endpoint) ─────

export interface HandlerContext<TParams = undefined, TInput = undefined> {
  params: TParams;
  input: TInput;
  files?: Record<string, unknown>;
  /** Original decoded JSON request text when the endpoint declares `rawBody: true`. */
  rawBody?: string;
  source: TransportSource;
  /** Raw Web `Request` / `URL` / `Headers` — set on the HTTP transport, absent
   *  on the tool transports (see {@link RuntimeContext}). */
  req?: Request;
  url?: URL;
  headers?: Headers;
  traceId?: string;
  spanId?: string;
  ipAddress?: string;
  userAgent?: string;
  /** Validated metadata for an MCP call; absent on every other transport. */
  mcp?: McpCallContext;
  /** Report progress on the call in flight — a no-op when none was asked for. */
  reportProgress?: McpReportProgress;
  [key: string]: unknown;
}
