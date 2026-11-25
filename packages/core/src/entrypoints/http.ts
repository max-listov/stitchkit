/** HTTP clients without the optional realtime peer graph; usable in React Native/Hermes. */
export { ApiError } from '../browser/api-error';
export { BridgeFailureError } from '../browser/bridge-errors';
export {
  type BridgeClientPort,
  type BridgeFetch,
  type BridgeFetchOptions,
  type BridgeInvoke,
  createBridgeFetch,
} from '../browser/bridge-fetch';
export type { BridgeDropReason } from '../browser/bridge-inbound';
export {
  type ChunkedUploadConfig,
  type ChunkedUploadPart,
  type ChunkedUploadProgress,
  type ChunkedUploadStart,
  type ChunkSource,
  uploadInChunks,
} from '../browser/chunked-upload';
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
} from '../browser/client';
export {
  type ApiEvent,
  type ApiEventListener,
  type ConfiguredHttpClient,
  createHttpClient,
  type HeaderProvider,
  type HttpClient,
  type HttpClientConfig,
  type RequestOptions,
  type UnauthorizedMatcher,
} from '../browser/http';
export {
  BRIDGE_ORIGIN,
  type BridgeAbortFrame,
  BridgeAbortFrameSchema,
  type BridgeFailureCode,
  BridgeFailureCodeSchema,
  type BridgeFailureFrame,
  BridgeFailureFrameSchema,
  type BridgeFrame,
  BridgeFrameSchema,
  type BridgeHeaderEntry,
  BridgeHeaderEntrySchema,
  type BridgeHelloFrame,
  BridgeHelloFrameSchema,
  type BridgeRequestFrame,
  BridgeRequestFrameSchema,
  type BridgeResponseFrame,
  BridgeResponseFrameSchema,
  DEFAULT_BRIDGE_MAX_FRAME_BYTES,
} from '../contract/bridge-envelope';
export { type BoundedBodyOptions, readBoundedBody } from '../internal/bounded-body';
export type { StreamByteSource } from '../internal/stream-chunks';
