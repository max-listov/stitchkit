/**
 * `createAuditHook` — the batteries-included audit layer. It wires the raw
 * `afterToolCall` hook and an HTTP fetch wrapper into one place, normalises
 * every completed call into a `RequestEvent`, and hands it to the project's
 * sink. The project supplies only `write` — the table and how to persist a row.
 */
import { recordedErrorMessage } from '../internal/errors';
import { isRecord } from '../internal/typed';
import type { ToolCallHooks, ToolResult } from '../tools/execute';
import { getRequestContext } from './context';
import type { RequestEvent } from './event';
import { measureSize, type SanitizeOptions, sanitizePayload } from './sanitize';
import { childSpan, createTraceContext } from './trace';

/** Config for `createAuditHook`. */
export interface AuditConfig {
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

/** What `createAuditHook` returns — one wiring point per surface. */
export interface AuditHook {
  /**
   * Wrap the HTTP fetch handler — audits every request from its final
   * response (success and error alike). Compose it INSIDE `wrapInRequestContext`
   * (it reads that context for trace ids, timing and identity).
   */
  http: <S>(
    handler: (req: Request, server: S) => Promise<Response>,
  ) => (req: Request, server: S) => Promise<Response>;
  /**
   * Tool-call hooks — audits every MCP / agent tool call. Pass as `hooks` to
   * `createMcpHandler`, `createStdioMcpServer` or `mountAgent`.
   */
  toolCall: ToolCallHooks;
}

/** HTTP methods that carry a body worth recording. */
const BODY_METHODS = new Set(['POST', 'PUT', 'PATCH', 'DELETE']);

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

export function createAuditHook(config: AuditConfig): AuditHook {
  const { write, filter, sanitize } = config;

  /** Filter, then hand the event to the sink — never throws, never blocks. */
  const emit = async (event: RequestEvent): Promise<void> => {
    try {
      if (filter && !filter(event)) return;
      await write(event);
    } catch {
      // An audit sink must never break the call it observes.
    }
  };

  const http = <S>(handler: (req: Request, server: S) => Promise<Response>) => {
    return async (req: Request, server: S): Promise<Response> => {
      // Clone before the handler consumes the body.
      const bodyClone = BODY_METHODS.has(req.method) ? req.clone() : null;
      const res = await handler(req, server);

      // Read the context synchronously, while still inside its ALS scope.
      const ctx = getRequestContext();
      if (ctx) {
        const durationMs = Math.round(Number(process.hrtime.bigint() - ctx.startedAt) / 1e6);
        // Detached — the response returns without waiting on the body read or sink.
        void (async () => {
          let body: unknown;
          if (bodyClone) {
            try {
              body = await bodyClone.json();
            } catch {
              body = undefined;
            }
          }
          await emit({
            source: ctx.source,
            method: ctx.method,
            path: ctx.path,
            ...(ctx.serviceName !== undefined && { serviceName: ctx.serviceName }),
            ...(ctx.action !== undefined && { action: ctx.action }),
            ...(ctx.dimensions !== undefined && { dimensions: ctx.dimensions }),
            traceId: ctx.trace.traceId,
            spanId: ctx.trace.spanId,
            parentSpanId: ctx.trace.parentSpanId,
            ok: res.status < 400,
            statusCode: res.status,
            durationMs,
            errorCode: ctx.error?.code,
            errorMessage: ctx.error?.message,
            ...(ctx.error?.details !== undefined && {
              errorDetail: sanitizePayload(ctx.error.details, sanitize),
            }),
            payload: sanitizePayload(body, sanitize),
            resultSize: null,
            responseBytes: 0,
            userId: ctx.userId,
            ipAddress: ctx.ipAddress,
            userAgent: ctx.userAgent,
            startedAt: new Date(Date.now() - durationMs),
          });
        })();
      }
      return res;
    };
  };

  const toolCall: ToolCallHooks = {
    afterToolCall: (toolName, args, result, durationMs, context, endpoint, thrown) => {
      // Each tool call is a span. Under an HTTP request it is a child of that
      // request's span; on its own (a stdio server) it opens a fresh trace.
      const requestCtx = getRequestContext();
      const span = requestCtx ? childSpan(requestCtx.trace) : createTraceContext();
      const measure = result.ok
        ? measureSize(result.data)
        : { resultSize: null, responseBytes: 0 };
      void emit({
        source: context.source,
        method: 'TOOL',
        httpMethod: endpoint.method,
        path: `/${context.source}/${toolName}`,
        serviceName: endpoint.serviceName,
        action: endpoint.key,
        ...(requestCtx?.dimensions !== undefined && { dimensions: requestCtx.dimensions }),
        toolName,
        traceId: span.traceId,
        spanId: span.spanId,
        parentSpanId: span.parentSpanId,
        ok: result.ok,
        statusCode: result.ok ? 200 : 400,
        durationMs,
        errorCode: result.ok ? undefined : result.code,
        errorMessage: result.ok ? undefined : auditErrorMessage(result, thrown),
        ...(!result.ok &&
          result.details !== undefined && {
            errorDetail: sanitizePayload(result.details, sanitize),
          }),
        payload: sanitizePayload(args, sanitize),
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
  };

  return { http, toolCall };
}
