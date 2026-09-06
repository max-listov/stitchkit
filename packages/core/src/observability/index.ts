/**
 * `stitchkit/observability` — the audit layer one level above the raw hooks.
 *
 * W3C trace context, an `AsyncLocalStorage` request context, payload
 * sanitisation, a normalised `RequestEvent`, and `createObservability` to wire
 * framework-owned HTTP completion plus canonical tool hooks into independent
 * sinks.
 */
export {
  createDimensionsProjector,
  createObservability,
  type DimensionsProjector,
  type DimensionsProjectorConfig,
  type HttpRequestCompletion,
  type HttpRequestObserver,
  type Observability,
  type ObservabilityConfig,
  type ProjectedDimensions,
  type RequestEventSinkConfig,
  type RequestObservabilityConfig,
  type SinkDrop,
  type SinkDropReason,
  type SinkError,
} from './audit';
export {
  type BoundedLoggerBounds,
  type BoundedLoggerOptions,
  createBoundedLogger,
  DEFAULT_REDACT_PATHS,
} from './bounded-logger';
export {
  type DimensionCollision,
  getRequestContext,
  getTraceId,
  getUserId,
  type RequestContext,
  runWithRequestContext,
  type SetRequestDimensionsOptions,
  setRequestDimensions,
  setRequestEndpoint,
  setRequestError,
  setRequestUser,
  type WrapRequestContextOptions,
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
  type ObservabilityDrainReport,
  ObservabilityDrainReportSchema,
  type ObservabilitySinkStatus,
  ObservabilitySinkStatusSchema,
  type ObservabilityStatus,
  ObservabilityStatusSchema,
} from './status';
export {
  childSpan,
  createTraceContext,
  formatTraceparent,
  parseTraceparent,
  resolvePropagationContext,
  resolveTraceContext,
  type TraceContext,
} from './trace';
