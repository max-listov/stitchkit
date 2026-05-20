/**
 * Per-request context over `AsyncLocalStorage` — trace ids, transport source,
 * identity and timing, reachable from anywhere in the call without threading a
 * parameter through every signature.
 *
 * Establish it with `wrapInRequestContext` as the outermost fetch wrapper;
 * read it with `getRequestContext` / `getTraceId`; update the late-bound fields
 * with `setRequestUser` / `setRequestError`.
 */
import { AsyncLocalStorage } from 'node:async_hooks';
import type { TransportSource } from '../contract';
import { getClientInfo } from '../server/request';
import { resolveTraceContext, type TraceContext } from './trace';

/** Everything known about the request in flight. */
export interface RequestContext {
  /** W3C trace ids for this request. */
  trace: TraceContext;
  /** Which surface the request arrived on. */
  source: TransportSource;
  /** HTTP verb. */
  method: string;
  /** Request path. */
  path: string;
  /** Monotonic start, for duration — `process.hrtime.bigint()`. */
  startedAt: bigint;
  /** Client IP, when resolvable. */
  ipAddress?: string;
  /** Client user-agent, when present. */
  userAgent?: string;
  /** Resolved user id — set late, once auth has run. */
  userId?: string;
  /** Error outcome — set late, by the error handler. */
  error?: { code?: string; message?: string };
}

const storage = new AsyncLocalStorage<RequestContext>();

/** Run `fn` with `ctx` as the active request context. */
export function runWithRequestContext<T>(ctx: RequestContext, fn: () => T): T {
  return storage.run(ctx, fn);
}

/** The active request context, or `undefined` outside any request. */
export function getRequestContext(): RequestContext | undefined {
  return storage.getStore();
}

/** The active trace id — the one id to stamp on every log line. */
export function getTraceId(): string | undefined {
  return storage.getStore()?.trace.traceId;
}

/** The active user id, once auth has resolved it. */
export function getUserId(): string | undefined {
  return storage.getStore()?.userId;
}

/**
 * Attach the resolved user to the active context. The ALS record is mutable —
 * the update is visible to everything already holding the context. Call this
 * from the auth hook.
 */
export function setRequestUser(userId: string): void {
  const ctx = storage.getStore();
  if (ctx) ctx.userId = userId;
}

/**
 * Record the error outcome on the active context. Call this from the error
 * handler — the audit hook reads it when the request completes.
 */
export function setRequestError(error: { code?: string; message?: string }): void {
  const ctx = storage.getStore();
  if (ctx) ctx.error = error;
}

/**
 * Wrap a fetch handler so it runs inside a fresh `RequestContext` — trace ids
 * (the inbound `traceparent` continued, or freshly minted), timing and client
 * info.
 *
 * Compose it as the OUTERMOST wrapper of the server's fetch handler. To make
 * the framework router reuse this trace id (so request logs and application
 * logs share one id), pass `traceId: getTraceId` to `createServer` /
 * `createHandler`.
 */
export function wrapInRequestContext<S>(
  handler: (req: Request, server: S) => Promise<Response>,
): (req: Request, server: S) => Promise<Response> {
  return (req, server) => {
    const ctx: RequestContext = {
      trace: resolveTraceContext(req),
      source: 'http',
      method: req.method,
      path: new URL(req.url).pathname,
      startedAt: process.hrtime.bigint(),
      ...getClientInfo(req),
    };
    return runWithRequestContext(ctx, () => handler(req, server));
  };
}
