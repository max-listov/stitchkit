/**
 * `stitchkit/node` — the Node entrypoint. Everything a Node app needs without
 * touching the Bun-named `createServer`: the Fetch-clean `createHandler`, the
 * srvx-backed `serveNode`, `implement`, the error helpers and (lazily-loaded,
 * Node-safe) `createSocketIOServer`.
 */
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
export { createHandler } from './server/create';
export {
  createImplement,
  createImplementRegistry,
  type ExactRegistryHandlers,
  type ImplementationRegistry,
  implement,
  implementRegistry,
  type RegistryHandlers,
} from './server/implement';
export type { LogFormat } from './server/logger';
export {
  type NodeRuntimeServer,
  type NodeServerConfig,
  type NodeServerHandle,
  type NodeSocketLifecycle,
  serveNode,
} from './server/node';
export {
  bindRealtimeServer,
  type RealtimeServer,
  type RealtimeServerConnection,
  type RealtimeServerHandle,
} from './server/realtime';
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
} from './server/shutdown';
export {
  createNodeSocketIOServer as createSocketIOServer,
  type NodeSocketIOServerHandle as SocketIOServerHandle,
  type SocketIORequestPolicy,
  type SocketIOServerConfig,
} from './server/socket-io-node';
export type {
  FetchComposition,
  FetchHandler,
  HandlerConfig,
  LoggingConfig,
  LogOutcome,
  RawRoute,
  RawRouteContext,
  ServiceDef,
} from './server/types';
