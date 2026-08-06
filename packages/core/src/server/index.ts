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
export { cacheHeaders, createCache } from './cache';
export { createHandler, createServer } from './create';
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
  type ClientIpOptions,
  extractIp,
  generateTraceId,
  getClientInfo,
  resolveSocketIp,
  resolveTraceId,
} from './request';
export { staticRoute } from './router';
export type { SocketIOServerConfig, SocketIOServerHandle } from './socket-io';
export { createSocketIOServer, socketIoLane } from './socket-io';
export { type ParseSSEOptions, parseSSE, streamSSE } from './stream';
export type {
  BunServer,
  BunServerConfig,
  FetchComposition,
  FetchHandler,
  HandlerConfig,
  Handlers,
  LifecycleHooks,
  LoggingConfig,
  LogOutcome,
  MethodDef,
  RawRoute,
  RawRouteContext,
  RouteGroup,
  ServerPassthrough,
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
