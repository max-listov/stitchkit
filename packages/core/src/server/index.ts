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
  type BunServerHandle,
  createServer,
  type ServerPassthrough,
  type UnixListenConfig,
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
export {
  createImplement,
  createImplementRegistry,
  createMultipartStream,
  createScopedImplement,
  createScopedImplementRegistry,
  defineMultipartStream,
  type ExactRegistryHandlers,
  type ExactScopedRegistryHandlers,
  type ImplementationRegistry,
  implement,
  implementRegistry,
  type KeyedServices,
  type MultipartStreamConfig,
  type RegistryHandlers,
  type ScopedImplementationRegistry,
  type ScopedRegistryHandlers,
  type StreamScope,
} from './implement';
export { composeLifecycleHooks } from './lifecycle';
export type { LogFormat } from './logger';
export {
  type AuthHook,
  type AuthHookConfig,
  type AuthRule,
  type AuthRuleContribution,
  type AuthRules,
  type AuthScopes,
  type BearerResolverConfig,
  type ComposeAuthHooksConfig,
  type ComposedAuthScopes,
  composeAuthHooks,
  createAuthHook,
  createBearerResolver,
  extractToken,
  type JwtPayload,
  type RuleScopes,
  type ScopedAuthHook,
  type ScopedAuthRule,
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
export { type MultipartLifecycle, type MultipartResult, parseMultipart } from './multipart';
export {
  generateOpenApiDocument,
  type OpenApiConfig,
  type OpenApiDocument,
  type OpenApiInfo,
  type OpenApiServer,
  openApiRoute,
} from './openapi';
export {
  bindProcessSignals,
  type ProcessSignalName,
  type ProcessSignalsBinding,
  type ProcessSignalsErrorPhase,
  type ProcessSignalsOptions,
  type ShutdownTarget,
  type SignalSource,
} from './process-signals';
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
} from './shutdown';
export type {
  SocketIOHandshakeConfig,
  SocketIOPeerLoaders,
  SocketIORequestPolicy,
  SocketIOServerConfig,
  SocketIOServerHandle,
  SocketIOServerLifecycle,
} from './socket-io';
export { createSocketIOServer, socketIoLane } from './socket-io';
export { type ParseSSEOptions, parseSSE, streamSSE } from './stream';
export {
  DEFAULT_STREAM_HEARTBEAT_MS,
  ndjsonRoute,
  type StreamingFormat,
  type StreamingRouteOptions,
  type StreamingSourceContext,
  sseRoute,
  streamingRoute,
} from './streaming-route';
export type {
  AuthorizationContext,
  EffectiveScope,
  EndpointHandlerContext,
  Handlers,
  LifecycleHooks,
  LoggingConfig,
  LogOutcome,
  MethodDef,
  MultipartFileMetadata,
  MultipartReceiver,
  MultipartReceiverResult,
  OperationIdentity,
  RouteGroup,
  ScopeContexts,
  ScopedHandlers,
  ServiceDef,
  StitchLogger,
  StreamingMultipartImplementation,
} from './types';
export {
  createUnixClientTransport,
  type UnixClientDeliveryState,
  type UnixClientTransport,
  type UnixClientTransportConfig,
  UnixClientTransportError,
  type UnixClientTransportErrorCode,
  type UnixResponseBodyMode,
} from './unix-client';
export {
  type ComposedLane,
  composeWebSocketHandlers,
  type WebSocketComposeConfig,
  type WebSocketLane,
  webSocketLane,
} from './websocket';
