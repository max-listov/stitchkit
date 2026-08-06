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
export { createImplement, implement } from './server/implement';
export type { LogFormat } from './server/logger';
export { type NodeServerConfig, type NodeServerHandle, serveNode } from './server/node';
export {
  createSocketIOServer,
  type SocketIOServerConfig,
  type SocketIOServerHandle,
} from './server/socket-io';
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
