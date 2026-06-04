/**
 * Socket.IO server setup — the family WebSocket server boilerplate, runtime-aware.
 *
 * The engine differs per runtime, so the socket packages are loaded **lazily**
 * (dynamic `import` inside the function) — a `type`-only import at the top would
 * still be erased, but a top-level *value* import of `@socket.io/bun-engine`
 * (Bun-only) would crash the whole `stitchkit/server` barrel on Node before any
 * socket code runs. Lazy loading keeps the barrel Node-importable for apps that
 * never use sockets.
 *
 *  - **Bun** — `@socket.io/bun-engine` + `io.bind(engine)`; returns the
 *    `websocket` handler for `Bun.serve` and a `/socket.io/*` route.
 *  - **Node** — `io.attach(server)` onto the `node:http.Server` exposed by
 *    `serveNode` (srvx `server.node.server`); Socket.IO owns the `upgrade` event.
 *
 * Connection handlers, rooms and handshake auth stay in the project.
 */
import type { Server as HttpServer } from 'node:http';
import type { Server as BunEngine } from '@socket.io/bun-engine';
import type { ServerWebSocket } from 'bun';
import type { Server as SocketIOServer } from 'socket.io';
import type { SocketEventMap } from '../browser/socket-io';
import type { RawRoute } from './types';
import { type ComposedLane, webSocketLane } from './websocket';

export interface SocketIOServerConfig {
  /** CORS — the browser origin(s) allowed to open a socket. */
  cors: { origin: string | string[]; credentials?: boolean };
  /** Socket.IO endpoint path. Default `/socket.io/`. */
  path?: string;
  /**
   * Transports offered to clients. Default `['websocket', 'polling']` on Bun;
   * on Node the default is `['websocket']` — Socket.IO shares the HTTP server
   * with srvx there, so its polling request-handler would collide with srvx's;
   * WebSocket uses the separate `upgrade` event and does not. Configure the
   * client with `transports: ['websocket']` to match.
   */
  transports?: Array<'websocket' | 'polling'>;
  /** Heartbeat: ms without a pong before the connection is dropped. Default `20000`. */
  pingTimeout?: number;
  /** Heartbeat: ms between pings. Default `10000`. */
  pingInterval?: number;
}

export interface SocketIOServerHandle<
  TServerEvents extends SocketEventMap,
  TClientEvents extends SocketEventMap,
> {
  /** The typed Socket.IO server — attach `io.on('connection', ...)` handlers. */
  io: SocketIOServer<TClientEvents, TServerEvents>;
  /**
   * WebSocket handler for `Bun.serve({ websocket })`. Real on Bun; on Node it is
   * an inert no-op — sockets there are driven by the `node:http.Server`
   * `upgrade` event via `serveNode({ socket })`, never by this field — so a Bun
   * consumer can pass it unconditionally without a runtime guard.
   */
  websocket: ReturnType<BunEngine['handler']>['websocket'];
  /**
   * `/socket.io/*` route for `createServer({ rawRoutes })`. Real on Bun; on Node
   * it is unused (sockets attach to the http.Server via `serveNode({ socket })`)
   * and throws if it is ever mounted — so it is safe to spread into `rawRoutes`
   * unconditionally on either runtime.
   */
  route: RawRoute;
  /**
   * Node only — attach the Socket.IO server to the `node:http.Server` from
   * `serveNode`. A no-op on Bun (the engine + route handle transport there).
   * `serveNode({ socket })` calls this for you.
   */
  attach(server: HttpServer): void;
}

/** Inert handler for a runtime-irrelevant slot (Bun's `attach`, Node's `websocket`). */
const noop = (): void => {
  // intentionally empty
};

export async function createSocketIOServer<
  TServerEvents extends SocketEventMap,
  TClientEvents extends SocketEventMap,
>(config: SocketIOServerConfig): Promise<SocketIOServerHandle<TServerEvents, TClientEvents>> {
  const path = config.path ?? '/socket.io/';
  const onBun = 'Bun' in globalThis;
  const transports = config.transports ?? (onBun ? ['websocket', 'polling'] : ['websocket']);

  const { Server } = await import('socket.io');
  const io = new Server<TClientEvents, TServerEvents>({
    path,
    cors: {
      origin: config.cors.origin,
      credentials: config.cors.credentials ?? true,
      methods: ['GET', 'POST'],
    },
    transports,
    pingTimeout: config.pingTimeout ?? 20_000,
    pingInterval: config.pingInterval ?? 10_000,
  });

  if (onBun) {
    const { Server: Engine } = await import('@socket.io/bun-engine');
    const engine = new Engine({ path });
    io.bind(engine);
    const { websocket } = engine.handler();

    const route: RawRoute = {
      method: 'ALL',
      path: `${path.replace(/\/+$/, '')}/*`,
      handler: (req, ctx) => {
        // The Bun server is needed for the WebSocket upgrade. `createServer`
        // always provides it; its absence means the route was mounted on a bare
        // `createHandler` with no server — a wiring bug, so fail loud.
        if (!ctx.server) {
          throw new Error(
            '[stitchkit] createSocketIOServer route needs a running Bun server — mount it via createServer.',
          );
        }
        return engine.handleRequest(req, ctx.server);
      },
    };

    return { io, websocket, route, attach: noop };
  }

  // Node: Socket.IO attaches directly to the node:http.Server (srvx
  // `server.node.server`) and owns the HTTP `upgrade` event. The `route` is a
  // guard — it is never mounted on Node, but keeps the handle shape uniform.
  return {
    io,
    attach: (server) => io.attach(server),
    // Inert on Node — never read (the `upgrade` event drives sockets). Present
    // so Bun consumers get a non-optional `websocket` with no runtime guard.
    websocket: { open: noop, message: noop, close: noop, maxPayloadLength: 0 },
    route: {
      method: 'ALL',
      path: `${path.replace(/\/+$/, '')}/*`,
      handler: () => {
        throw new Error(
          '[stitchkit] On Node, Socket.IO attaches via serveNode({ socket }) — this route is not mounted.',
        );
      },
    },
  };
}

/**
 * Wrap a Socket.IO handle's `websocket` as a catch-all {@link ComposedLane} for
 * {@link composeWebSocketHandlers} — when a second, raw WebSocket lane shares
 * the one `Bun.serve` websocket handler. It claims every socket no earlier
 * (raw-marker) lane matched, so the engine owns whatever the raw lanes did not
 * — and it never inspects the engine's opaque `ws.data`. Place it **last**.
 *
 * ```ts
 * const ws = composeWebSocketHandlers([
 *   webSocketLane({ match: isPcmSocket, handlers: pcmHandlers }),
 *   socketIoLane(socket.websocket),
 * ])
 * ```
 *
 * Bun-only (so is the raw-lane composition it serves).
 */
export function socketIoLane(
  websocket: SocketIOServerHandle<SocketEventMap, SocketEventMap>['websocket'],
): ComposedLane {
  return webSocketLane({
    match: (_ws: ServerWebSocket<unknown>): _ws is Parameters<typeof websocket.message>[0] =>
      true,
    handlers: websocket,
  });
}
