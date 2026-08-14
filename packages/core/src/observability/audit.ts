/**
 * Framework-owned observability projections. HTTP completion is captured once
 * by `createHandler`; tool completion comes from the canonical tool hooks.
 * Both are normalised into `RequestEvent` without nested fetch wrappers.
 */
import { recordedErrorMessage } from '../internal/errors';
import { isRecord } from '../internal/typed';
import type { ToolCallHooks, ToolResult } from '../tools/execute';
import { getRequestContext, type RequestContext } from './context';
import type { RequestEvent } from './event';
import { measureSize, type SanitizeOptions, sanitizePayload } from './sanitize';
import {
  aggregateObservabilityStatus,
  type ObservabilityDrainReport,
  ObservabilityDrainReportSchema,
  type ObservabilitySinkStatus,
  ObservabilitySinkStatusSchema,
  type ObservabilityStatus,
  ObservabilityStatusSchema,
} from './status';
import { childSpan, createTraceContext } from './trace';

/** One isolated RequestEvent sink and its sanitisation policy. */
export interface RequestEventSinkConfig {
  /**
   * The sink — persists one audit event. It runs fire-and-forget; failures are
   * reported through `onSinkError` without breaking the observed work.
   */
  write: (event: RequestEvent) => void | Promise<void>;
  /** Keep only events for which this returns `true`. Default: keep every event. */
  filter?: (event: RequestEvent) => boolean;
  /** Payload sanitisation tuning — passed through to `sanitizePayload`. */
  sanitize?: SanitizeOptions;
  /** Maximum writes concurrently awaiting settlement. Default: 1000. */
  maxPending?: number;
  /** Observe failed filtering, projection or persistence. */
  onSinkError?: (failure: SinkError) => void | Promise<void>;
  /** Observe events rejected by bounded or closed admission. */
  onDrop?: (drop: SinkDrop) => void | Promise<void>;
}

export type SinkDropReason = 'capacity' | 'closed';

export interface SinkError {
  error: unknown;
  event?: RequestEvent;
}

export interface SinkDrop {
  reason: SinkDropReason;
  event: RequestEvent;
  pending: number;
}

export interface RequestObservabilityConfig extends RequestEventSinkConfig {
  /** Clone and record JSON request bodies. Default false. */
  includePayload?: boolean;
}

export interface ObservabilityConfig {
  request?: RequestObservabilityConfig;
  tools?: RequestEventSinkConfig;
}

/** The one HTTP completion snapshot produced by the handler. */
export interface HttpRequestCompletion {
  context: RequestContext;
  statusCode: number;
  durationMs: number;
  payload?: Promise<unknown>;
}

/** Server-facing request projection returned by `createObservability`. */
export interface HttpRequestObserver {
  includePayload: boolean;
  complete(completion: HttpRequestCompletion): void;
}

/** What `createObservability` returns — one wiring point per enabled surface. */
export interface Observability {
  request?: HttpRequestObserver;
  toolCall: ToolCallHooks;
  /** Wait for events admitted before this call. */
  flush(): Promise<void>;
  /** Read an immutable snapshot of each enabled sink and their aggregate. */
  getStatus(): ObservabilityStatus;
  /** Stop admission and drain every previously accepted event. Idempotent. */
  close(): Promise<ObservabilityDrainReport>;
}

/** Pull a human-readable message out of a failed `ToolResult`. */
function toolErrorMessage(result: Extract<ToolResult, { ok: false }>): string | undefined {
  const { details, hint } = result;
  if (isRecord(details) && typeof details.message === 'string') {
    return details.message;
  }
  return hint;
}

/**
 * The message for a failed tool row — the shared rule (→ ADR 0042) applied to a
 * `ToolResult`. Its HTTP twin lives in `respondError`.
 */
function auditErrorMessage(
  result: Extract<ToolResult, { ok: false }>,
  thrown: unknown,
): string | undefined {
  return recordedErrorMessage(result.code, toolErrorMessage(result), thrown);
}

/** A context field is only useful when it is actually a string. */
function readString(value: unknown): string | undefined {
  return typeof value === 'string' ? value : undefined;
}

function readMcpContext(value: unknown): RequestEvent['mcp'] | undefined {
  if (!isRecord(value)) return undefined;
  const era = value.era;
  const method = value.method;
  const toolName = value.toolName;
  if (
    (era !== 'modern' && era !== 'legacy') ||
    typeof method !== 'string' ||
    typeof toolName !== 'string'
  ) {
    return undefined;
  }
  const protocolVersion = readString(value.protocolVersion);
  const clientInfoValue = value.clientInfo;
  const clientInfo =
    isRecord(clientInfoValue) &&
    typeof clientInfoValue.name === 'string' &&
    typeof clientInfoValue.version === 'string'
      ? { name: clientInfoValue.name, version: clientInfoValue.version }
      : undefined;
  const outcomeValue = value.outcome;
  const outcome =
    outcomeValue === 'input_required' ||
    outcomeValue === 'declined' ||
    outcomeValue === 'cancelled' ||
    outcomeValue === 'invalid' ||
    outcomeValue === 'complete'
      ? outcomeValue
      : undefined;
  const round =
    typeof value.round === 'number' && Number.isInteger(value.round) && value.round >= 0
      ? value.round
      : undefined;
  return {
    era,
    method,
    toolName,
    ...(protocolVersion !== undefined && { protocolVersion }),
    ...(clientInfo !== undefined && { clientInfo }),
    ...(outcome !== undefined && { outcome }),
    ...(round !== undefined && { round }),
  };
}

const DEFAULT_MAX_PENDING = 1000;

interface SinkManager {
  submit(produce: () => RequestEvent | Promise<RequestEvent>): void;
  flush(): Promise<void>;
  getStatus(): ObservabilitySinkStatus;
  close(): Promise<ObservabilitySinkStatus>;
}

function invokeIsolated(callback: (() => void | Promise<void>) | undefined): void {
  if (!callback) return;
  void Promise.resolve()
    .then(callback)
    .catch(() => {
      // Diagnostics cannot create an unhandled rejection.
    });
}

function createSinkManager(config: RequestEventSinkConfig): SinkManager {
  const maxPending = config.maxPending ?? DEFAULT_MAX_PENDING;
  if (!Number.isSafeInteger(maxPending) || maxPending <= 0) {
    throw new TypeError('Observability maxPending must be a positive safe integer');
  }

  let sequence = 0;
  let closed = false;
  let received = 0;
  let accepted = 0;
  let filtered = 0;
  let completed = 0;
  let dropped = 0;
  let failed = 0;
  let preparationFailed = 0;
  let closePromise: Promise<ObservabilitySinkStatus> | undefined;
  const preparing = new Map<number, Promise<void>>();
  const writes = new Map<number, Promise<void>>();

  const reportError = (error: unknown, event?: RequestEvent): void => {
    invokeIsolated(
      config.onSinkError
        ? () => config.onSinkError?.({ error, ...(event !== undefined && { event }) })
        : undefined,
    );
  };
  const reportDrop = (reason: SinkDropReason, event: RequestEvent): void => {
    invokeIsolated(
      config.onDrop
        ? () => config.onDrop?.({ reason, event, pending: writes.size })
        : undefined,
    );
  };
  const admit = (id: number, event: RequestEvent): void => {
    try {
      if (config.filter && !config.filter(event)) {
        filtered += 1;
        return;
      }
    } catch (error) {
      preparationFailed += 1;
      reportError(error, event);
      return;
    }
    if (writes.size >= maxPending) {
      dropped += 1;
      reportDrop('capacity', event);
      return;
    }
    accepted += 1;
    const write = Promise.resolve()
      .then(() => config.write(event))
      .then(() => {
        completed += 1;
      })
      .catch((error) => {
        failed += 1;
        reportError(error, event);
      })
      .finally(() => writes.delete(id));
    writes.set(id, write);
  };
  const awaitGeneration = async (boundary: number): Promise<void> => {
    const through = <T>(values: Map<number, T>): T[] =>
      [...values].filter(([id]) => id <= boundary).map(([, value]) => value);
    await Promise.allSettled(through(preparing));
    await Promise.allSettled(through(writes));
  };

  return {
    submit(produce) {
      received += 1;
      const id = ++sequence;
      if (closed) {
        void Promise.resolve()
          .then(produce)
          .then((event) => {
            dropped += 1;
            reportDrop('closed', event);
          })
          .catch((error) => {
            preparationFailed += 1;
            reportError(error);
          });
        return;
      }
      const preparation = Promise.resolve()
        .then(produce)
        .then((event) => admit(id, event))
        .catch((error) => {
          preparationFailed += 1;
          reportError(error);
        })
        .finally(() => preparing.delete(id));
      preparing.set(id, preparation);
    },
    flush() {
      return awaitGeneration(sequence);
    },
    getStatus() {
      return ObservabilitySinkStatusSchema.parse({
        capacity: maxPending,
        received,
        accepted,
        filtered,
        completed,
        dropped,
        failed,
        preparationFailed,
        preparing: preparing.size,
        pending: writes.size,
        closed,
      });
    },
    close() {
      if (closePromise) return closePromise;
      closed = true;
      closePromise = awaitGeneration(sequence).then(() =>
        ObservabilitySinkStatusSchema.parse({
          capacity: maxPending,
          received,
          accepted,
          filtered,
          completed,
          dropped,
          failed,
          preparationFailed,
          preparing: preparing.size,
          pending: writes.size,
          closed,
        }),
      );
      return closePromise;
    },
  };
}

export function createObservability(config: ObservabilityConfig): Observability {
  const requestManager = config.request ? createSinkManager(config.request) : undefined;
  const toolManager = config.tools ? createSinkManager(config.tools) : undefined;
  let closed = false;
  let closePromise: Promise<ObservabilityDrainReport> | undefined;
  const request: HttpRequestObserver | undefined = config.request
    ? {
        includePayload: config.request.includePayload ?? false,
        complete: ({ context, statusCode, durationMs, payload }) => {
          const requestConfig = config.request;
          if (!requestConfig) return;
          requestManager?.submit(async () => {
            let body: unknown;
            if (payload) {
              try {
                body = await payload;
              } catch {
                body = undefined;
              }
            }
            return {
              source: context.source,
              method: context.method,
              path: context.path,
              ...(context.serviceName !== undefined && {
                serviceName: context.serviceName,
              }),
              ...(context.action !== undefined && { action: context.action }),
              ...(context.dimensions !== undefined && {
                dimensions: context.dimensions,
              }),
              traceId: context.trace.traceId,
              spanId: context.trace.spanId,
              parentSpanId: context.trace.parentSpanId,
              ok: statusCode < 400,
              statusCode,
              durationMs,
              errorCode: context.error?.code,
              errorMessage: context.error?.message,
              ...(context.error?.details !== undefined && {
                errorDetail: sanitizePayload(context.error.details, requestConfig.sanitize),
              }),
              payload: sanitizePayload(body, requestConfig.sanitize),
              resultSize: null,
              responseBytes: 0,
              userId: context.userId,
              ipAddress: context.ipAddress,
              userAgent: context.userAgent,
              startedAt: new Date(Date.now() - durationMs),
            };
          });
        },
      }
    : undefined;

  const toolCall: ToolCallHooks | undefined = config.tools
    ? {
        afterToolCall: ({ toolName, args, result, durationMs, context, endpoint, error }) => {
          try {
            // EVERYTHING lives inside the try — even reading the config: a
            // throwing config getter must not reach the observed call.
            const toolConfig = config.tools;
            if (!toolConfig) return;
            // Each tool call is a span. Under an HTTP request it is a child of that
            // request's span; on its own (a stdio server) it opens a fresh trace.
            const requestCtx = getRequestContext();
            const span = requestCtx ? childSpan(requestCtx.trace) : createTraceContext();
            const measure = result.ok
              ? measureSize(result.data)
              : { resultSize: null, responseBytes: 0 };
            const mcp = context.source === 'mcp' ? readMcpContext(context.mcp) : undefined;
            const toolPhase = mcp?.outcome === 'input_required' ? 'input-round' : 'operation';
            toolManager?.submit(() => ({
              source: context.source,
              method: 'TOOL',
              httpMethod: endpoint.method,
              path: `/${context.source}/${toolName}`,
              serviceName: endpoint.serviceName,
              action: endpoint.key,
              ...(requestCtx?.dimensions !== undefined && {
                dimensions: requestCtx.dimensions,
              }),
              toolName,
              toolPhase,
              ...(mcp !== undefined && { mcp }),
              traceId: span.traceId,
              spanId: span.spanId,
              parentSpanId: span.parentSpanId,
              ok: result.ok,
              statusCode: result.ok ? 200 : 400,
              durationMs,
              errorCode: result.ok ? undefined : result.code,
              errorMessage: result.ok ? undefined : auditErrorMessage(result, error),
              ...(!result.ok &&
                result.details !== undefined && {
                  errorDetail: sanitizePayload(result.details, toolConfig.sanitize),
                }),
              payload: sanitizePayload(args, toolConfig.sanitize),
              resultSize: measure.resultSize,
              responseBytes: measure.responseBytes,
              ...('unserializable' in measure &&
                measure.unserializable && { resultUnserializable: true }),
              userId: readString(context.userId),
              authMethod: readString(context.authMethod),
              clientId: readString(context.clientId),
              ipAddress: readString(context.ipAddress),
              userAgent: readString(context.userAgent),
              startedAt: new Date(Date.now() - durationMs),
            }));
          } catch {
            // Projection failures are observational only and cannot affect the tool.
          }
        },
      }
    : undefined;

  const getStatus = (): ObservabilityStatus => {
    const requestStatus = requestManager?.getStatus();
    const toolsStatus = toolManager?.getStatus();
    const surfaces = [requestStatus, toolsStatus].filter(
      (status): status is ObservabilitySinkStatus => status !== undefined,
    );
    return ObservabilityStatusSchema.parse({
      ...(requestStatus && { request: requestStatus }),
      ...(toolsStatus && { tools: toolsStatus }),
      total: aggregateObservabilityStatus(surfaces, closed),
    });
  };

  return {
    ...(request && { request }),
    toolCall: toolCall ?? {},
    async flush() {
      await Promise.all([requestManager?.flush(), toolManager?.flush()]);
    },
    getStatus,
    close() {
      if (!closePromise) {
        closed = true;
        const startedAt = performance.now();
        closePromise = Promise.all([requestManager?.close(), toolManager?.close()]).then(
          () => {
            const status = getStatus();
            return ObservabilityDrainReportSchema.parse({
              ...status,
              durationMs: performance.now() - startedAt,
            });
          },
        );
      }
      return closePromise;
    },
  };
}
