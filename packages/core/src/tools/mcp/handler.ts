import {
  type AuthInfo,
  createMcpHandler as createSdkMcpHandler,
  hostHeaderValidationResponse,
  localhostAllowedHostnames,
  localhostAllowedOrigins,
  type McpServer,
  originValidationResponse,
} from '@modelcontextprotocol/server';
import { raceAbort } from '../../internal/abort-race';
import { jsonResponse } from '../../internal/json-response';
import {
  type ProtectedResourceConfig,
  wwwAuthenticateHeader,
} from '../../server/oauth/metadata';
import { markProtocolOutcome } from '../../server/protocol-outcome';
import type { RawRoute } from '../../server/types';
import { resolveToolAccess } from '../access';
import {
  MCP_CATALOG_HEADER,
  type McpCatalogStamp,
  mcpCatalogHeaderValue,
} from './catalog-stamp';
import {
  buildMcpServer,
  buildMcpServerFromPrepared,
  type DirectMcpSurfaceConfig,
  type FiniteMcpSurfaceConfig,
  type McpServerSharedConfig,
  servedMcpCatalog,
} from './mount';
import {
  type McpSurfaceRegistry,
  type PreparedMcpServerSurface,
  prepareMcpServerSurface,
} from './prepare';

/** Compatibility posture for protocol revisions predating 2026-07-28. */
export type McpLegacyPolicy = 'serve' | 'reject';

/** DNS-rebinding policy applied before authentication and SDK dispatch. */
export interface McpHttpSecurityConfig {
  /** Allowed `Host` header hostnames. Defaults to loopback hostnames only. */
  allowedHosts?: readonly string[];
  /** Allowed browser `Origin` hostnames. Defaults to loopback hostnames only. */
  allowedOrigins?: readonly string[];
}

/**
 * HTTP-only part of an MCP endpoint config: `auth` resolves a request to an identity (null
 * gives 401); legacy policy and Host/Origin rules are optional.
 */
export interface McpHttpConfig<TAuth> {
  /** Resolve an incoming request to an identity. Return `null` → 401. */
  auth: (req: Request) => TAuth | null | Promise<TAuth | null>;
  /** OAuth 2.0 Protected Resource metadata used by the 401 challenge. */
  protectedResource?: ProtectedResourceConfig;
  /** Serve legacy stateless requests or reject them. Default: `serve`. */
  legacy?: McpLegacyPolicy;
  /** Optional Fetch-boundary Host and Origin policy. */
  security?: McpHttpSecurityConfig;
  /** Observe a protocol/security rejection without entering lifecycle or tool hooks. */
  onTransportRejected?: (event: {
    request: Request;
    response: Response;
  }) => void | Promise<void>;
}

/**
 * Full config for `createMcpHandler`: the shared surface config (excluding stateful lazy
 * `discovery`) plus the HTTP auth settings.
 */
export type McpHandlerConfig<
  TAuth,
  TSurfaces extends McpSurfaceRegistry = McpSurfaceRegistry,
> = Omit<McpServerSharedConfig<TAuth>, 'discovery'> & {
  /** Lazy tool discovery requires a stateful MCP session and is refused on stateless HTTP handlers. */
  readonly discovery?: never;
} & (DirectMcpSurfaceConfig<TAuth> | FiniteMcpSurfaceConfig<TAuth, TSurfaces>) &
  McpHttpConfig<TAuth>;

/** Framework-owned Fetch face for one stateless dual-era MCP endpoint. */
export interface McpHttpHandler {
  fetch(request: Request): Promise<Response>;
  close(): Promise<void>;
}

function jsonRpcError(
  code: number,
  message: string,
  status: number,
  headers?: Record<string, string>,
): Response {
  return jsonResponse(
    { jsonrpc: '2.0', error: { code, message }, id: null },
    { status, headers },
  );
}

function hostValidationResponse(
  request: Request,
  allowedHosts: readonly string[],
): Response | undefined {
  if (request.headers.has('host')) {
    return hostHeaderValidationResponse(request, [...allowedHosts]);
  }

  // Fetch API callers construct a Request without a Host header. The real
  // Bun/Node adapters always provide one, but the transport-neutral handler is
  // also a public Fetch face, so validate its URL hostname against the same
  // configured source of truth instead of rejecting an otherwise valid call.
  const hostname = new URL(request.url).hostname;
  if (allowedHosts.includes(hostname)) return undefined;
  return jsonRpcError(-32000, 'Invalid Host header', 403);
}

function prepareStaticSurface<TAuth>(
  config: McpHandlerConfig<TAuth>,
): ((auth: TAuth) => McpServer) | null {
  const preparation = {
    logger: config.logger,
    extend: config.extend,
    flattenUnionInput: config.flattenUnionInput,
    inputRecursionDepth: config.inputRecursionDepth,
    schemaValidation: config.schemaValidation,
    multiRound: {
      stateConfigured: config.multiRound !== undefined,
      maxRounds: config.multiRound?.serving?.maxRounds ?? 10,
    },
  };

  if (config.surfaces && config.selectSurface) {
    const preparedByKey = new Map<string, PreparedMcpServerSurface>();
    const preparedBySurface = new WeakMap<object, PreparedMcpServerSurface>();
    for (const key in config.surfaces) {
      if (!Object.hasOwn(config.surfaces, key)) continue;
      const surface = config.surfaces[key];
      if (!surface) continue;
      const existing = preparedBySurface.get(surface);
      const prepared = existing ?? prepareMcpServerSurface(surface, preparation);
      if (!existing) preparedBySurface.set(surface, prepared);
      preparedByKey.set(key, prepared);
    }
    return (auth) => {
      const key = config.selectSurface(auth);
      const prepared = preparedByKey.get(key);
      if (!prepared) throw new Error(`[stitchkit] Unknown MCP surface "${key}"`);
      return buildMcpServerFromPrepared(config, auth, prepared);
    };
  }

  if (
    config.services &&
    typeof config.services !== 'function' &&
    typeof config.runtimeTools !== 'function'
  ) {
    const prepared = prepareMcpServerSurface(
      { services: config.services, runtimeTools: config.runtimeTools },
      preparation,
    );
    return (auth) => buildMcpServerFromPrepared(config, auth, prepared);
  }

  return null;
}

/**
 * Build a stateless MCP HTTP handler on the official SDK v2 request factory.
 * Every request gets a fresh SDK server and a fresh Stitchkit tool context;
 * no protocol session, event store or `Mcp-Session-Id` exists in this layer.
 */
export function createMcpHandler<
  TAuth,
  const TSurfaces extends McpSurfaceRegistry = McpSurfaceRegistry,
>(config: McpHandlerConfig<TAuth, TSurfaces>): McpHttpHandler {
  resolveToolAccess('createMcpHandler', config);
  if ('discovery' in config && config.discovery !== undefined) {
    throw new TypeError(
      '[stitchkit] createMcpHandler: lazy tool discovery requires a stateful MCP session; use createStdioMcpServer, buildMcpServer, or mountMcp instead',
    );
  }
  const buildPrepared = prepareStaticSurface(config);
  const authByCarrier = new WeakMap<
    AuthInfo,
    { value: TAuth; served?: McpCatalogStamp | undefined }
  >();
  let closed = false;
  const closing = new AbortController();

  const sdkHandler = createSdkMcpHandler(
    ({ authInfo }) => {
      const resolved = authInfo ? authByCarrier.get(authInfo) : undefined;
      if (!resolved) {
        throw new Error('[stitchkit] MCP request reached the SDK without resolved auth');
      }
      const auth = resolved.value;
      const server = buildPrepared ? buildPrepared(auth) : buildMcpServer(config, auth);
      resolved.served = servedMcpCatalog(server);
      return server;
    },
    {
      legacy: config.legacy === 'reject' ? 'reject' : 'stateless',
      maxSubscriptions: 0,
    },
  );

  const unauthorized = (): Response => {
    const headers = config.protectedResource
      ? { 'WWW-Authenticate': wwwAuthenticateHeader(config.protectedResource.resource) }
      : undefined;
    return jsonRpcError(-32001, 'Authorization required', 401, headers);
  };

  const observeRejection = (request: Request, response: Response): Response => {
    if (response.status < 400 || !config.onTransportRejected) return response;
    void Promise.resolve(
      config.onTransportRejected({ request, response: response.clone() }),
    ).catch(() => undefined);
    return response;
  };

  return {
    fetch: async (request) => {
      if (closed) {
        return observeRejection(request, jsonRpcError(-32000, 'MCP handler is closed', 503));
      }
      const allowedHosts = config.security?.allowedHosts ?? localhostAllowedHostnames();
      const hostRejection = hostValidationResponse(request, allowedHosts);
      if (hostRejection) return observeRejection(request, hostRejection);

      const allowedOrigins = config.security?.allowedOrigins ?? localhostAllowedOrigins();
      const originRejection = originValidationResponse(request, [...allowedOrigins]);
      if (originRejection) return observeRejection(request, originRejection);

      // Each request owns its wait on `closing`: a promise shared by every request would keep
      // one reaction, and the auth result it carries, per request for the life of the handler.
      const auth = await raceAbort(
        Promise.resolve(config.auth(request)),
        closing.signal,
      ).catch((error: unknown) => {
        if (closing.signal.aborted) return null;
        throw error;
      });
      if (closed) {
        return observeRejection(request, jsonRpcError(-32000, 'MCP handler is closed', 503));
      }
      if (auth == null) return observeRejection(request, unauthorized());
      const authCarrier: AuthInfo = {
        token: '',
        clientId: config.multiRound?.state.principal(auth) ?? 'stitchkit',
        scopes: [],
      };
      const resolved: { value: TAuth; served?: McpCatalogStamp | undefined } = { value: auth };
      authByCarrier.set(authCarrier, resolved);
      try {
        const response = await sdkHandler.fetch(request, { authInfo: authCarrier });
        const answered = withCatalogHeader(response, resolved.served);
        return observeRejection(request, markSessionOperationRefusal(request, answered));
      } finally {
        authByCarrier.delete(authCarrier);
      }
    },
    close: async () => {
      if (closed) return;
      closed = true;
      closing.abort();
      await sdkHandler.close();
    },
  };
}

/**
 * A stateless endpoint offers no event stream and no session to end, and Streamable HTTP
 * names `405` as the answer to both: to the `GET` that opens the stream and the `DELETE`
 * that ends a session. The official client reads either as "not offered here" and carries
 * on, so the request line logs them as the ordinary answers they are. A `405` to any other
 * method is a client mistake and keeps its warning.
 */
function markSessionOperationRefusal(request: Request, response: Response): Response {
  if (response.status !== 405) return response;
  if (request.method !== 'GET' && request.method !== 'DELETE') return response;
  return markProtocolOutcome(response);
}

/**
 * Carry the served catalog's stamp on the response, so a client holding a stored catalog can
 * tell from `initialize` alone whether `tools/list` would answer anything new.
 */
function withCatalogHeader(response: Response, served: McpCatalogStamp | undefined): Response {
  if (!served) return response;
  const headers = new Headers(response.headers);
  headers.set(MCP_CATALOG_HEADER, mcpCatalogHeaderValue(served));
  return new Response(response.body, {
    status: response.status,
    statusText: response.statusText,
    headers,
  });
}

/** Mount an MCP handler as an ordinary framework-owned raw HTTP route. */
export function createMcpHttpRoute(config: {
  path: string;
  handler: McpHttpHandler;
}): RawRoute {
  return {
    method: 'ALL',
    path: config.path,
    handler: (request) => config.handler.fetch(request),
  };
}
