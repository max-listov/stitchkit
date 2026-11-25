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
import type { TransportSource } from '../contract/define';
import { getClientInfo, resolveSocketIp } from '../internal/request';
import { isUnsafeKey } from '../internal/safe-json';
import { isRecord } from '../internal/typed';
import { resolveTraceContext, type TraceContext } from './trace';

/** What a unit of work is: a call that arrived, or work that runs on its own. */
export type RequestContextKind = 'request' | 'job';

/** Everything known about the unit of work in flight. */
export interface RequestContext {
  /** W3C trace ids for this unit of work. */
  trace: TraceContext;
  /** Which surface the request arrived on. */
  source: TransportSource;
  /**
   * What this is. Absent means `request`, so every context written before this
   * existed still reads correctly and no caller has to start declaring it.
   */
  kind?: RequestContextKind;
  /**
   * What the work is, for work that has no route to name it — `agent-loop`,
   * `broadcast-send`. A request is named by its method and path; a job is named
   * by what it does.
   */
  name?: string;
  /**
   * HTTP verb — absent for work that did not arrive over a transport.
   *
   * It was required, and work without a transport therefore had to invent one:
   * a background loop wrote `method: 'AGENT'`, which is not a verb, it is the
   * absence of one recorded in the field for verbs. An absent field says the
   * same thing and says it truthfully, which is the difference between a filter
   * that can exclude jobs and a filter that silently counts them as writes.
   */
  method?: string;
  /** Request path — absent for work that did not arrive over a transport. */
  path?: string;
  /** Monotonic start in milliseconds, for duration — `performance.now()`. */
  startedAt: number;
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

interface ContextStorage<T> {
  run<R>(store: T, callback: () => R): R;
  getStore(): T | undefined;
}

const NO_AMBIENT_STORAGE: ContextStorage<RequestContext> = {
  run: (_store, callback) => callback(),
  getStore: () => undefined,
};

function isContextStorage(value: unknown): value is ContextStorage<RequestContext> {
  return (
    isRecord(value) && typeof value.run === 'function' && typeof value.getStore === 'function'
  );
}

/**
 * Resolve `AsyncLocalStorage` lazily without a static `node:async_hooks` import,
 * so browser and Hermes bundles stay free of Node built-ins.
 *
 * On Node and Bun, `process.getBuiltinModule('async_hooks')` provides real
 * async context isolation; a Node or Bun runtime missing that API fails loudly
 * instead of silently dropping ambient context. On runtimes without Node built-ins
 * (browsers, Hermes / React Native), ambient storage is a no-op and the HTTP
 * pipeline carries its own explicit `RequestContext`.
 */
function resolveStorage(): ContextStorage<RequestContext> {
  const proc: unknown = Reflect.get(globalThis, 'process');
  if (!isRecord(proc)) return NO_AMBIENT_STORAGE;
  const getBuiltinModule = proc.getBuiltinModule;
  if (typeof getBuiltinModule === 'function') {
    const mod: unknown = Reflect.apply(getBuiltinModule, proc, ['async_hooks']);
    const ctor = isRecord(mod) ? mod.AsyncLocalStorage : undefined;
    if (typeof ctor === 'function') {
      const instance: unknown = Reflect.construct(ctor, []);
      if (isContextStorage(instance)) return instance;
    }
  }
  const versions = isRecord(proc.versions) ? proc.versions : undefined;
  if (versions && (typeof versions.bun === 'string' || typeof versions.node === 'string')) {
    throw new Error(
      '[stitchkit] RequestContext requires process.getBuiltinModule("async_hooks") on Node (>=22.3.0) and Bun (>=1.4.0)',
    );
  }
  return NO_AMBIENT_STORAGE;
}

let storage: ContextStorage<RequestContext> | undefined;
const requestStorage = (): ContextStorage<RequestContext> => {
  storage ??= resolveStorage();
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
export function setRequestEndpoint(serviceName: string, action?: string): void {
  const ctx = requestStorage().getStore();
  if (ctx) {
    ctx.serviceName = serviceName;
    if (action !== undefined) ctx.action = action;
  }
}

/** What a repeated dimension name does: the later write wins, the earlier one stays, or it throws. */
export type DimensionCollision = 'overwrite' | 'preserve' | 'error';

export interface SetRequestDimensionsOptions {
  /** Policy when an earlier phase already wrote the same dimension. */
  collision?: DimensionCollision;
}

/**
 * Merge app-defined domain dimensions (a tenant / project / entity id, …) onto
 * the active context — an opaque bag the core gives no meaning to (→ ADR 0021),
 * surfaced on `RequestEvent.dimensions`. Resolve them cheaply from `ctx.params` /
 * headers in `beforeHandle` (success) or `onError` (a pre-handler failure) and
 * they land on the audit event for the request, success or failure alike. Merges
 * across calls; no-op outside a request context. Two calls are programming
 * errors and throw — they fail the request rather than record a lie: a key of
 * `__proto__` (it would set the bag's prototype) and a repeated key under
 * `collision: 'error'`.
 */
export function setRequestDimensions(
  dimensions: Record<string, string>,
  options: SetRequestDimensionsOptions = {},
): void {
  const ctx = requestStorage().getStore();
  if (!ctx) return;

  const next = { ...ctx.dimensions };
  for (const [key, value] of Object.entries(dimensions)) {
    if (isUnsafeKey(key)) throw new Error('Request dimension name cannot be "__proto__"');
    const exists = Object.hasOwn(next, key);
    if (exists && options.collision === 'preserve') continue;
    if (exists && options.collision === 'error') {
      throw new Error(`Request dimension "${key}" is already set`);
    }
    next[key] = value;
  }
  ctx.dimensions = next;
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
      kind: 'request',
      method: req.method,
      // `req.url` may be a bare pathname on a Node adapter — the base avoids
      // a `TypeError: Invalid URL`.
      path: new URL(req.url, 'http://localhost').pathname,
      startedAt: performance.now(),
      ...getClientInfo(req, {
        trustProxy: options.trustProxy,
        socketIp: resolveSocketIp(req, server),
      }),
    };
    return runWithRequestContext(ctx, () => handler(req, server));
  };
}
