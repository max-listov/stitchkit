/**
 * W3C Trace Context — `traceparent` parsing, formatting and span chaining.
 *
 * `traceparent` format: `00-{traceId:32hex}-{spanId:16hex}-{flags:2hex}`.
 * Spec: https://www.w3.org/TR/trace-context/
 *
 * A trace id is stable across every span of one logical request — it ties the
 * front-end call, the HTTP handler and each nested tool call into one timeline.
 * A span id is unique to a single operation within that trace.
 */

import { randomHex } from '../internal/random-hex';

/** A point in a distributed trace — one trace, one span, an optional parent. */
export interface TraceContext {
  /** 32-hex trace id — stable across every span of one logical request. */
  traceId: string;
  /** 16-hex span id — unique to this operation. */
  spanId: string;
  /** 16-hex id of the span that caused this one, when there is one. */
  parentSpanId?: string;
  /** Valid bounded W3C vendor trace state, retained for propagation. */
  tracestate?: string;
  /** Valid bounded W3C baggage, retained for propagation only. */
  baggage?: string;
  /** W3C trace flags byte, preserved end to end (for example `00` or `01`). */
  traceFlags?: string;
}

const TRACEPARENT_RE = /^([0-9a-f]{2})-([0-9a-f]{32})-([0-9a-f]{16})-([0-9a-f]{2})(.*)$/i;

/** A fresh root trace — a new trace id, a new span id, no parent. */
export function createTraceContext(): TraceContext {
  return { traceId: randomHex(16), spanId: randomHex(8) };
}

/**
 * Parse a `traceparent` header into a `TraceContext`. The inbound span id
 * becomes THIS context's `parentSpanId` and a fresh span id is minted — the
 * receiver opens a new span under the caller's trace. Returns `null` for a
 * missing or malformed header.
 */
export function parseTraceparent(header: string | null | undefined): TraceContext | null {
  if (!header) return null;
  const match = TRACEPARENT_RE.exec(header.trim());
  if (!match?.[1] || !match[2] || !match[3] || !match[4] || match[5] === undefined)
    return null;
  const version = match[1].toLowerCase();
  if (version === 'ff') return null;
  const suffix = match[5];
  if (
    version === '00' ? suffix !== '' : suffix !== '' && !/^(?:-[0-9a-f]{2,})+$/i.test(suffix)
  ) {
    return null;
  }
  const traceId = match[2].toLowerCase();
  const parentSpanId = match[3].toLowerCase();
  const traceFlags = match[4].toLowerCase();
  // The W3C spec mandates rejecting the all-zero trace / span id as invalid.
  if (/^0+$/.test(traceId) || /^0+$/.test(parentSpanId)) return null;
  return { traceId, spanId: randomHex(8), parentSpanId, traceFlags };
}

/** Render a `TraceContext` with its actual W3C trace-flags byte. */
export function formatTraceparent(ctx: TraceContext): string {
  return `00-${ctx.traceId}-${ctx.spanId}-${ctx.traceFlags ?? '01'}`;
}

/**
 * The trace for an incoming request — the caller's `traceparent` continued
 * when present and valid, else a fresh root trace.
 */
export function resolveTraceContext(req: Request): TraceContext {
  return parseTraceparent(req.headers.get('traceparent')) ?? createTraceContext();
}

/**
 * A child span of `parent` — the same trace id, a fresh span id, `parentSpanId`
 * set to the parent's span. Open one per nested operation (e.g. each tool call
 * inside an HTTP request).
 */
export function childSpan(parent: TraceContext): TraceContext {
  return {
    traceId: parent.traceId,
    spanId: randomHex(8),
    parentSpanId: parent.spanId,
    ...(parent.tracestate !== undefined && { tracestate: parent.tracestate }),
    ...(parent.baggage !== undefined && { baggage: parent.baggage }),
    ...(parent.traceFlags !== undefined && { traceFlags: parent.traceFlags }),
  };
}

const encoder = new TextEncoder();

function boundedPropagationValue(
  value: unknown,
  maxBytes: number,
  maxMembers: number,
): string | undefined {
  if (typeof value !== 'string') return undefined;
  const trimmed = value.trim();
  if (!trimmed || encoder.encode(trimmed).byteLength > maxBytes) return undefined;
  for (const character of trimmed) {
    const code = character.charCodeAt(0);
    if (code <= 31 || code === 127) return undefined;
  }
  const members = trimmed.split(',');
  if (members.length > maxMembers || members.some((member) => !member.trim())) {
    return undefined;
  }
  return trimmed;
}

/**
 * Continue an MCP/W3C propagation envelope. A present but invalid
 * `traceparent` starts a fresh local trace; an absent one reuses `fallback`
 * (the enclosing HTTP request) or opens a root for transport-native calls.
 */
export function resolvePropagationContext(
  metadata: Record<string, unknown> | undefined,
  fallback?: TraceContext,
): TraceContext {
  const traceparent = metadata?.traceparent;
  const parsed = typeof traceparent === 'string' ? parseTraceparent(traceparent) : null;
  const trace =
    traceparent === undefined
      ? (fallback ?? createTraceContext())
      : (parsed ?? createTraceContext());
  const tracestate = parsed
    ? boundedPropagationValue(metadata?.tracestate, 512, 32)
    : undefined;
  // W3C Baggage is independent of Trace Context and may propagate even when a
  // malformed traceparent starts a fresh trace. Tracestate is traceparent-bound.
  const baggage = boundedPropagationValue(metadata?.baggage, 8192, 180);
  return {
    ...trace,
    ...(tracestate !== undefined && { tracestate }),
    ...(baggage !== undefined && { baggage }),
  };
}
