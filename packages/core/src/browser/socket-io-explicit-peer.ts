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
  SocketIOClientPeerLoaders,
} from './socket-io-contract';

export type {
  RealtimeClient,
  RealtimeClientOptions,
  SocketEventMap,
  SocketIOClient,
  SocketIOClientConfig,
  SocketIOClientPeerLoaders,
} from './socket-io-contract';

const missingPeer = () =>
  Promise.reject(
    new Error(
      "stitchkit/realtime requires peers.client: () => import('socket.io-client') so the native bundler includes its transport.",
    ),
  );

/** Create a validated realtime client with durable subscriptions and typed requests. */
export function createRealtimeClient<
  const TServerToClient extends RealtimeEventRegistry,
  const TClientToServer extends RealtimeEventRegistry,
>(
  contract: RealtimeContract<TServerToClient, TClientToServer>,
  config: RealtimeClientOptions<TServerToClient> & {
    peers: Required<SocketIOClientPeerLoaders>;
  },
): RealtimeClient<TServerToClient, TClientToServer> {
  return createRealtimeClientWithPeer(contract, config, missingPeer);
}

/** Create the shared Socket.IO transport with durable subscriptions and explicit connection intent. */
export function createSocketIOClient<
  TServerEvents extends SocketEventMap,
  TClientEvents extends SocketEventMap,
>(
  config: SocketIOClientConfig<TServerEvents> & { peers: Required<SocketIOClientPeerLoaders> },
): SocketIOClient<TServerEvents, TClientEvents> {
  return createSocketIOClientWithPeer(config, missingPeer);
}
