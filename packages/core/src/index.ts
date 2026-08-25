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
