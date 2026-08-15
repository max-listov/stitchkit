/** Runtime-neutral Socket.IO configuration shared by Bun and Node adapters. */
import type { ServerOptions } from 'socket.io';

/** Runtime-neutral Engine.IO handshake policy, evaluated before shutdown admission. */
export type SocketIORequestPolicy = (request: Request) => boolean | Promise<boolean>;

export interface SocketIOServerConfig {
  /** CORS — the browser origin(s) allowed to open a socket. */
  cors: { origin: string | string[]; credentials?: boolean };
  /** Socket.IO endpoint path. Default `/socket.io/`. */
  path?: string;
  /** Transports offered to clients; the runtime supplies its own default. */
  transports?: Array<'websocket' | 'polling'>;
  /** Heartbeat: ms without a pong before the connection is dropped. */
  pingTimeout?: number;
  /** Heartbeat: ms between pings. */
  pingInterval?: number;
  /** Runtime-neutral policy for accepting a new Engine.IO handshake. */
  allowRequest?: SocketIORequestPolicy;
  /** Typed Socket.IO options not owned by this wrapper. */
  serverOptions?: Omit<Partial<ServerOptions>, 'allowRequest'>;
}
