/**
 * Per-request context over `AsyncLocalStorage` — trace ids, transport source,
 * identity and timing, reachable from anywhere in the call without threading a
 * parameter through every signature.
 *
 * Establish it with `wrapInRequestContext` as the outermost fetch wrapper;
 * read it with `getRequestContext` / `getTraceId`; update the late-bound fields
 * with `setRequestUser` / `setRequestError` / `setRequestEndpoint` /
 * `setRequestDimensions`.
 */
import { AsyncLocalStorage } from 'node:async_hooks';
import type { TransportSource } from '../contract';
import { getClientInfo, resolveSocketIp } from '../server/request';
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
  /**
   * Stable endpoint identity — `(serviceName, action)` of the matched contract
   * route. Written by the HTTP pipeline when the route matches, *before*
   * validation, so even a failed request is attributed to the operation it
   * targeted. → ADR 0022.
   */
  serviceName?: string;
  action?: string;
  /**
   * App-defined domain dimensions (a tenant / project / entity id, …) — an
   * opaque bag the core attaches no meaning to (→ ADR 0021), surfaced on
   * `RequestEvent.dimensions`. Set via `setRequestDimensions`.
   */
  dimensions?: Record<string, string>;
  /** Error outcome — set late, by the error handler. `details` is sanitised into
   *  `RequestEvent.errorDetail` at emit, so it is accepted loosely here. */
  error?: { code?: string; message?: string; details?: unknown };
}

/**
 * Built on first use, not while the module loads.
 *
 * `new AsyncLocalStorage()` at module scope is evaluated by the mere act of
 * importing this file. A browser bundler substitutes a stub for
 * `node:async_hooks`, so the constructor is `undefined` and the page dies during
 * initialisation — `AsyncLocalStorage is not a constructor` — for every entry
 * that reaches this module, on every route, whether or not a request context is
 * ever used. Deferring it costs one branch and turns a page-killer into a
 * function that is simply never called in a browser.
 */
let storage: AsyncLocalStorage<RequestContext> | undefined;
const requestStorage = (): AsyncLocalStorage<RequestContext> => {
  storage ??= new AsyncLocalStorage<RequestContext>();
  return storage;
};

/** Run `fn` with `ctx` as the active request context. */
export function runWithRequestContext<T>(ctx: RequestContext, fn: () => T): T {
  return requestStorage().run(ctx, fn);
}

/** The active request context, or `undefined` outside any request. */
export function getRequestContext(): RequestContext | undefined {
  return requestStorage().getStore();
}

/** The active trace id — the one id to stamp on every log line. */
export function getTraceId(): string | undefined {
  return requestStorage().getStore()?.trace.traceId;
}

/** The active user id, once auth has resolved it. */
export function getUserId(): string | undefined {
  return requestStorage().getStore()?.userId;
}

/**
 * Attach the resolved user to the active context. The ALS record is mutable —
 * the update is visible to everything already holding the context. Call this
 * from the auth hook.
 */
export function setRequestUser(userId: string): void {
  const ctx = requestStorage().getStore();
  if (ctx) ctx.userId = userId;
}

/**
 * Attach the matched endpoint's stable `(serviceName, action)` identity to the
 * active context. The framework's HTTP pipeline calls this when a contract route
 * matches — *before* validation — so the audit event for a request carries the
 * operation it targeted even when the request fails pre-handler. No-op outside a
 * request context. → ADR 0022.
 */
export function setRequestEndpoint(serviceName: string, action: string): void {
  const ctx = requestStorage().getStore();
  if (ctx) {
    ctx.serviceName = serviceName;
    ctx.action = action;
  }
}

/**
 * Merge app-defined domain dimensions (a tenant / project / entity id, …) onto
 * the active context — an opaque bag the core gives no meaning to (→ ADR 0021),
 * surfaced on `RequestEvent.dimensions`. Resolve them cheaply from `ctx.params` /
 * headers in `beforeHandle` (success) or `onError` (a pre-handler failure) and
 * they land on the audit event for the request, success or failure alike. Merges
 * across calls; no-op outside a request context.
 */
export function setRequestDimensions(dimensions: Record<string, string>): void {
  const ctx = requestStorage().getStore();
  if (ctx) ctx.dimensions = { ...ctx.dimensions, ...dimensions };
}

/**
 * Record the error outcome on the active context. Call this from the error
 * handler — the audit hook reads it when the request completes. Optional
 * `details` carries the structure the message string flattens (e.g. the failing
 * Zod issues, or an `AppError.details`); it is accepted as `unknown` and
 * **sanitised** into `RequestEvent.errorDetail` at emit — pass it raw, no need to
 * pre-launder the type.
 */
export function setRequestError(error: {
  code?: string;
  message?: string;
  details?: unknown;
}): void {
  const ctx = requestStorage().getStore();
  if (ctx) ctx.error = error;
}

/** Options for `wrapInRequestContext`. */
export interface WrapRequestContextOptions {
  /**
   * Trust `x-forwarded-for` for the client IP — enable only behind a proxy
   * that rewrites it. Default `false`: the real socket peer IP is used.
   */
  trustProxy?: boolean;
}

/**
 * Wrap a fetch handler so it runs inside a fresh `RequestContext` — trace ids
 * (the inbound `traceparent` continued, or freshly minted), timing and client
 * info.
 *
 * Compose it as the OUTERMOST wrapper of the server's fetch handler — with raw
 * `Bun.serve`, or through `wrapFetch` on `createServer` / `serveNode`, which own
 * their own `fetch`.
 *
 * To make the framework router reuse this trace id (so request logs and
 * application logs share one id), pass `traceId: getTraceId` to `createServer` /
 * `createHandler`: outside an active context it yields `undefined` and the
 * framework falls back to its own resolver.
 */
export function wrapInRequestContext<S>(
  handler: (req: Request, server: S) => Promise<Response>,
  options: WrapRequestContextOptions = {},
): (req: Request, server: S) => Promise<Response> {
  return (req, server) => {
    const ctx: RequestContext = {
      trace: resolveTraceContext(req),
      source: 'http',
      method: req.method,
      // `req.url` may be a bare pathname on a Node adapter — the base avoids
      // a `TypeError: Invalid URL`.
      path: new URL(req.url, 'http://localhost').pathname,
      startedAt: process.hrtime.bigint(),
      ...getClientInfo(req, {
        trustProxy: options.trustProxy,
        socketIp: resolveSocketIp(req, server),
      }),
    };
    return runWithRequestContext(ctx, () => handler(req, server));
  };
}
