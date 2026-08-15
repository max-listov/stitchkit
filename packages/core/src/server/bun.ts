/** Bun-owned server adapter and its concrete public types. */
import { createHandler } from './create';
import {
  createServerLifecycle,
  type ManagedServerHandle,
  type ShutdownAdapter,
} from './shutdown';
import type { SocketIOServerLifecycle } from './socket-io';
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
type BunWebSocketHandlers = Bun.WebSocketHandler<unknown>;
type BunDevelopmentOptions = BunServeOptions extends { development?: infer T } ? T : never;

export type ServerPassthrough = Omit<
  BunServeOptions,
  'fetch' | 'port' | 'hostname' | 'unix' | 'routes' | 'websocket' | 'development'
>;

/** Bun-specific server config layered over the Fetch-clean handler config. */
export interface BunServerConfig extends BunHandlerConfig, BunFetchComposition {
  port?: number;
  hostname?: string;
  websocket?: BunWebSocketHandlers;
  /** Full Stitchkit Socket.IO lifecycle; route and default websocket are mounted automatically. */
  socket?: SocketIOServerLifecycle;
  development?: BunDevelopmentOptions;
  bun?: ServerPassthrough;
}

export type BunServerHandle = ManagedServerHandle<BunServer>;

/** Start the contract router through `Bun.serve`. */
export function createServer(config: BunServerConfig): BunServerHandle {
  const {
    websocket: configuredWebSocket,
    socket,
    development,
    bun: bunExtra,
    port = 3000,
    hostname,
  } = config;
  const socketRoutePrefix = socket?.route.path.replace(/\*socketPath$/, '');
  // Boundary cast: Bun's handler data is opaque to the lifecycle wrapper. The
  // wrapper preserves the same socket object and only observes open/close;
  // consumer and bun-engine handlers retain their own typed data internally.
  const websocket = (configuredWebSocket ?? socket?.websocket) as
    | Bun.WebSocketHandler<unknown>
    | undefined;
  const openSockets = new Set<Bun.ServerWebSocket<unknown>>();
  let hadWebSockets = false;
  const trackedWebSocket: typeof websocket = websocket
    ? {
        ...websocket,
        open(ws: Bun.ServerWebSocket<unknown>) {
          hadWebSockets = true;
          openSockets.add(ws);
          websocket.open?.(ws);
        },
        close(ws: Bun.ServerWebSocket<unknown>, code: number, reason: string) {
          openSockets.delete(ws);
          websocket.close?.(ws, code, reason);
        },
      }
    : undefined;

  let runtime: BunServer | undefined;
  const requireRuntime = (): BunServer => {
    if (!runtime) throw new Error('[stitchkit] Bun server lifecycle started before Bun.serve');
    return runtime;
  };
  const adapter: ShutdownAdapter = {
    beginShutdown: () => socket?.beginShutdown(),
    pendingRequests: () => runtime?.pendingRequests ?? 0,
    pendingWebSockets: () => openSockets.size,
    async closeRealtime() {
      const logicalClose = socket?.close();
      // bun-engine and raw lanes expose no physical-completion Promise. Start a
      // normal close handshake for every tracked socket, then wait for Bun's
      // close callback. The shared lifecycle deadline owns the fallback to
      // terminate() for any socket Bun still reports as open at that boundary.
      for (const ws of openSockets) ws.close(1001, 'Server shutting down');
      await Promise.all([
        logicalClose,
        new Promise<void>((resolve) => {
          if (openSockets.size === 0) {
            resolve();
            return;
          }
          const timer = setInterval(() => {
            if (openSockets.size === 0) {
              clearInterval(timer);
              resolve();
            }
          }, 5);
        }),
      ]);
    },
    async stopGracefully() {
      // After all accepted work and tracked WebSockets are physically gone,
      // stop(true) only closes idle keep-alive transports; it cannot abort
      // application work. Bun's stop(false) otherwise remains pending after an
      // upgraded socket even when pendingWebSockets has already reached zero.
      await new Promise((resolve) => setTimeout(resolve, 0));
      const server = requireRuntime();
      if (server.pendingRequests === 0 && openSockets.size === 0) {
        const stopping = server.stop(true);
        if (!hadWebSockets) await stopping;
        else void stopping.catch(() => undefined);
        return;
      }
      await server.stop(false);
    },
    async forceStop() {
      for (const ws of openSockets) ws.terminate();
      openSockets.clear();
      const stopping = requireRuntime().stop(true);
      if (!hadWebSockets) await stopping;
      else void stopping.catch(() => undefined);
    },
  };
  const lifecycle = createServerLifecycle(() => adapter);

  const handler = createHandler(config);
  const consumerFetch = config.wrapFetch ? config.wrapFetch(handler) : handler;
  const admittedFetch = lifecycle.wrapFetch(consumerFetch);
  const fetch: BunFetchHandler = async (request, server) => {
    if (socket && socketRoutePrefix) {
      const pathname = new URL(request.url).pathname;
      if (pathname.startsWith(socketRoutePrefix)) {
        return await socket.route.handler(request, {
          params: { socketPath: pathname.slice(socketRoutePrefix.length) },
          server,
        });
      }
    }
    return admittedFetch(request, server);
  };

  runtime = trackedWebSocket
    ? Bun.serve({
        ...bunExtra,
        ...(development && { development }),
        port,
        hostname,
        websocket: trackedWebSocket,
        fetch,
      })
    : Bun.serve({
        ...bunExtra,
        ...(development && { development }),
        port,
        hostname,
        fetch,
      });

  const server = runtime;
  return {
    url: server.url.toString().replace(/\/$/, ''),
    port: server.port ?? port,
    runtime: server,
    get status() {
      return lifecycle.status;
    },
    shutdown: lifecycle.shutdown,
  };
}
