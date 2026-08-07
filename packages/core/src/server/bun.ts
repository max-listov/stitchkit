/** Bun-owned server adapter and its concrete public types. */
import { createHandler } from './create';
import type {
  FetchComposition,
  FetchHandler,
  HandlerConfig,
  RawRoute,
  RawRouteContext,
} from './types';

/** The concrete `Bun.serve` server instance passed to Bun raw routes. */
export type BunServer = ReturnType<typeof Bun.serve>;
export type BunRawRoute = RawRoute<BunServer>;
export type BunRawRouteContext = RawRouteContext<BunServer>;
export type BunFetchHandler = FetchHandler<BunServer>;
export type BunFetchComposition = FetchComposition<BunServer>;
export type BunHandlerConfig = HandlerConfig<BunServer>;

type BunServeOptions = Parameters<typeof Bun.serve>[0];
type BunWebSocketHandlers = BunServeOptions extends { websocket?: infer T } ? T : never;
type BunRoutes = BunServeOptions extends { routes?: infer T } ? T : never;
type BunDevelopmentOptions = BunServeOptions extends { development?: infer T } ? T : never;

export type ServerPassthrough = Omit<
  BunServeOptions,
  'fetch' | 'port' | 'hostname' | 'unix' | 'routes' | 'websocket' | 'development'
>;

/** Bun-specific server config layered over the Fetch-clean handler config. */
export interface BunServerConfig extends BunHandlerConfig, BunFetchComposition {
  port?: number;
  hostname?: string;
  routes?: BunRoutes;
  websocket?: BunWebSocketHandlers;
  development?: BunDevelopmentOptions;
  bun?: ServerPassthrough;
}

/** Start the contract router through `Bun.serve`. */
export function createServer(config: BunServerConfig): BunServer {
  const { routes, websocket, development, bun: bunExtra, port = 3000, hostname } = config;

  const handler = createHandler(config);
  const fetch = config.wrapFetch ? config.wrapFetch(handler) : handler;

  return websocket
    ? Bun.serve({
        ...bunExtra,
        ...(routes && { routes }),
        ...(development && { development }),
        port,
        hostname,
        websocket,
        fetch,
      })
    : Bun.serve({
        ...bunExtra,
        ...(development && { development }),
        port,
        hostname,
        fetch,
      });
}
