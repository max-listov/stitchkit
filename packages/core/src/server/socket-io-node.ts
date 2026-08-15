/** Node-facing Socket.IO surface without Bun engine declarations. */
import type { Server as HttpServer } from 'node:http';
import type { Server as SocketIOServer } from 'socket.io';
import type { SocketEventMap } from '../browser/socket-io';
import { createSocketIOServer as createRuntimeSocketIOServer } from './socket-io';
import type { SocketIOServerConfig } from './socket-io-config';

export type { SocketIORequestPolicy, SocketIOServerConfig } from './socket-io-config';

/** The runtime-neutral part of a Socket.IO handle used by `serveNode`. */
export interface NodeSocketIOServerHandle<
  TServerEvents extends SocketEventMap,
  TClientEvents extends SocketEventMap,
> {
  io: SocketIOServer<TClientEvents, TServerEvents>;
  attach(server: HttpServer): void;
  beginShutdown(): void;
  close(): Promise<void>;
  connections(): number;
}

/** Create a Socket.IO handle typed only for the Node capabilities it exposes. */
export async function createNodeSocketIOServer<
  TServerEvents extends SocketEventMap,
  TClientEvents extends SocketEventMap,
>(
  config: SocketIOServerConfig,
): Promise<NodeSocketIOServerHandle<TServerEvents, TClientEvents>> {
  return createRuntimeSocketIOServer<TServerEvents, TClientEvents>(config);
}
