/** Node-facing Socket.IO surface without Bun engine declarations. */
import type { Server as HttpServer } from 'node:http';
import type { DefaultEventsMap, Server as SocketIOServer } from 'socket.io';
import type { SocketEventMap } from '../browser/socket-io';
import { createSocketIOServer as createRuntimeSocketIOServer } from './socket-io';
import type { SocketIOServerConfig } from './socket-io-config';

export type {
  SocketIOHandshakeConfig,
  SocketIORequestPolicy,
  SocketIOServerConfig,
} from './socket-io-config';

/** The runtime-neutral part of a Socket.IO handle used by `serveNode`. */
export interface NodeSocketIOServerHandle<
  TServerEvents extends SocketEventMap,
  TClientEvents extends SocketEventMap,
  TData = any,
> {
  io: SocketIOServer<TClientEvents, TServerEvents, DefaultEventsMap, TData>;
  attach(server: HttpServer): void;
  beginShutdown(): void;
  close(): Promise<void>;
  connections(): number;
}

/** Create a Socket.IO handle typed only for the Node capabilities it exposes. */
export async function createNodeSocketIOServer<
  TServerEvents extends SocketEventMap,
  TClientEvents extends SocketEventMap,
  // `any` mirrors createSocketIOServer: a no-`handshake` call keeps the
  // pre-gate `socket.data: any`; inference overrides when `handshake` is set.
  TParsed = any,
  TData = TParsed,
>(
  config: SocketIOServerConfig<TParsed, TData>,
): Promise<NodeSocketIOServerHandle<TServerEvents, TClientEvents, TData>> {
  return createRuntimeSocketIOServer<TServerEvents, TClientEvents, TParsed, TData>(config);
}
