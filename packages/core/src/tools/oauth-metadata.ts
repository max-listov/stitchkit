import type { RawRoute } from '../server/types';

/**
 * OAuth 2.0 Protected Resource Metadata (RFC 9728). An MCP server acting as a
 * resource server publishes this so a client, after a `401`, can discover which
 * authorization server(s) issue tokens for it.
 */
export interface ProtectedResourceConfig {
  /** Canonical resource identifier — the MCP server URL (RFC 8707 audience). */
  resource: string;
  /** Issuer URL(s) of the authorization server(s) that mint tokens for it. */
  authorizationServers: string[];
  /** Scopes the resource understands — advertised, not enforced here. */
  scopesSupported?: string[];
}

/** Well-known prefix for the protected-resource metadata document (RFC 9728). */
export const PROTECTED_RESOURCE_PATH = '/.well-known/oauth-protected-resource';

/**
 * Path the metadata is served at — RFC 9728 §3.1 inserts the well-known segment
 * BETWEEN the host and the resource's path: `https://h/mcp` →
 * `/.well-known/oauth-protected-resource/mcp`; a path-less resource stays at the
 * bare well-known path. Used for both the document URL and the route it mounts.
 */
function metadataPath(resource: string): string {
  const { pathname } = new URL(resource);
  return pathname === '/' ? PROTECTED_RESOURCE_PATH : `${PROTECTED_RESOURCE_PATH}${pathname}`;
}

/** Absolute URL of the protected-resource metadata for a given resource. */
export function protectedResourceMetadataUrl(resource: string): string {
  return `${new URL(resource).origin}${metadataPath(resource)}`;
}

/** The `WWW-Authenticate` header value a protected `401` must carry (RFC 9728 §5.1). */
export function wwwAuthenticateHeader(resource: string): string {
  return `Bearer resource_metadata="${protectedResourceMetadataUrl(resource)}"`;
}

/** Public discovery docs are credential-free metadata — open CORS, no Vary. */
const PUBLIC_CORS: Record<string, string> = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, OPTIONS',
  'Access-Control-Allow-Headers': 'Authorization, Content-Type',
};

/**
 * A `RawRoute` serving the RFC 9728 protected-resource metadata at the path
 * advertised by `protectedResourceMetadataUrl(config.resource)`. Mount it
 * alongside the MCP handler; set the matching `protectedResource` on
 * `createMcpHandler` so the `401` points here.
 */
export function oauthProtectedResourceRoute(config: ProtectedResourceConfig): RawRoute {
  const body = JSON.stringify({
    resource: config.resource,
    authorization_servers: config.authorizationServers,
    ...(config.scopesSupported && { scopes_supported: config.scopesSupported }),
    bearer_methods_supported: ['header'],
  });

  return {
    method: 'ALL',
    path: metadataPath(config.resource),
    handler: (req) => {
      if (req.method === 'OPTIONS')
        return new Response(null, { status: 204, headers: PUBLIC_CORS });
      if (req.method !== 'GET') return new Response('Method Not Allowed', { status: 405 });
      return new Response(body, {
        status: 200,
        headers: { 'Content-Type': 'application/json', ...PUBLIC_CORS },
      });
    },
  };
}
