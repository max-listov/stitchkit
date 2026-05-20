import type { ZodType } from 'zod';
import type {
  EndpointDef,
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
  toolName?: string;
  expose?: readonly Transport[];
  scope?: string;
  paramsSchema?: ZodType<TParams>;
  inputSchema?: ZodType<TInput>;
  outputSchema?: ZodType<TOutput>;
  multipart?: string;
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
  /** Matched `:param` path segments — empty object for exact / wildcard paths. */
  params: Record<string, string>;
  /**
   * The `Bun.serve` instance — needed for connection upgrades (e.g. WebSocket).
   * Absent when the handler runs via the bare `createHandler` fetch.
   */
  server?: BunServer;
}

export interface RawRoute {
  method: HttpMethod | 'ALL';
  /** Exact path, `:param` segments, or a trailing `/*` prefix wildcard. */
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
  rawRoutes?: RawRoute[];
  cors?: CorsConfig;
  hooks?: LifecycleHooks;
  logging?: boolean | StitchLogger;
  traceId?: (req: Request) => string;
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

export type StitchServeOptions = ServerPassthrough & {
  port: number;
  hostname?: string;
  routes?: BunRoutes;
  websocket?: BunWebSocketHandlers;
  development?: BunDevelopmentOptions;
  fetch(req: Request): Promise<Response>;
};
