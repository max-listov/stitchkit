/** Realtime clients for native bundles: the caller supplies a literal Socket.IO peer loader. */

export { createRetainedTopics, type RetainedTopics } from '../browser/retained';
export type {
  RealtimeClient,
  RealtimeClientOptions,
  SocketEventMap,
  SocketIOClient,
  SocketIOClientConfig,
  SocketIOClientPeerLoaders,
} from '../browser/socket-io-contract';
export {
  createRealtimeClient,
  createSocketIOClient,
} from '../browser/socket-io-explicit-peer';
export {
  defineRealtimeContract,
  type InferRealtimeEventMap,
  type RealtimeContract,
  type RealtimeEventRegistry,
} from '../realtime/contract';
