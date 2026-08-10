import {
  type AuthInfo,
  createMcpHandler as createSdkMcpHandler,
  hostHeaderValidationResponse,
  localhostAllowedHostnames,
  localhostAllowedOrigins,
  type McpServer,
  originValidationResponse,
} from '@modelcontextprotocol/server';
import type { RawRoute } from '../server/types';
import { buildMcpServer, buildMcpServerFromPrepared, type McpServerBuildConfig } from './mcp';
import {
  type McpSurfaceRegistry,
  type PreparedMcpServerSurface,
  prepareMcpServerSurface,
} from './mcp-prepare';
import { type ProtectedResourceConfig, wwwAuthenticateHeader } from './oauth-metadata';

/** Compatibility posture for protocol revisions predating 2026-07-28. */
export type McpLegacyPolicy = 'serve' | 'reject';

/** DNS-rebinding policy applied before authentication and SDK dispatch. */
export interface McpHttpSecurityConfig {
  /** Allowed `Host` header hostnames. Defaults to loopback hostnames only. */
  allowedHosts?: readonly string[];
  /** Allowed browser `Origin` hostnames. Defaults to loopback hostnames only. */
  allowedOrigins?: readonly string[];
}

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

export type McpHandlerConfig<
  TAuth,
  TSurfaces extends McpSurfaceRegistry = McpSurfaceRegistry,
> = McpServerBuildConfig<TAuth, TSurfaces> & McpHttpConfig<TAuth>;

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
  return Response.json(
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
  const buildPrepared = prepareStaticSurface(config);
  const authByCarrier = new WeakMap<AuthInfo, { value: TAuth }>();
  let closed = false;
  let resolveClosed: (() => void) | undefined;
  const closedSignal = new Promise<void>((resolve) => {
    resolveClosed = resolve;
  });

  const sdkHandler = createSdkMcpHandler(
    ({ authInfo }) => {
      const resolved = authInfo ? authByCarrier.get(authInfo) : undefined;
      if (!resolved) {
        throw new Error('[stitchkit] MCP request reached the SDK without resolved auth');
      }
      const auth = resolved.value;
      return buildPrepared ? buildPrepared(auth) : buildMcpServer(config, auth);
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

      const auth = await Promise.race([
        Promise.resolve(config.auth(request)),
        closedSignal.then(() => null),
      ]);
      if (closed) {
        return observeRejection(request, jsonRpcError(-32000, 'MCP handler is closed', 503));
      }
      if (auth == null) return observeRejection(request, unauthorized());
      const authCarrier: AuthInfo = {
        token: '',
        clientId: config.multiRound?.state.principal(auth) ?? 'stitchkit',
        scopes: [],
      };
      authByCarrier.set(authCarrier, { value: auth });
      try {
        return observeRejection(
          request,
          await sdkHandler.fetch(request, { authInfo: authCarrier }),
        );
      } finally {
        authByCarrier.delete(authCarrier);
      }
    },
    close: async () => {
      if (closed) return;
      closed = true;
      resolveClosed?.();
      await sdkHandler.close();
    },
  };
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
