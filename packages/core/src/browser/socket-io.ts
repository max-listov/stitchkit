import type { RealtimeContract, RealtimeEventRegistry } from '../realtime/contract';
import {
  createRealtimeClientWithPeer,
  createSocketIOClientWithPeer,
} from './socket-io-client';
import type {
  RealtimeClient,
  RealtimeClientOptions,
  SocketEventMap,
  SocketIOClient,
  SocketIOClientConfig,
} from './socket-io-contract';

export type {
  RealtimeClient,
  RealtimeClientOptions,
  SocketEventMap,
  SocketIOClient,
  SocketIOClientConfig,
  SocketIOClientPeerLoaders,
} from './socket-io-contract';

import { loadDefaultIo } from './socket-io-default-peer';

/** Create a validated realtime client with durable subscriptions and typed requests. */
export function createRealtimeClient<
  const TServerToClient extends RealtimeEventRegistry,
  const TClientToServer extends RealtimeEventRegistry,
>(
  contract: RealtimeContract<TServerToClient, TClientToServer>,
  config: RealtimeClientOptions<TServerToClient>,
): RealtimeClient<TServerToClient, TClientToServer> {
  return createRealtimeClientWithPeer(contract, config, loadDefaultIo);
}

/** Create the shared Socket.IO transport with durable subscriptions and explicit connection intent. */
export function createSocketIOClient<
  TServerEvents extends SocketEventMap,
  TClientEvents extends SocketEventMap,
>(config: SocketIOClientConfig<TServerEvents>): SocketIOClient<TServerEvents, TClientEvents> {
  return createSocketIOClientWithPeer(config, loadDefaultIo);
}
