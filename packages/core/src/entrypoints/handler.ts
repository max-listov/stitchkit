/**
 * Portable Fetch handler and `postMessage` bridge host without Node built-ins;
 * usable in browsers, edge runtimes and React Native / Hermes.
 */

export {
  AppError,
  badRequest,
  conflict,
  forbidden,
  isStitchErrorCode,
  notFound,
  rateLimited,
  STITCH_ERROR_STATUS,
  type StitchErrorCode,
  unauthorized,
} from '../contract/errors';
export {
  type BridgeHostConfig,
  type BridgeHostHandle,
  type BridgeHostPort,
  type BridgeHostStats,
  type BridgeInboundMessage,
  serveBridge,
} from '../server/bridge-host';
export { createHandler } from '../server/create';
export {
  createErrorHook,
  type ErrorHookBase,
  type ErrorHookConfig,
  type ErrorHookMapping,
  type ResolvedError,
} from '../server/error-hook';
export {
  createImplement,
  type ImplementOptions,
  implement,
  type MissingHandlerPolicy,
} from '../server/implement';
export type {
  CorsConfig,
  CorsOriginDecision,
  CorsOriginPolicy,
} from '../server/middleware/cors';
export type {
  FetchHandler,
  HandlerConfig,
  Handlers,
  LifecycleHooks,
  LoggingConfig,
  LogOutcome,
  RawRoute,
  RawRouteContext,
  RouteGroup,
  RouteGroupHooks,
  ServiceDef,
  StitchLogger,
} from '../server/types';
