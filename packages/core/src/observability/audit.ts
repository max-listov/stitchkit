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
import { childSpan, createTraceContext } from './trace';

/** One isolated RequestEvent sink and its sanitisation policy. */
export interface RequestEventSinkConfig {
  /**
   * The sink — persists one audit event. It runs fire-and-forget and its own
   * errors are swallowed, so a slow or failing write never blocks or breaks the
   * request it observes. Keep it asynchronous and self-contained.
   */
  write: (event: RequestEvent) => void | Promise<void>;
  /** Keep only events for which this returns `true`. Default: keep every event. */
  filter?: (event: RequestEvent) => boolean;
  /** Payload sanitisation tuning — passed through to `sanitizePayload`. */
  sanitize?: SanitizeOptions;
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

function createEmitter(config: RequestEventSinkConfig) {
  return async (event: RequestEvent): Promise<void> => {
    try {
      if (config.filter && !config.filter(event)) return;
      await config.write(event);
    } catch {
      // An audit sink must never break the call it observes.
    }
  };
}

export function createObservability(config: ObservabilityConfig): Observability {
  const request: HttpRequestObserver | undefined = config.request
    ? {
        includePayload: config.request.includePayload ?? false,
        complete: ({ context, statusCode, durationMs, payload }) => {
          const requestConfig = config.request;
          if (!requestConfig) return;
          const emit = createEmitter(requestConfig);
          void (async () => {
            let body: unknown;
            if (payload) {
              try {
                body = await payload;
              } catch {
                body = undefined;
              }
            }
            await emit({
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
            });
          })();
        },
      }
    : undefined;

  const toolCall: ToolCallHooks | undefined = config.tools
    ? {
        afterToolCall: ({ toolName, args, result, durationMs, context, endpoint, error }) => {
          const toolConfig = config.tools;
          if (!toolConfig) return;
          const emit = createEmitter(toolConfig);
          // Each tool call is a span. Under an HTTP request it is a child of that
          // request's span; on its own (a stdio server) it opens a fresh trace.
          const requestCtx = getRequestContext();
          const span = requestCtx ? childSpan(requestCtx.trace) : createTraceContext();
          const measure = result.ok
            ? measureSize(result.data)
            : { resultSize: null, responseBytes: 0 };
          const mcp = context.source === 'mcp' ? readMcpContext(context.mcp) : undefined;
          void emit({
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
            userId: readString(context.userId),
            authMethod: readString(context.authMethod),
            clientId: readString(context.clientId),
            ipAddress: readString(context.ipAddress),
            userAgent: readString(context.userAgent),
            startedAt: new Date(Date.now() - durationMs),
          });
        },
      }
    : undefined;

  return {
    ...(request && { request }),
    toolCall: toolCall ?? {},
  };
}
