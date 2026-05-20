/**
 * `stitchkit/observability` — the audit layer one level above the raw hooks.
 *
 * W3C trace context, an `AsyncLocalStorage` request context, payload
 * sanitisation, a normalised `RequestEvent`, and `createAuditHook` to wire it
 * all into one sink. A project's logging becomes a table plus a `write`
 * function — nothing else.
 */
export { type AuditConfig, type AuditHook, createAuditHook } from './audit';
export {
  getRequestContext,
  getTraceId,
  getUserId,
  type RequestContext,
  runWithRequestContext,
  setRequestError,
  setRequestUser,
  wrapInRequestContext,
} from './context';
export type { RequestEvent } from './event';
export {
  type JsonValue,
  measureSize,
  redact,
  type SanitizeOptions,
  type SizeMeasure,
  sanitizePayload,
  truncatePreview,
} from './sanitize';
export {
  childSpan,
  createTraceContext,
  formatTraceparent,
  parseTraceparent,
  resolveTraceContext,
  type TraceContext,
} from './trace';
