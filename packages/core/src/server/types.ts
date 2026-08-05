import type { ZodType } from 'zod';
import type {
  EndpointDef,
  EndpointToolAnnotations,
  EndpointUiMeta,
  HandlerContext,
  HttpMethod,
  RuntimeContext,
  Transport,
} from '../contract';
import type { CorsConfig } from './middleware/cors';

type Prop<T, K extends string> = K extends keyof T ? T[K] : undefined;
type InferParams<E> = Prop<E, 'params'> extends ZodType<infer P> ? P : undefined;
type InferInput<E> = Prop<E, 'input'> extends ZodType<infer I> ? I : undefined;
type InferOutput<E> = Prop<E, 'output'> extends ZodType<infer O> ? O : never;

export type Handlers<
  C extends Record<string, EndpointDef>,
  TCtx extends RuntimeContext = HandlerContext,
> = {
  [K in keyof C]: (
    ctx: TCtx & { params: InferParams<C[K]>; input: InferInput<C[K]> },
  ) => Prop<C[K], 'output'> extends ZodType
    ? Promise<InferOutput<C[K]>> | InferOutput<C[K]>
    : void | Promise<void>;
};

export interface MethodDef<TParams = unknown, TInput = unknown, TOutput = unknown> {
  method: HttpMethod;
  path: string;
  desc: string;
  /**
   * Owning contract's prefix — the "service" half of a stable `(service, action)`
   * identity for hooks / audit / observability. Populated by `implement` /
   * `implementRemote`; not derivable from `path`. → ADR 0022.
   */
  serviceName: string;
  /**
   * Endpoint key in the contract (e.g. `updatePartial`) — the "action" half of
   * the identity. Not in `path`, and `toolName` is absent on HTTP-only endpoints,
   * so this is the only stable per-endpoint key. → ADR 0022.
   */
  key: string;
  toolName?: string;
  expose?: readonly Transport[];
  scope?: string;
  paramsSchema?: ZodType<TParams>;
  inputSchema?: ZodType<TInput>;
  outputSchema?: ZodType<TOutput>;
  multipart?: string;
  /** Per-route upload ceiling (bytes) for a multipart endpoint — overrides the
   *  server `maxUploadBytes` default; from `EndpointDef.maxUploadBytes`. */
  maxUploadBytes?: number;
  /**
   * Whether the operation is safe to call twice with the same input — from
   * `EndpointDef.idempotent`. The core attaches no behaviour; a retrying
   * transport reads it to decide whether to replay a call after a reconnect.
   * → ADR 0027.
   */
  idempotent?: boolean;
  /** MCP Apps widget metadata — carried onto the MCP tool's `_meta.ui`. */
  ui?: EndpointUiMeta;
  /** MCP behavioural hints — carried onto the MCP tool's `annotations`. */
  annotations?: EndpointToolAnnotations;
  /**
   * Opaque app-defined metadata from `EndpointDef.meta` — the core gives it no
   * meaning. Read it in lifecycle hooks (`endpoint.meta?.X`) or on tool mounts;
   * the consumer narrows the type. Never serialized to OpenAPI. → ADR 0021.
   */
  meta?: Record<string, unknown>;
  handler: (ctx: RuntimeContext) => Promise<TOutput> | TOutput;
}

export interface ServiceDef {
  name: string;
  prefix: string;
  scope: string;
  methods: Record<string, MethodDef<unknown, unknown, unknown>>;
}

export interface LifecycleHooks {
  onRequest?: (req: Request) => undefined | Response | Promise<undefined | Response>;
  beforeHandle?: (ctx: RuntimeContext, endpoint: MethodDef) => void | Promise<void>;
  afterHandle?: (
    ctx: RuntimeContext,
    result: unknown,
    endpoint: MethodDef,
  ) => unknown | Promise<unknown>;
  onError?: (
    ctx: RuntimeContext,
    error: unknown,
    endpoint?: MethodDef,
  ) => Response | Promise<Response> | undefined;
}

export interface RouteGroup {
  pathPrefix?: string;
  services: ServiceDef[];
  hooks?: LifecycleHooks;
}

/**
 * A non-contract HTTP route — for things that cannot be a clean JSON
 * request/response contract: auth bootstrap (cookies, OAuth redirects),
 * external webhooks (signature/IP verification), static files, socket.io.
 *
 * Matched in the same router as contract routes (shared CORS / `onRequest`),
 * but the handler is raw `Request → Response` — no schema parsing and no
 * `beforeHandle` auth gate; the route authorizes itself.
 */
/** The concrete `Bun.serve` server instance, passed through to raw handlers. */
export type BunServer = ReturnType<typeof Bun.serve>;

/** Context passed to a `RawRoute` handler alongside the raw `Request`. */
export interface RawRouteContext {
  /**
   * Matched `:param` path segments. A trailing `/*` wildcard also adds its
   * remainder (everything after the prefix) as `params['*']`. Empty for an exact
   * path.
   */
  params: Record<string, string>;
  /**
   * The `Bun.serve` instance — needed for connection upgrades (e.g. WebSocket).
   * Absent when the handler runs via the bare `createHandler` fetch.
   */
  server?: BunServer;
  /**
   * Client IP — the real socket peer, or the `x-forwarded-for` client when
   * `trustProxy` is set. Resolved by the framework; never spoofable by default.
   */
  ipAddress?: string;
}

export interface RawRoute {
  method: HttpMethod | 'ALL';
  /**
   * Exact path, `:param` segments, or a trailing `/*` prefix wildcard. The
   * wildcard combines with params — `/app/:slug/*` matches `/app/x/a/b` with
   * `params.slug === 'x'` and the remainder in `params['*']`.
   */
  path: string;
  /**
   * Raw handler — a standard `Request → Response` fetch handler plus a routing
   * `ctx` (matched path params, the server). Errors thrown here are caught by
   * the router and run through `hooks.onError` — same shape as contract errors.
   */
  handler: (req: Request, ctx: RawRouteContext) => Response | Promise<Response>;
}

export interface StitchLogger {
  info(msg: string, data?: Record<string, unknown>): void;
  warn(msg: string, data?: Record<string, unknown>): void;
  error(msg: string, data?: Record<string, unknown>): void;
  debug(msg: string, data?: Record<string, unknown>): void;
}

/**
 * Runtime-neutral handler config — everything `createHandler` needs.
 * No Bun globals, no Bun types. This is the portability seam.
 */
export interface HandlerConfig {
  services?: ServiceDef[];
  groups?: RouteGroup[];
  /**
   * Mount each `services` entry under a path prefix chosen by its `scope` — a
   * `scope → prefix` map, so resource-scoped APIs declare the mapping once
   * instead of hand-partitioning services into `groups`. A prefix may carry
   * `:param` segments (they reach `ctx.pathParams`), e.g.
   * `{ tenant: 'tenants/:tenantId', project: 'projects/:projectId' }`. A service
   * whose `scope` is not in the map mounts flat. Services listed under explicit
   * `groups` are unaffected (the group prefix wins). Scope stays a free string —
   * the core attaches no meaning beyond this lookup. → ADR 0024.
   */
  scopePrefixes?: Record<string, string>;
  rawRoutes?: RawRoute[];
  /**
   * Default upload ceiling (bytes) for every `multipart` endpoint. A per-route
   * `EndpointDef.maxUploadBytes` overrides it; without either, multipart uploads
   * are capped at the 25 MB framework default.
   */
  maxUploadBytes?: number;
  cors?: CorsConfig;
  hooks?: LifecycleHooks;
  logging?: boolean | StitchLogger;
  /**
   * Report handler-output keys the contract schema removed, as dot-paths, through
   * the configured logger. **Off by default** — the strip itself is correct (the
   * contract is the published shape of the response), it is only *invisible*, and
   * a permanent key-diff on every response is the wrong price for that.
   *
   * Turn it on while migrating a live API: your handlers may be returning more
   * than the contract declares, and nothing else will tell you — types cannot
   * (structural typing does not reject excess properties) and the client just
   * receives fewer fields. Read the list, fix or widen the contracts, turn it off.
   * → ADR 0037.
   */
  warnOnOutputStrip?: boolean;
  traceId?: (req: Request) => string;
  /**
   * Trust the `x-forwarded-for` / `x-real-ip` headers for the client IP.
   * These are client-controllable — enable only when the server runs behind a
   * proxy that overwrites them. Default `false`: the IP a spoofable header
   * carries never reaches `ctx.ipAddress`, a rate-limit key or an audit row.
   */
  trustProxy?: boolean;
}

// ─── Bun-specific server config ─────────────────────

type BunServeOptions = Parameters<typeof Bun.serve>[0];
type BunWebSocketHandlers = BunServeOptions extends { websocket?: infer T } ? T : never;
type BunRoutes = BunServeOptions extends { routes?: infer T } ? T : never;
type BunDevelopmentOptions = BunServeOptions extends { development?: infer T } ? T : never;

export type ServerPassthrough = Omit<
  BunServeOptions,
  'fetch' | 'port' | 'hostname' | 'unix' | 'routes' | 'websocket' | 'development'
>;

/**
 * Full config for `createServer` — extends `HandlerConfig` with Bun-specific
 * options (`Bun.serve` routes, websocket, development, passthrough).
 */
export interface BunServerConfig extends HandlerConfig {
  port?: number;
  hostname?: string;
  routes?: BunRoutes;
  websocket?: BunWebSocketHandlers;
  development?: BunDevelopmentOptions;
  bun?: ServerPassthrough;
}
