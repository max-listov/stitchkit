/**
 * Socket.IO server setup — the family WebSocket server boilerplate.
 *
 * Every project repeats the same wiring: `new SocketIOServer(...)`, a
 * `@socket.io/bun-engine` instance, `io.bind(engine)`, `engine.handler()` for
 * the `Bun.serve` `websocket` field, and an `/socket.io/*` route delegating to
 * `engine.handleRequest`. `createSocketIOServer` is exactly that wiring.
 *
 * Connection handlers, rooms and handshake auth stay in the project — they are
 * domain logic. This helper owns only the transport plumbing: it returns the
 * typed `io` to attach handlers to, the `websocket` handler for `Bun.serve`,
 * and a ready-made `route` to drop into `createServer({ rawRoutes })`.
 */
import { Server as BunEngine } from '@socket.io/bun-engine';
import { Server as SocketIOServer } from 'socket.io';
import type { SocketEventMap } from '../browser/socket-io';
import type { RawRoute } from './types';

export interface SocketIOServerConfig {
  /** CORS — the browser origin(s) allowed to open a socket. */
  cors: { origin: string | string[]; credentials?: boolean };
  /** Socket.IO endpoint path. Default `/socket.io/`. */
  path?: string;
  /** Transports offered to clients. Default `['websocket', 'polling']`. */
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
  /** WebSocket handler for `Bun.serve({ websocket })`. */
  websocket: ReturnType<BunEngine['handler']>['websocket'];
  /** Ready `/socket.io/*` route — drop into `createServer({ rawRoutes })`. */
  route: RawRoute;
}

export function createSocketIOServer<
  TServerEvents extends SocketEventMap,
  TClientEvents extends SocketEventMap,
>(config: SocketIOServerConfig): SocketIOServerHandle<TServerEvents, TClientEvents> {
  const path = config.path ?? '/socket.io/';

  const io = new SocketIOServer<TClientEvents, TServerEvents>({
    path,
    cors: {
      origin: config.cors.origin,
      credentials: config.cors.credentials ?? true,
      methods: ['GET', 'POST'],
    },
    transports: config.transports ?? ['websocket', 'polling'],
    pingTimeout: config.pingTimeout ?? 20_000,
    pingInterval: config.pingInterval ?? 10_000,
  });

  const engine = new BunEngine({ path });
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

  return { io, websocket, route };
}
