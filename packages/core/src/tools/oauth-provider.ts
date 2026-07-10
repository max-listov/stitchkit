/**
 * OAuth 2.1 authorization-server toolkit for MCP. Returns the `RawRoute`s an MCP
 * server needs to be a connectable remote — metadata discovery (RFC 8414),
 * Dynamic Client Registration (RFC 7591), the `/authorize` and `/token`
 * endpoints with PKCE (RFC 7636) and resource indicators (RFC 8707).
 *
 * The protocol mechanics live here; the domain plugs in through callbacks:
 * persistence (`clients` / `codes` / `refreshTokens`) and the user login/consent
 * step (`authorizeUser`). Access tokens are signed HS256 JWTs whose `aud` binds
 * them to one resource — validate them with `verifyJwt({ audience })`.
 */
import { randomUUID } from 'node:crypto';
import { isRecord } from '../internal/typed';
import { signJwt } from '../server/middleware/auth';
import { DEFAULT_CORS_ALLOW_HEADERS } from '../server/middleware/cors';
import { verifyPkce } from '../server/middleware/pkce';
import type { RawRoute } from '../server/types';

// ─── Domain-supplied stores & callbacks ──────────────────────────────────────

/** A client as registered via DCR. Public clients (PKCE) carry no secret. */
export interface RegisteredClient {
  clientId: string;
  redirectUris: string[];
  clientName?: string;
}

/** Metadata posted to `/register` (RFC 7591) before a client id is assigned. */
export interface ClientMetadata {
  redirectUris: string[];
  clientName?: string;
  tokenEndpointAuthMethod?: string;
}

/** State persisted between `/authorize` and `/token`, keyed by the auth code. */
export interface AuthCodeData {
  clientId: string;
  redirectUri: string;
  codeChallenge: string;
  /** Always `S256` — `/authorize` rejects any other method (OAuth 2.1, public client). */
  codeChallengeMethod: 'S256';
  resource: string;
  scope?: string;
  userId: string;
  expiresAt: number;
}

/** State persisted for a refresh token. */
export interface RefreshData {
  clientId: string;
  resource: string;
  scope?: string;
  userId: string;
}

/** The parsed `/authorize` request handed to the domain login/consent step. */
export interface AuthRequest {
  clientId: string;
  redirectUri: string;
  scope?: string;
  resource: string;
  state?: string;
}

export interface OAuthProviderConfig {
  /** Authorization-server issuer — its own origin, e.g. `https://api.example.com`. */
  issuer: string;
  /** HMAC secret used to sign access-token JWTs. */
  signingSecret: string;
  /** Canonical resource id (MCP URL) — the access-token `aud`. */
  resource: string;
  /** Access-token lifetime in seconds. Default `3600`. */
  accessTokenTtlSec?: number;
  /** Scopes advertised in server metadata. */
  scopesSupported?: string[];
  /** Path prefix for the OAuth endpoints. Default `/oauth`. */
  basePath?: string;

  /** Client registry (DCR). */
  clients: {
    register(metadata: ClientMetadata): Promise<RegisteredClient>;
    get(clientId: string): Promise<RegisteredClient | null>;
  };
  /** Single-use authorization-code store. `take` must atomically read+delete. */
  codes: {
    save(code: string, data: AuthCodeData): Promise<void>;
    take(code: string): Promise<AuthCodeData | null>;
  };
  /** Optional refresh-token store. Omit to disable the refresh grant. */
  refreshTokens?: {
    save(token: string, data: RefreshData): Promise<void>;
    take(token: string): Promise<RefreshData | null>;
  };

  /**
   * Authenticate the user and capture consent for an `/authorize` request.
   * Return `{ userId }` to issue a code, or a `Response` (e.g. a redirect to a
   * login page) to drive the browser through the domain's own login first.
   */
  authorizeUser(
    req: Request,
    authRequest: AuthRequest,
  ): Promise<{ userId: string } | Response>;
}

// ─── Helpers ─────────────────────────────────────────────────────────────────

const PUBLIC_CORS: Record<string, string> = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
  'Access-Control-Allow-Headers': DEFAULT_CORS_ALLOW_HEADERS,
};

const AS_METADATA_PATH = '/.well-known/oauth-authorization-server';
const AUTH_CODE_TTL_MS = 60_000;

function json(body: unknown, status = 200, extraHeaders?: Record<string, string>): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json', ...PUBLIC_CORS, ...extraHeaders },
  });
}

function oauthError(error: string, description: string, status = 400): Response {
  return json({ error, error_description: description }, status);
}

/**
 * True for a registrable redirect URI: any `https`, or `http` ONLY on a loopback
 * host (RFC 8252 §7.3 — native apps). Cleartext `http` to a remote host is
 * refused so a self-registered client cannot receive the authorization code in
 * the clear at an attacker-controlled address.
 */
function isHttpUri(value: string): boolean {
  try {
    const url = new URL(value);
    if (url.protocol === 'https:') return true;
    if (url.protocol !== 'http:') return false;
    const host = url.hostname.replace(/^\[|\]$/g, '');
    return host === '127.0.0.1' || host === '::1' || host === 'localhost';
  } catch {
    return false;
  }
}

/** Append query params to a redirect URI without clobbering its own query. */
function redirectWith(uri: string, params: Record<string, string>): Response {
  const url = new URL(uri);
  for (const [key, value] of Object.entries(params)) url.searchParams.set(key, value);
  return new Response(null, { status: 302, headers: { Location: url.toString() } });
}

async function readForm(req: Request): Promise<URLSearchParams> {
  const contentType = req.headers.get('content-type') ?? '';
  if (contentType.includes('application/json')) {
    const body: unknown = await req.json().catch(() => null);
    const params = new URLSearchParams();
    if (isRecord(body)) {
      // Only string values map cleanly to form params — a nested object would
      // stringify to "[object Object]", so skip non-strings rather than corrupt.
      for (const [key, value] of Object.entries(body)) {
        if (typeof value === 'string') params.set(key, value);
      }
    }
    return params;
  }
  return new URLSearchParams(await req.text());
}

// ─── Routes ──────────────────────────────────────────────────────────────────

/**
 * Build the OAuth 2.1 authorization-server routes for an MCP resource. Mount the
 * returned routes in the server's `rawRoutes`, alongside
 * `oauthProtectedResourceRoute` and an MCP handler whose `protectedResource`
 * names this issuer.
 */
export function mountOAuthProvider(config: OAuthProviderConfig): RawRoute[] {
  const base = config.basePath ?? '/oauth';
  const ttl = config.accessTokenTtlSec ?? 3600;
  const registerPath = `${base}/register`;
  const authorizePath = `${base}/authorize`;
  const tokenPath = `${base}/token`;

  const metadataRoute: RawRoute = {
    method: 'ALL',
    path: AS_METADATA_PATH,
    handler: (req) => {
      if (req.method === 'OPTIONS')
        return new Response(null, { status: 204, headers: PUBLIC_CORS });
      return json({
        issuer: config.issuer,
        authorization_endpoint: `${config.issuer}${authorizePath}`,
        token_endpoint: `${config.issuer}${tokenPath}`,
        registration_endpoint: `${config.issuer}${registerPath}`,
        response_types_supported: ['code'],
        grant_types_supported: config.refreshTokens
          ? ['authorization_code', 'refresh_token']
          : ['authorization_code'],
        code_challenge_methods_supported: ['S256'],
        token_endpoint_auth_methods_supported: ['none'],
        ...(config.scopesSupported && { scopes_supported: config.scopesSupported }),
      });
    },
  };

  const registerRoute: RawRoute = {
    method: 'ALL',
    path: registerPath,
    handler: async (req) => {
      if (req.method === 'OPTIONS')
        return new Response(null, { status: 204, headers: PUBLIC_CORS });
      if (req.method !== 'POST') return oauthError('invalid_request', 'POST required', 405);

      const meta: unknown = await req.json().catch(() => null);
      if (!isRecord(meta)) {
        return oauthError('invalid_client_metadata', 'Body must be a JSON object');
      }
      const redirectUris = meta.redirect_uris;
      if (
        !Array.isArray(redirectUris) ||
        redirectUris.length === 0 ||
        !redirectUris.every((u): u is string => typeof u === 'string' && isHttpUri(u))
      ) {
        return oauthError(
          'invalid_redirect_uri',
          'redirect_uris must be a non-empty array of absolute https URLs (http is allowed only on a loopback host)',
        );
      }

      const client = await config.clients.register({
        redirectUris: redirectUris,
        clientName: typeof meta.client_name === 'string' ? meta.client_name : undefined,
        tokenEndpointAuthMethod:
          typeof meta.token_endpoint_auth_method === 'string'
            ? meta.token_endpoint_auth_method
            : undefined,
      });

      return json(
        {
          client_id: client.clientId,
          redirect_uris: client.redirectUris,
          token_endpoint_auth_method: 'none',
          // Only advertise refresh_token when the grant is actually enabled —
          // mirrors grant_types_supported in the AS metadata above; otherwise a
          // client tries a grant /token rejects as unsupported_grant_type.
          grant_types: config.refreshTokens
            ? ['authorization_code', 'refresh_token']
            : ['authorization_code'],
          response_types: ['code'],
          ...(client.clientName && { client_name: client.clientName }),
        },
        201,
      );
    },
  };

  const authorizeRoute: RawRoute = {
    method: 'ALL',
    path: authorizePath,
    handler: async (req) => {
      if (req.method === 'OPTIONS')
        return new Response(null, { status: 204, headers: PUBLIC_CORS });

      const url = new URL(req.url);
      const p = url.searchParams;
      const clientId = p.get('client_id');
      const redirectUri = p.get('redirect_uri');
      const responseType = p.get('response_type');
      const codeChallenge = p.get('code_challenge');
      const codeChallengeMethod = p.get('code_challenge_method') ?? 'S256';
      const resource = p.get('resource');
      const scope = p.get('scope') ?? undefined;
      const state = p.get('state') ?? undefined;

      if (!clientId || !redirectUri) {
        return oauthError('invalid_request', 'client_id and redirect_uri are required');
      }
      const client = await config.clients.get(clientId);
      if (!client) return oauthError('invalid_client', 'Unknown client_id', 401);
      // Exact redirect_uri match — never redirect to an unregistered URI.
      if (!client.redirectUris.includes(redirectUri)) {
        return oauthError('invalid_request', 'redirect_uri does not match a registered URI');
      }
      // From here errors go back to the client via the redirect (OAuth 2.1 §4.1.2.1).
      if (responseType !== 'code') {
        return redirectWith(redirectUri, {
          error: 'unsupported_response_type',
          ...(state && { state }),
        });
      }
      if (!codeChallenge || codeChallengeMethod !== 'S256') {
        return redirectWith(redirectUri, {
          error: 'invalid_request',
          error_description: 'PKCE S256 code_challenge is required',
          ...(state && { state }),
        });
      }
      if (!resource) {
        return redirectWith(redirectUri, {
          error: 'invalid_target',
          error_description: 'resource parameter is required',
          ...(state && { state }),
        });
      }
      // RFC 8707 — reject a resource this server does not serve rather than
      // silently issuing a token for a different audience.
      if (resource !== config.resource) {
        return redirectWith(redirectUri, {
          error: 'invalid_target',
          error_description: 'resource is not served by this authorization server',
          ...(state && { state }),
        });
      }

      const authRequest: AuthRequest = { clientId, redirectUri, scope, resource, state };
      const result = await config.authorizeUser(req, authRequest);
      if (result instanceof Response) return result;

      const code = randomUUID();
      await config.codes.save(code, {
        clientId,
        redirectUri,
        codeChallenge,
        codeChallengeMethod: 'S256',
        resource,
        scope,
        userId: result.userId,
        expiresAt: Date.now() + AUTH_CODE_TTL_MS,
      });

      return redirectWith(redirectUri, { code, ...(state && { state }) });
    },
  };

  // `audience` is the resource the grant was bound to (validated `=== config.resource`
  // at /authorize) — threading it keeps the token's `aud` driven by the request.
  const issueAccessToken = (
    userId: string,
    audience: string,
    clientId: string,
    scope?: string,
  ): Promise<string> =>
    // `client_id` (RFC 8693 `azp`-style) lets the resource server attribute
    // each call to the OAuth client that the token was issued to.
    signJwt({ scope, client_id: clientId }, config.signingSecret, {
      issuer: config.issuer,
      audience,
      subject: userId,
      expiresInSec: ttl,
    });

  const tokenRoute: RawRoute = {
    method: 'ALL',
    path: tokenPath,
    handler: async (req) => {
      if (req.method === 'OPTIONS')
        return new Response(null, { status: 204, headers: PUBLIC_CORS });
      if (req.method !== 'POST') return oauthError('invalid_request', 'POST required', 405);

      const form = await readForm(req);
      const grantType = form.get('grant_type');

      if (grantType === 'authorization_code') {
        const code = form.get('code');
        const verifier = form.get('code_verifier');
        const redirectUri = form.get('redirect_uri');
        const clientId = form.get('client_id');
        if (!code || !verifier || !redirectUri || !clientId) {
          return oauthError(
            'invalid_request',
            'code, code_verifier, redirect_uri, client_id required',
          );
        }
        const data = await config.codes.take(code);
        if (!data) return oauthError('invalid_grant', 'Unknown or used authorization code');
        if (data.expiresAt < Date.now())
          return oauthError('invalid_grant', 'Authorization code expired');
        if (data.clientId !== clientId)
          return oauthError('invalid_grant', 'client_id mismatch');
        if (data.redirectUri !== redirectUri)
          return oauthError('invalid_grant', 'redirect_uri mismatch');
        if (!(await verifyPkce(verifier, data.codeChallenge))) {
          return oauthError('invalid_grant', 'PKCE verification failed');
        }

        const accessToken = await issueAccessToken(
          data.userId,
          data.resource,
          data.clientId,
          data.scope,
        );
        let refreshToken: string | undefined;
        if (config.refreshTokens) {
          refreshToken = randomUUID();
          await config.refreshTokens.save(refreshToken, {
            clientId: data.clientId,
            resource: data.resource,
            scope: data.scope,
            userId: data.userId,
          });
        }
        return json({
          access_token: accessToken,
          token_type: 'Bearer',
          expires_in: ttl,
          ...(data.scope && { scope: data.scope }),
          ...(refreshToken && { refresh_token: refreshToken }),
        });
      }

      if (grantType === 'refresh_token') {
        if (!config.refreshTokens) {
          return oauthError('unsupported_grant_type', 'refresh_token grant is not enabled');
        }
        const token = form.get('refresh_token');
        const clientId = form.get('client_id');
        if (!token || !clientId)
          return oauthError('invalid_request', 'refresh_token and client_id required');
        // Rotate — a refresh token is single-use (OAuth 2.1 §4.3.1 for public clients).
        const data = await config.refreshTokens.take(token);
        if (!data) return oauthError('invalid_grant', 'Unknown or used refresh token');
        if (data.clientId !== clientId)
          return oauthError('invalid_grant', 'client_id mismatch');

        const accessToken = await issueAccessToken(
          data.userId,
          data.resource,
          data.clientId,
          data.scope,
        );
        const newRefresh = randomUUID();
        await config.refreshTokens.save(newRefresh, data);
        return json({
          access_token: accessToken,
          token_type: 'Bearer',
          expires_in: ttl,
          ...(data.scope && { scope: data.scope }),
          refresh_token: newRefresh,
        });
      }

      return oauthError(
        'unsupported_grant_type',
        `Unsupported grant_type: ${grantType ?? 'none'}`,
      );
    },
  };

  return [metadataRoute, registerRoute, authorizeRoute, tokenRoute];
}
