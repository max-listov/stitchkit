export {
  type ClientConfig,
  type ClientContract,
  type ClientRegistryValue,
  type ContractClientConfig,
  contractEndpointMatchers,
  createClient,
  createClients,
  createScopedClients,
  createUrlBuilder,
  createUrlBuilders,
  type PathPrefixArgs,
  type RegistryScope,
  type ScopeClientConfigs,
  type ScopedClientRegistry,
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
  SocketEventMap,
  SocketIOClient,
  SocketIOClientConfig,
} from './browser/socket-io';
export { createSocketIOClient } from './browser/socket-io';
export { type ParseSSEOptions, parseSSE } from './browser/stream';
export * from './contract';
// W3C trace helpers — browser-safe (Web Crypto only), shared with the server's
// `stitchkit/observability` entry so client and server speak one format.
export {
  childSpan,
  createTraceContext,
  formatTraceparent,
  parseTraceparent,
  type TraceContext,
} from './observability/trace';
export { createRetainedTopics, type RetainedTopics } from './retained';
