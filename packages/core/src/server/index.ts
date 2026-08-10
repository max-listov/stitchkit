export {
  AppError,
  appError,
  badRequest,
  conflict,
  forbidden,
  isStitchErrorCode,
  notFound,
  rateLimited,
  STITCH_ERROR_STATUS,
  type StitchErrorCode,
  unauthorized,
} from '../contract';
// The framework's canonical error classification — reuse it in a bespoke
// `onError` (or for log attribution) instead of reinventing the ZodError → 400
// mapping. `createErrorHook` and the framework default both run through these.
export {
  errorCode,
  formatZodError,
  normalizeError,
  type ZodIssueSummary,
  zodIssues,
} from '../internal/errors';
// The containment check `serveFile` deliberately leaves to its caller — the guide
// and ADRs 0023 / 0038 tell consumers to call it, so it has to be reachable.
export { isWithinDir } from '../internal/within-dir';
export {
  type BunFetchComposition as FetchComposition,
  type BunFetchHandler as FetchHandler,
  type BunHandlerConfig as HandlerConfig,
  type BunRawRoute as RawRoute,
  type BunRawRouteContext as RawRouteContext,
  type BunServer,
  type BunServerConfig,
  createServer,
  type ServerPassthrough,
} from './bun';
export { type CacheOptions, cacheHeaders, createCache } from './cache';
export { createHandler } from './create';
export {
  createErrorHook,
  type ErrorHookConfig,
  type ResolvedError,
} from './error-hook';
export {
  createEventBus,
  type DefaultEventMap,
  type EventBus,
  type EventBusOptions,
  type EventHandler,
} from './event-bus';
export {
  type ByteRange,
  parseByteRange,
  type ServeFileOptions,
  serveFile,
  staticRoute,
  weakETag,
} from './file';
export { createImplement, implement } from './implement';
export type { LogFormat } from './logger';
export {
  type AuthHook,
  type AuthHookConfig,
  type AuthRule,
  type BearerResolverConfig,
  createAuthHook,
  createBearerResolver,
  extractToken,
  type JwtPayload,
  type SignJwtOptions,
  signJwt,
  type VerifyJwtOptions,
  verifyJwt,
} from './middleware/auth';
export {
  type CookieDef,
  type CookieOptions,
  defineCookie,
  parseCookies,
  serializeCookie,
} from './middleware/cookies';
export {
  type CorsConfig,
  corsHeaders,
  corsPreflightResponse,
  DEFAULT_CORS_ALLOW_HEADERS,
  DEFAULT_CORS_EXPOSE_HEADERS,
} from './middleware/cors';
export { deriveCodeChallenge, type PkceMethod, verifyPkce } from './middleware/pkce';
export { type MultipartResult, parseMultipart } from './multipart';
export {
  generateOpenApiDocument,
  type OpenApiConfig,
  type OpenApiDocument,
  type OpenApiInfo,
  type OpenApiServer,
  openApiRoute,
} from './openapi';
export { createRateLimiter, type RateLimitConfig } from './rate-limit';
export { errorResponse, parseBody, respondJson } from './raw';
export {
  bindRealtimeServer,
  type RealtimeServer,
  type RealtimeServerConnection,
  type RealtimeServerHandle,
} from './realtime';
export {
  type ClientIpOptions,
  extractIp,
  generateTraceId,
  getClientInfo,
  resolveSocketIp,
  resolveTraceId,
} from './request';
export type { SocketIOServerConfig, SocketIOServerHandle } from './socket-io';
export { createSocketIOServer, socketIoLane } from './socket-io';
export { type ParseSSEOptions, parseSSE, streamSSE } from './stream';
export type {
  Handlers,
  LifecycleHooks,
  LoggingConfig,
  LogOutcome,
  MethodDef,
  OperationIdentity,
  RouteGroup,
  ServiceDef,
  StitchLogger,
} from './types';
export {
  type ComposedLane,
  composeWebSocketHandlers,
  type WebSocketComposeConfig,
  type WebSocketLane,
  webSocketLane,
} from './websocket';
