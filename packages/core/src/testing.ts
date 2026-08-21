/**
 * `stitchkit/testing` — integration helpers that preserve the production
 * generated-client and Fetch-handler pipelines without opening a TCP port.
 */

import {
  type ClientConfig,
  type ClientFetch,
  type ContractClientConfig,
  createClient,
  createClients,
  type ScopedKeys,
} from './browser/client';
import type { ContractDef, EndpointDef, ScopedHttpClient } from './contract';
import type { FetchHandler } from './server/types';

export type HandlerTestClientDefaults = Omit<ClientConfig, 'baseUrl' | 'fetch'>;

export interface HandlerTestTransportConfig<TServer> {
  handler: FetchHandler<TServer>;
  /** Mount prefix used by the handler, for example `api`. */
  pathPrefix?: string;
  /** Synthetic absolute origin used only to construct standards-compliant Requests. */
  origin?: string;
  /** Ordinary bare-client options such as headers, timeout and credentials. */
  client?: HandlerTestClientDefaults;
  /** Optional runtime server handle passed to raw routes. */
  server?: TServer;
}

export interface HandlerTestClientConfig<
  T extends Record<string, EndpointDef>,
  TServer = unknown,
  K extends string = never,
> extends HandlerTestTransportConfig<TServer> {
  contract: ContractDef<T, string>;
  contractConfig?: ContractClientConfig<K>;
}

export interface HandlerTestClientsConfig<
  T extends Record<string, ContractDef<Record<string, EndpointDef>, string>>,
  TServer = unknown,
  K extends string = never,
> extends HandlerTestTransportConfig<TServer> {
  contracts: T;
  contractConfig?: ContractClientConfig<K>;
}

function resolveTestBaseUrl(
  origin: string | undefined,
  pathPrefix: string | undefined,
): string {
  const base = new URL(origin ?? 'http://stitchkit.test');
  if (base.pathname !== '/' || base.search || base.hash) {
    throw new TypeError('Handler test client origin must contain only an absolute origin');
  }
  const prefix = pathPrefix?.replace(/^\/+|\/+$/g, '');
  return prefix ? `${base.origin}/${prefix}` : base.origin;
}

function createHandlerFetch<TServer>(
  handler: FetchHandler<TServer>,
  server: TServer | undefined,
): ClientFetch {
  return async (input, init) => handler(new Request(input, init), server);
}

function createTestClientConfig<TServer>(
  config: HandlerTestTransportConfig<TServer>,
): ClientConfig {
  return {
    ...config.client,
    baseUrl: resolveTestBaseUrl(config.origin, config.pathPrefix),
    fetch: createHandlerFetch(config.handler, config.server),
  };
}

/** Build one generated contract client whose Requests run through a real handler in-process. */
export function createHandlerTestClient<
  T extends Record<string, EndpointDef>,
  TServer = unknown,
  const K extends string = never,
>(config: HandlerTestClientConfig<T, TServer, K>): ScopedHttpClient<T, ScopedKeys<K>> {
  return createClient(config.contract, createTestClientConfig(config), config.contractConfig);
}

/** Batch form of `createHandlerTestClient`, derived from one literal contract registry. */
export function createHandlerTestClients<
  T extends Record<string, ContractDef<Record<string, EndpointDef>, string>>,
  TServer = unknown,
  const K extends string = never,
>(
  config: HandlerTestClientsConfig<T, TServer, K>,
): { [P in keyof T]: ScopedHttpClient<T[P]['endpoints'], ScopedKeys<K>> } {
  return createClients(
    config.contracts,
    createTestClientConfig(config),
    config.contractConfig,
  );
}

export {
  assertSurfaceDiscovery,
  type ConformanceTransport,
  type CreateRealtimeProbeDriverConfig,
  createRealtimeProbeDriver,
  type DefineRealtimeProbeConfig,
  defineRealtimeProbe,
  type RealtimeDisconnectObservation,
  RealtimeDisconnectObservationSchema,
  type RealtimeProbeAdapter,
  type RealtimeProbeFixture,
  type RealtimeProbeScenario,
  type RealtimeRejectionObservation,
  RealtimeRejectionObservationSchema,
  type RunSurfaceProbesConfig,
  runSurfaceProbes,
  type SurfaceDiscoveryObservation,
  type SurfaceProbe,
  type SurfaceProbeDriver,
  type SurfaceRealtimeDiscoveryObservation,
  type SurfaceToolDiscoveryObservation,
  type TransportObservation,
  TransportObservationSchema,
} from './testing/surface-conformance';
export {
  assertSurfaceManifestSnapshot,
  buildSurfaceManifest,
  type IncompatibleSchemaPolicy,
  type McpSchemaValidationConfig,
  type SurfaceAgentProjection,
  type SurfaceManifest,
  type SurfaceManifestConfig,
  type SurfaceManifestExtension,
  SurfaceManifestExtensionSchema,
  type SurfaceManifestOperation,
  SurfaceManifestOperationSchema,
  type SurfaceManifestRealtimeEvent,
  SurfaceManifestRealtimeEventSchema,
  SurfaceManifestSchema,
  type SurfaceManifestTool,
  SurfaceManifestToolSchema,
  type SurfaceManifestToolSurface,
  SurfaceManifestToolSurfaceSchema,
  type SurfaceMcpPreparation,
  SurfaceRealtimeSchemaPairSchema,
  type SurfaceRuntimeToolDefinition,
  SurfaceSchemaDigestsSchema,
  type SurfaceToolDefinition,
  type SurfaceToolExtension,
  serializeSurfaceValue,
} from './testing/surface-manifest';
