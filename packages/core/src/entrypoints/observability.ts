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
  type ObservabilityDrainBound,
  type ProjectedDimensions,
  type RequestEventSinkConfig,
  type RequestObservabilityConfig,
  type SinkDrop,
  type SinkDropReason,
  type SinkError,
} from '../observability/audit';
export {
  type BoundedLoggerBounds,
  type BoundedLoggerOptions,
  createBoundedLogger,
  DEFAULT_REDACT_PATHS,
} from '../observability/bounded-logger';
export { auditChanges } from '../observability/changes';
export {
  type DimensionCollision,
  getRequestContext,
  getTraceId,
  getUserId,
  type RequestContext,
  type RequestContextKind,
  runWithRequestContext,
  type SetRequestDimensionsOptions,
  setRequestDimensions,
  setRequestEndpoint,
  setRequestError,
  setRequestUser,
  type WrapRequestContextOptions,
  wrapInRequestContext,
} from '../observability/context';
export type { RequestEvent } from '../observability/event';
export {
  createEventLoopDelayMonitor,
  DEFAULT_EVENT_LOOP_DELAY_BUCKET_MS,
  DEFAULT_EVENT_LOOP_DELAY_RESOLUTION_MS,
  DEFAULT_EVENT_LOOP_DELAY_WINDOW_MS,
  type EventLoopDelayClock,
  type EventLoopDelayHistogram,
  type EventLoopDelayMonitor,
  type EventLoopDelayMonitorOptions,
  type EventLoopDelaySnapshot,
  MAX_EVENT_LOOP_DELAY_BUCKETS,
} from '../observability/event-loop-delay';
export {
  createJsonLogger,
  JSON_LOG_LEVELS,
  type JsonLoggerOptions,
  type JsonLogLevel,
} from '../observability/json-logger';
export {
  DEFAULT_REPEAT_MAX_KINDS,
  DEFAULT_REPEAT_WINDOW_MS,
  type RepeatLimitOptions,
  repeatLimited,
} from '../observability/log-repeat';
export {
  type JsonValue,
  measureSize,
  redact,
  type SanitizeOptions,
  type SizeMeasure,
  sanitizePayload,
  truncatePreview,
} from '../observability/sanitize';
export { type SecretValuesOptions, secretValuesFromEnv } from '../observability/secret-values';
export {
  createSpooledSink,
  type SpooledSink,
  type SpooledSinkConfig,
  type SpoolRecovery,
} from '../observability/spool';
export {
  type ObservabilityDrainReport,
  ObservabilityDrainReportSchema,
  type ObservabilitySinkStatus,
  ObservabilitySinkStatusSchema,
  type ObservabilityStatus,
  ObservabilityStatusSchema,
} from '../observability/status';
export {
  childSpan,
  createTraceContext,
  formatTraceparent,
  parseTraceparent,
  resolvePropagationContext,
  resolveTraceContext,
  type TraceContext,
} from '../observability/trace';
export { type RunUnitOfWorkOptions, runUnitOfWork } from '../observability/work';
