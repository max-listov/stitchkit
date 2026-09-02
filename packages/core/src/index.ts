export {
  type ClientConfig,
  type ClientContract,
  type ClientFetch,
  type ClientRegistryValue,
  type ContractClientConfig,
  contractEndpointMatchers,
  createClient,
  createClients,
  createScopedClients,
  createScopedUrlBuilders,
  createUrlBuilder,
  createUrlBuilders,
  type PathPrefixArgs,
  type RegistryScope,
  type ScopeClientConfigs,
  type ScopedClientRegistry,
  type ScopedUrlBuilderRegistry,
  type UrlBuilderConfig,
} from './browser/client';
export {
  ApiError,
  type ApiEvent,
  type ApiEventListener,
  type ConfiguredHttpClient,
  createHttpClient,
  type HeaderProvider,
  type HttpClient,
  type HttpClientConfig,
  type RequestOptions,
  type UnauthorizedMatcher,
} from './browser/http';
export {
  createLiveStateController,
  type LiveStateController,
  type LiveStateControllerConfig,
  type LiveStateControllerError,
  type LiveStateControllerSnapshot,
  type LiveStateControllerStatus,
  LiveStateControllerStatusSchema,
  type LiveStateEventDecision,
  type LiveStatePhase,
  LiveStatePhaseSchema,
  type LiveStateSource,
  type LiveStateSourceOpenInput,
  type LiveStateSourceOpenResult,
  type LiveStateStopReason,
  LiveStateStopReasonSchema,
  type LiveStateSubscriberError,
} from './browser/live-state';
export {
  type Backoff,
  type BackoffPolicy,
  BackoffPolicySchema,
  createBackoff,
  type ResumableAttempt,
  type ResumableIteratorConfig,
  resumableIterator,
} from './browser/resumable';
export type {
  BindRealtimeClientOptions,
  BoundRealtimeClient,
  RealtimeClient,
  RealtimeClientOptions,
  RealtimeClientTransport,
  SocketEventMap,
  SocketIOClient,
  SocketIOClientConfig,
  SocketIOClientPeerLoaders,
} from './browser/socket-io';
export {
  bindRealtimeClient,
  createRealtimeClient,
  createSocketIOClient,
} from './browser/socket-io';
export {
  type ParseNDJSONOptions,
  type ParseSSEOptions,
  parseNDJSON,
  parseSSE,
} from './browser/stream';
export * from './contract';
// The projection a `VALIDATION_ERROR` already travels in — browser-safe (zod only),
// and the same three names the server entry exports, not a second set. A caller
// rendering `ApiError.details.issues` had to hand-write the shape, because the only
// door to it was `stitchkit/server`, which a browser must not import.
export { formatZodError, type ZodIssueSummary, zodIssues } from './internal/errors';
export type { StitchLogger } from './logger';
// W3C trace helpers — browser-safe (Web Crypto only), shared with the server's
// `stitchkit/observability` entry so client and server speak one format.
export {
  childSpan,
  createTraceContext,
  formatTraceparent,
  parseTraceparent,
  type TraceContext,
} from './observability/trace';
export * from './realtime';
export { createRetainedTopics, type RetainedTopics } from './retained';
