/**
 * `stitchkit/node` — the Node entrypoint. Everything a Node app needs without
 * touching the Bun-named `createServer`: the Fetch-clean `createHandler`, the
 * srvx-backed `serveNode`, `implement`, the error helpers and (lazily-loaded,
 * Node-safe) `createSocketIOServer`.
 */

export { createHandler } from '../server/create';
export {
  createImplement,
  createMultipartStream,
  createScopedImplement,
  implement,
  type MultipartStreamConfig,
  type StreamScope,
} from '../server/implement';
export {
  createImplementRegistry,
  createScopedImplementRegistry,
  type ExactRegistryHandlers,
  type ExactScopedRegistryHandlers,
  type ImplementationRegistry,
  implementRegistry,
  type KeyedServices,
  type RegistryHandlers,
  type ScopedImplementationRegistry,
  type ScopedRegistryHandlers,
} from '../server/implement-registry';
export type { LogFormat } from '../server/logger';
export {
  type NodeRuntimeServer,
  type NodeServerConfig,
  type NodeServerHandle,
  type NodeSocketLifecycle,
  serveNode,
} from '../server/node';
export {
  bindProcessSignals,
  type ProcessSignalName,
  type ProcessSignalsBinding,
  type ProcessSignalsErrorPhase,
  type ProcessSignalsOptions,
  type ShutdownTarget,
  type SignalSource,
} from '../server/process-signals';
export {
  bindRealtimeServer,
  type RealtimeServer,
  type RealtimeServerConnection,
  type RealtimeServerHandle,
} from '../server/realtime';
export {
  type ManagedServerHandle,
  type ShutdownOptions,
  ShutdownOptionsSchema,
  type ShutdownResult,
  ShutdownResultSchema,
  type ShutdownState,
  ShutdownStateSchema,
  type ShutdownStatus,
  ShutdownStatusSchema,
} from '../server/shutdown';
export {
  createNodeSocketIOServer as createSocketIOServer,
  type NodeSocketIOServerHandle as SocketIOServerHandle,
  type SocketIOHandshakeConfig,
  type SocketIOPeerLoaders,
  type SocketIORequestPolicy,
  type SocketIOServerConfig,
} from '../server/socket-io-node';
export type {
  EffectiveScope,
  FetchComposition,
  FetchHandler,
  HandlerConfig,
  LoggingConfig,
  LogOutcome,
  RawRoute,
  RawRouteContext,
  ScopeContexts,
  ScopedHandlers,
  ServiceDef,
} from '../server/types';
export {
  createUnixClientTransport,
  type UnixClientDeliveryState,
  type UnixClientTransport,
  type UnixClientTransportConfig,
  UnixClientTransportError,
  type UnixClientTransportErrorCode,
  type UnixResponseBodyMode,
} from '../server/unix-client';
export {
  AppError,
  appError,
  badRequest,
  conflict,
  forbidden,
  notFound,
  rateLimited,
  unauthorized,
} from './contract';
