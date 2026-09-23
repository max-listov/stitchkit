export {
  createFileStateStore,
  type FileStateStoreCorruption,
  type FileStateStoreOptions,
} from '../application/file-state-store';
export { errorCode, normalizeError } from '../contract/normalize';
export {
  type ClientIpOptions,
  extractIp,
  generateTraceId,
  getClientInfo,
  isPublicIp,
  resolveSocketIp,
  resolveTraceId,
} from '../internal/request';
// The containment check `serveFile` deliberately leaves to its caller — the guide
// and ADRs 0023 / 0038 tell consumers to call it, so it has to be reachable.
export { isWithinDir } from '../internal/within-dir';
// The framework's canonical error classification — reuse it in a bespoke
// `onError` (or for log attribution) instead of reinventing the ZodError → 400
// mapping. `createErrorHook` and the framework default both run through these.
export { formatZodError, type ZodIssueSummary, zodIssues } from '../internal/zod-issues';
export {
  type AuthorizedSocketRoom,
  bindSocketRegistry,
  type SocketRegistry,
  type SocketRegistryConnection,
  type SocketRegistryOptions,
  type SocketRegistryServer,
  type SocketRegistrySnapshot,
  type SocketReplayFrame,
} from '../realtime/registry';
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
} from '../server/bun';
export { type CacheOptions, cacheHeaders, createCache } from '../server/cache';
export { createHandler } from '../server/create';
export {
  createErrorHook,
  type ErrorHookBase,
  type ErrorHookConfig,
  type ErrorHookMapping,
  type ResolvedError,
} from '../server/error-hook';
export {
  createEventBus,
  type DefaultEventMap,
  type EventBus,
  type EventBusOptions,
  type EventHandler,
} from '../server/event-bus';
export {
  type ByteRange,
  parseByteRange,
  type ServeFileOptions,
  serveFile,
  staticRoute,
  weakETag,
} from '../server/file';
export {
  createImplement,
  createMultipartStream,
  createScopedImplement,
  defineMultipartStream,
  type ImplementOptions,
  implement,
  type MissingHandlerPolicy,
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
export { composeLifecycleHooks } from '../server/lifecycle';
export type { LogFormat } from '../server/logger';
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
  type RuleScopes,
  type ScopedAuthHook,
  type ScopedAuthRule,
} from '../server/middleware/auth';
export {
  type CookieDef,
  type CookieDuplicatesPolicy,
  type CookieOptions,
  defineCookie,
  parseCookieHeader,
  parseCookies,
  serializeCookie,
} from '../server/middleware/cookies';
export {
  type CorsConfig,
  corsHeaders,
  corsPreflightResponse,
  DEFAULT_CORS_ALLOW_HEADERS,
  DEFAULT_CORS_EXPOSE_HEADERS,
} from '../server/middleware/cors';
export {
  type JwtPayload,
  type SignJwtOptions,
  signJwt,
  type VerifyJwtOptions,
  verifyJwt,
} from '../server/middleware/jwt';
export { deriveCodeChallenge, type PkceMethod, verifyPkce } from '../server/middleware/pkce';
export {
  createTrustFence,
  isLoopbackAddress,
  type TrustFence,
  type TrustFenceConfig,
  type TrustLane,
  type TrustRefusal,
  type TrustRefusalReason,
} from '../server/middleware/trust-fence';
export {
  type MultipartLifecycle,
  type MultipartResult,
  parseMultipart,
} from '../server/multipart';
export {
  generateOpenApiDocument,
  type OpenApiConfig,
  type OpenApiDocument,
  type OpenApiInfo,
  type OpenApiServer,
  openApiRoute,
} from '../server/openapi';
export {
  bindProcessSignals,
  type ProcessSignalName,
  type ProcessSignalsBinding,
  type ProcessSignalsErrorPhase,
  type ProcessSignalsOptions,
  type ShutdownTarget,
  type SignalSource,
} from '../server/process-signals';
export { createRateLimiter, type RateLimitConfig } from '../server/rate-limit';
export { errorResponse, parseBody, respondJson } from '../server/raw';
export {
  bindRealtimeServer,
  type RealtimeServer,
  type RealtimeServerConnection,
  type RealtimeServerHandle,
} from '../server/realtime';
export {
  bindReleaseRefreshSignal,
  type ReleaseRefreshSignal,
  type ReleaseRefreshSignalOptions,
} from '../server/release-signal';
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
export type {
  SocketIOHandshakeConfig,
  SocketIOPeerLoaders,
  SocketIORequestPolicy,
  SocketIOServerConfig,
  SocketIOServerHandle,
  SocketIOServerLifecycle,
} from '../server/socket-io';
export { createSocketIOServer, socketIoLane } from '../server/socket-io';
export { streamSSE } from '../server/stream';
export {
  DEFAULT_STREAM_HEARTBEAT_MS,
  ndjsonRoute,
  type StreamingFormat,
  type StreamingRouteOptions,
  type StreamingSourceContext,
  sseRoute,
  streamingRoute,
} from '../server/streaming-route';
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
  RouteGroupHooks,
  ScopeContexts,
  ScopedHandlers,
  ServiceDef,
  StitchLogger,
  StreamingMultipartImplementation,
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
  type ComposedLane,
  composeWebSocketHandlers,
  type WebSocketComposeConfig,
  type WebSocketLane,
  webSocketLane,
} from '../server/websocket';
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
} from './contract';
