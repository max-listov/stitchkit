/**
 * The four endpoints of the authorization server, one factory each, over the
 * context `mountOAuthProvider` resolves once: its config, its paths, how a
 * client id is resolved, and how a response goes back to the client.
 */
import { randomUUID } from 'node:crypto';
import { isRecord } from '../../internal/typed';
import { DEFAULT_CORS_ALLOW_HEADERS } from '../middleware/cors';
import { verifyPkce } from '../middleware/pkce';
import type { RawRoute } from '../types';
import {
  absoluteClientUrl,
  isLoopbackRedirectUri,
  isPlainDisplayCharacter,
  isRegistrableRedirectUri,
} from './cimd';
import type {
  ApplicationType,
  AuthRequest,
  OAuthClientRegistrationConfig,
  OAuthProviderConfig,
  RegisteredClient,
} from './provider';

export interface OAuthEndpointContext {
  readonly config: OAuthProviderConfig;
  /** Access-token lifetime in seconds. */
  readonly ttl: number;
  readonly paths: {
    readonly register: string;
    readonly authorize: string;
    readonly token: string;
  };
  readonly dcrRegistry: NonNullable<OAuthClientRegistrationConfig['dcr']> | undefined;
  readonly cimdEnabled: boolean;
  resolveClient(clientId: string): Promise<RegisteredClient | null>;
  redirectToClient(uri: string, params: Record<string, string>): Response;
  issueAccessToken(
    userId: string,
    audience: string,
    clientId: string,
    scope?: string,
  ): Promise<string>;
}

const PUBLIC_CORS: Record<string, string> = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
  'Access-Control-Allow-Headers': DEFAULT_CORS_ALLOW_HEADERS,
};

const AS_METADATA_PATH = '/.well-known/oauth-authorization-server';
const AUTH_CODE_TTL_MS = 60_000;

function safeClientName(value: string | undefined): string | undefined {
  if (value === undefined) return undefined;
  const safe = Array.from(value).filter(isPlainDisplayCharacter).join('').trim().slice(0, 200);
  return safe || undefined;
}

function parseScopes(value: string | undefined): string[] {
  if (!value) return [];
  return [...new Set(value.split(/\s+/u).filter(Boolean))];
}

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
 * True for a registrable redirect URI. `https` is always allowed; `http` ONLY on
 * a loopback host (RFC 8252 §7.3 — native apps), so a self-registered client
 * cannot receive the authorization code in the clear at an attacker-controlled
 * address.
 *
 * `applicationType` is the OpenID Connect DCR hint (SEP-837): a `web` client is
 * held to https-only (loopback is meaningless for it and a common
 * misconfiguration), a `native` client keeps the loopback allowance. Omitted —
 * the permissive default, so a client that never sends the field behaves
 * exactly as before.
 */
export function redirectWith(uri: string, params: Record<string, string>): Response {
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

/** RFC 8414 discovery: what this server supports, and where. */
export function metadataRoute(ctx: OAuthEndpointContext): RawRoute {
  const { config } = ctx;
  return {
    method: 'ALL',
    path: AS_METADATA_PATH,
    handler: (req) => {
      if (req.method === 'OPTIONS')
        return new Response(null, { status: 204, headers: PUBLIC_CORS });
      return json({
        issuer: config.issuer,
        authorization_endpoint: `${config.issuer}${ctx.paths.authorize}`,
        token_endpoint: `${config.issuer}${ctx.paths.token}`,
        ...(ctx.dcrRegistry !== undefined && {
          registration_endpoint: `${config.issuer}${ctx.paths.register}`,
        }),
        response_types_supported: ['code'],
        grant_types_supported: config.refreshTokens
          ? ['authorization_code', 'refresh_token']
          : ['authorization_code'],
        code_challenge_methods_supported: ['S256'],
        token_endpoint_auth_methods_supported: ['none'],
        ...(ctx.cimdEnabled && { client_id_metadata_document_supported: true }),
        // RFC 9207 §3 — tells a client it can (and should) validate `iss` on the
        // authorization response. Without this advertisement a client has no way
        // to know the parameter is authoritative here.
        authorization_response_iss_parameter_supported: true,
        ...(config.scopesSupported && { scopes_supported: config.scopesSupported }),
      });
    },
  };
}

/** RFC 7591 Dynamic Client Registration, for public clients only. */
export function registerRoute(ctx: OAuthEndpointContext): RawRoute {
  const { config } = ctx;
  return {
    method: 'ALL',
    path: ctx.paths.register,
    handler: async (req) => {
      if (req.method === 'OPTIONS')
        return new Response(null, { status: 204, headers: PUBLIC_CORS });
      if (req.method !== 'POST') return oauthError('invalid_request', 'POST required', 405);

      const meta: unknown = await req.json().catch(() => null);
      if (!isRecord(meta)) {
        return oauthError('invalid_client_metadata', 'Body must be a JSON object');
      }
      // SEP-837 — the client declares whether it is a desktop/CLI (`native`) or
      // browser (`web`) app, which decides whether an `http` loopback redirect
      // is registrable. An unknown value is a client mistake, not a default.
      const rawAppType = meta.application_type;
      if (rawAppType !== undefined && rawAppType !== 'native' && rawAppType !== 'web') {
        return oauthError(
          'invalid_client_metadata',
          "application_type must be 'native' or 'web'",
        );
      }
      const applicationType: ApplicationType | undefined = rawAppType;

      const redirectUris = meta.redirect_uris;
      const tokenEndpointAuthMethod = meta.token_endpoint_auth_method ?? 'none';
      if (tokenEndpointAuthMethod !== 'none') {
        return oauthError(
          'invalid_client_metadata',
          'Only public clients with token_endpoint_auth_method "none" are supported',
        );
      }
      if (
        !Array.isArray(redirectUris) ||
        redirectUris.length === 0 ||
        !redirectUris.every(
          (u): u is string =>
            typeof u === 'string' && isRegistrableRedirectUri(u, applicationType),
        )
      ) {
        return oauthError(
          'invalid_redirect_uri',
          applicationType === 'web'
            ? 'redirect_uris must be a non-empty array of absolute https URLs (a web client cannot register an http loopback URI)'
            : 'redirect_uris must be a non-empty array of absolute https URLs (http is allowed only on a loopback host)',
        );
      }

      if (!ctx.dcrRegistry) throw new Error('DCR route mounted without a DCR registry');
      const client = await ctx.dcrRegistry.register({
        redirectUris: redirectUris,
        clientName: typeof meta.client_name === 'string' ? meta.client_name : undefined,
        tokenEndpointAuthMethod,
        ...(applicationType && { applicationType }),
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
          ...(client.applicationType && { application_type: client.applicationType }),
        },
        201,
      );
    },
  };
}

/** `/authorize`: PKCE S256, an exact redirect URI, one resource, then the user's consent. */
export function authorizeRoute(ctx: OAuthEndpointContext): RawRoute {
  const { config } = ctx;
  return {
    method: 'ALL',
    path: ctx.paths.authorize,
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
      const client = await ctx.resolveClient(clientId);
      if (!client) return oauthError('invalid_client', 'Unknown client_id', 401);
      // Exact redirect_uri match — never redirect to an unregistered URI.
      if (!client.redirectUris.includes(redirectUri)) {
        return oauthError('invalid_request', 'redirect_uri does not match a registered URI');
      }
      // From here errors go back to the client via the redirect (OAuth 2.1 §4.1.2.1).
      if (responseType !== 'code') {
        return ctx.redirectToClient(redirectUri, {
          error: 'unsupported_response_type',
          ...(state && { state }),
        });
      }
      if (!codeChallenge || codeChallengeMethod !== 'S256') {
        return ctx.redirectToClient(redirectUri, {
          error: 'invalid_request',
          error_description: 'PKCE S256 code_challenge is required',
          ...(state && { state }),
        });
      }
      if (!resource) {
        return ctx.redirectToClient(redirectUri, {
          error: 'invalid_target',
          error_description: 'resource parameter is required',
          ...(state && { state }),
        });
      }
      // RFC 8707 — reject a resource this server does not serve rather than
      // silently issuing a token for a different audience.
      if (resource !== config.resource) {
        return ctx.redirectToClient(redirectUri, {
          error: 'invalid_target',
          error_description: 'resource is not served by this authorization server',
          ...(state && { state }),
        });
      }

      const requestedScopes = parseScopes(scope);
      const supportedScopes = new Set(config.scopesSupported ?? []);
      if (
        config.scopesSupported &&
        requestedScopes.some((requestedScope) => !supportedScopes.has(requestedScope))
      ) {
        return ctx.redirectToClient(redirectUri, {
          error: 'invalid_scope',
          error_description: 'One or more requested scopes are not supported',
          ...(state && { state }),
        });
      }
      const requestedScope =
        requestedScopes.length > 0 ? requestedScopes.join(' ') : undefined;

      const authRequest: AuthRequest = {
        clientId,
        redirectUri,
        scope: requestedScope,
        resource,
        state,
        isLoopbackRedirect: isLoopbackRedirectUri(redirectUri),
        ...(safeClientName(client.clientName) !== undefined && {
          clientName: safeClientName(client.clientName),
        }),
        ...(client.applicationType !== undefined && {
          applicationType: client.applicationType,
        }),
        ...(absoluteClientUrl(clientId)?.protocol === 'https:' && {
          clientOrigin: new URL(clientId).origin,
        }),
      };
      const result = await config.authorizeUser(req, authRequest);
      if (result instanceof Response) return result;

      if (
        !Array.isArray(result.approvedScopes) ||
        !result.approvedScopes.every((scope) => typeof scope === 'string')
      ) {
        throw new Error('authorizeUser must return approvedScopes as an array of strings');
      }

      const approvedScopes = [...new Set(result.approvedScopes)];
      if (
        approvedScopes.some(
          (approvedScope) =>
            !requestedScopes.includes(approvedScope) ||
            (config.scopesSupported !== undefined && !supportedScopes.has(approvedScope)),
        )
      ) {
        throw new Error('authorizeUser approvedScopes must be a subset of requested scopes');
      }
      const approvedScope = approvedScopes.length > 0 ? approvedScopes.join(' ') : undefined;

      const code = randomUUID();
      await config.codes.save(code, {
        clientId,
        redirectUri,
        codeChallenge,
        codeChallengeMethod: 'S256',
        resource,
        scope: approvedScope,
        userId: result.userId,
        expiresAt: Date.now() + AUTH_CODE_TTL_MS,
      });

      return ctx.redirectToClient(redirectUri, { code, ...(state && { state }) });
    },
  };
}

/** `/token`: the authorization-code and refresh-token grants, both single-use. */
export function tokenRoute(ctx: OAuthEndpointContext): RawRoute {
  const { config } = ctx;
  return {
    method: 'ALL',
    path: ctx.paths.token,
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

        const accessToken = await ctx.issueAccessToken(
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
          expires_in: ctx.ttl,
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

        const accessToken = await ctx.issueAccessToken(
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
          expires_in: ctx.ttl,
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
}
