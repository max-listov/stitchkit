/**
 * OAuth 2.1 toolkit for MCP — the discovery docs, the JWT/PKCE primitives, and
 * the full authorization-code flow (DCR → authorize → token) with its negative
 * paths. Mirrors what an MCP client (Claude) drives against a remote server.
 */
import { describe, expect, test } from 'bun:test';
import { signJwt, verifyJwt } from '../src/server/middleware/auth';
import { deriveCodeChallenge, verifyPkce } from '../src/server/middleware/pkce';
import type { RawRoute } from '../src/server/types';
import { createMcpHandler } from '../src/tools/mcp-handler';
import {
  oauthProtectedResourceRoute,
  protectedResourceMetadataUrl,
  wwwAuthenticateHeader,
} from '../src/tools/oauth-metadata';
import {
  type AuthCodeData,
  type CimdClientMetadataFetcher,
  mountOAuthProvider,
  type OAuthProviderConfig,
  type RefreshData,
  type RegisteredClient,
} from '../src/tools/oauth-provider';

const SECRET = 'test-secret-please-change';
const ISSUER = 'https://api.example.com';
const RESOURCE = 'https://api.example.com/mcp';
const REDIRECT = 'https://claude.ai/callback';

// ─── Test helpers — no non-null assertions ──────────────────────────────────

type Routes = Record<string, RawRoute>;

/** Look up a mounted route or fail the test loudly. */
function callRoute(routes: Routes, path: string, req: Request): Promise<Response> {
  const route = routes[path];
  if (!route) throw new Error(`no route mounted at ${path}`);
  return Promise.resolve(route.handler(req, { params: {} }));
}

/** Read a response header or throw — keeps the test free of `!`. */
function header(res: Response, name: string): string {
  const value = res.headers.get(name);
  if (value === null) throw new Error(`missing header ${name}`);
  return value;
}

/** Read a query param from a URL string or throw. */
function param(url: string, name: string): string {
  const value = new URL(url).searchParams.get(name);
  if (value === null) throw new Error(`missing query param ${name}`);
  return value;
}

// ─── Primitives ──────────────────────────────────────────────────────────────

describe('signJwt / verifyJwt round-trip', () => {
  test('signed token verifies with matching audience', async () => {
    const token = await signJwt({ scope: 'read' }, SECRET, {
      issuer: ISSUER,
      audience: RESOURCE,
      subject: 'user-1',
      expiresInSec: 3600,
    });
    const payload = await verifyJwt(token, SECRET, { audience: RESOURCE, issuer: ISSUER });
    expect(payload.sub).toBe('user-1');
    expect(payload.aud).toBe(RESOURCE);
    expect(payload.scope).toBe('read');
  });

  test('wrong audience rejected', async () => {
    const token = await signJwt({}, SECRET, { audience: RESOURCE, subject: 'u' });
    await expect(
      verifyJwt(token, SECRET, { audience: 'https://other/mcp' }),
    ).rejects.toThrow();
  });

  test('tampered secret rejected', async () => {
    const token = await signJwt({}, SECRET, { subject: 'u' });
    await expect(verifyJwt(token, 'wrong-secret')).rejects.toThrow();
  });
});

describe('PKCE S256', () => {
  test('matching verifier passes', async () => {
    const verifier = 'a'.repeat(64);
    const challenge = await deriveCodeChallenge(verifier);
    expect(await verifyPkce(verifier, challenge)).toBe(true);
  });

  test('wrong verifier fails', async () => {
    const challenge = await deriveCodeChallenge('a'.repeat(64));
    expect(await verifyPkce('b'.repeat(64), challenge)).toBe(false);
  });
});

// ─── Discovery ───────────────────────────────────────────────────────────────

describe('protected resource metadata (RFC 9728)', () => {
  test('WWW-Authenticate points at the metadata URL', () => {
    expect(wwwAuthenticateHeader(RESOURCE)).toBe(
      `Bearer resource_metadata="${protectedResourceMetadataUrl(RESOURCE)}"`,
    );
    // RFC 9728 §3.1 — the well-known segment is inserted BEFORE the resource's
    // path, so a `/mcp` resource keeps its `/mcp` suffix (it is not dropped).
    expect(protectedResourceMetadataUrl(RESOURCE)).toBe(
      `${ISSUER}/.well-known/oauth-protected-resource/mcp`,
    );
    // A path-less resource stays at the bare well-known path.
    expect(protectedResourceMetadataUrl(ISSUER)).toBe(
      `${ISSUER}/.well-known/oauth-protected-resource`,
    );
  });

  test('MCP handler 401 carries WWW-Authenticate when protectedResource is set', async () => {
    const handler = createMcpHandler({
      serverInfo: { name: 't', version: '1' },
      auth: () => null,
      services: [],
      security: { allowedHosts: ['api.example.com'] },
      protectedResource: { resource: RESOURCE, authorizationServers: [ISSUER] },
    });
    const res = await handler.fetch(new Request(RESOURCE, { method: 'POST' }));
    expect(res.status).toBe(401);
    expect(res.headers.get('WWW-Authenticate')).toBe(wwwAuthenticateHeader(RESOURCE));
  });

  test('MCP handler 401 omits WWW-Authenticate without protectedResource', async () => {
    const handler = createMcpHandler({
      serverInfo: { name: 't', version: '1' },
      auth: () => null,
      services: [],
      security: { allowedHosts: ['api.example.com'] },
    });
    const res = await handler.fetch(new Request(RESOURCE, { method: 'POST' }));
    expect(res.status).toBe(401);
    expect(res.headers.get('WWW-Authenticate')).toBeNull();
  });

  test('route serves the metadata doc', async () => {
    const route = oauthProtectedResourceRoute({
      resource: RESOURCE,
      authorizationServers: [ISSUER],
      scopesSupported: ['mcp'],
    });
    expect(route.path).toBe('/.well-known/oauth-protected-resource/mcp');
    const res = await route.handler(
      new Request(`${ISSUER}/.well-known/oauth-protected-resource/mcp`),
      { params: {} },
    );
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.resource).toBe(RESOURCE);
    expect(body.authorization_servers).toEqual([ISSUER]);
  });

  test('path-less resource uses the bare protected-resource metadata path', async () => {
    const route = oauthProtectedResourceRoute({
      resource: ISSUER,
      authorizationServers: [ISSUER],
    });
    expect(route.path).toBe('/.well-known/oauth-protected-resource');
    const res = await route.handler(
      new Request(`${ISSUER}/.well-known/oauth-protected-resource`),
      { params: {} },
    );
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.resource).toBe(ISSUER);
  });
});

// ─── Authorization-code flow ─────────────────────────────────────────────────

/** In-memory stores + a consenting user — the domain side of the toolkit. */
function buildProvider(overrides?: Partial<OAuthProviderConfig>): Routes {
  const clientStore = new Map<string, RegisteredClient>();
  const codeStore = new Map<string, AuthCodeData>();
  const refreshStore = new Map<string, RefreshData>();
  let clientSeq = 0;

  const config: OAuthProviderConfig = {
    issuer: ISSUER,
    signingSecret: SECRET,
    resource: RESOURCE,
    scopesSupported: ['mcp'],
    clientRegistration: {
      cimd: false,
      dcr: {
        register: async (meta) => {
          const client: RegisteredClient = {
            clientId: `client-${++clientSeq}`,
            redirectUris: meta.redirectUris,
            clientName: meta.clientName,
            applicationType: meta.applicationType,
          };
          clientStore.set(client.clientId, client);
          return client;
        },
        get: async (id) => clientStore.get(id) ?? null,
      },
    },
    codes: {
      save: async (code, data) => {
        codeStore.set(code, data);
      },
      take: async (code) => {
        const data = codeStore.get(code) ?? null;
        codeStore.delete(code);
        return data;
      },
    },
    refreshTokens: {
      save: async (token, data) => {
        refreshStore.set(token, data);
      },
      take: async (token) => {
        const data = refreshStore.get(token) ?? null;
        refreshStore.delete(token);
        return data;
      },
    },
    authorizeUser: async (_request, authRequest) => ({
      userId: 'user-42',
      approvedScopes: authRequest.scope?.split(' ') ?? [],
    }),
    ...overrides,
  };

  const routes: Routes = {};
  for (const r of mountOAuthProvider(config)) routes[r.path] = r;
  return routes;
}

async function registerClient(routes: Routes): Promise<string> {
  const res = await callRoute(
    routes,
    '/oauth/register',
    new Request(`${ISSUER}/oauth/register`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ redirect_uris: [REDIRECT], client_name: 'Claude' }),
    }),
  );
  expect(res.status).toBe(201);
  return (await res.json()).client_id;
}

/** Drive `/authorize` and return the resulting redirect Response. */
function authorize(routes: Routes, params: Record<string, string>): Promise<Response> {
  const url = new URL(`${ISSUER}/oauth/authorize`);
  url.search = new URLSearchParams(params).toString();
  return callRoute(routes, '/oauth/authorize', new Request(url));
}

/** Drive `/token` with a form body. */
function token(routes: Routes, body: Record<string, string>): Promise<Response> {
  return callRoute(
    routes,
    '/oauth/token',
    new Request(`${ISSUER}/oauth/token`, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams(body).toString(),
    }),
  );
}

describe('authorization-code flow with PKCE', () => {
  test('AS metadata advertises endpoints + S256', async () => {
    const routes = buildProvider();
    const res = await callRoute(
      routes,
      '/.well-known/oauth-authorization-server',
      new Request(`${ISSUER}/.well-known/oauth-authorization-server`),
    );
    const meta = await res.json();
    expect(meta.issuer).toBe(ISSUER);
    expect(meta.authorization_endpoint).toBe(`${ISSUER}/oauth/authorize`);
    expect(meta.token_endpoint).toBe(`${ISSUER}/oauth/token`);
    expect(meta.registration_endpoint).toBe(`${ISSUER}/oauth/register`);
    expect(meta.client_id_metadata_document_supported).toBeUndefined();
    expect(meta.code_challenge_methods_supported).toEqual(['S256']);
  });

  test('full happy path: register → authorize → token → valid JWT', async () => {
    const routes = buildProvider();
    const clientId = await registerClient(routes);

    const verifier = 'v'.repeat(64);
    const challenge = await deriveCodeChallenge(verifier);

    const authRes = await authorize(routes, {
      client_id: clientId,
      redirect_uri: REDIRECT,
      response_type: 'code',
      code_challenge: challenge,
      code_challenge_method: 'S256',
      resource: RESOURCE,
      state: 'xyz',
    });
    expect(authRes.status).toBe(302);
    const loc = header(authRes, 'Location');
    expect(param(loc, 'state')).toBe('xyz');
    const code = param(loc, 'code');

    const tokRes = await token(routes, {
      grant_type: 'authorization_code',
      code,
      code_verifier: verifier,
      redirect_uri: REDIRECT,
      client_id: clientId,
    });
    expect(tokRes.status).toBe(200);
    const tokens = await tokRes.json();
    expect(tokens.token_type).toBe('Bearer');
    expect(tokens.refresh_token).toBeTruthy();

    const payload = await verifyJwt(tokens.access_token, SECRET, { audience: RESOURCE });
    expect(payload.sub).toBe('user-42');

    const refRes = await token(routes, {
      grant_type: 'refresh_token',
      refresh_token: tokens.refresh_token,
      client_id: clientId,
    });
    expect(refRes.status).toBe(200);
    const refreshed = await refRes.json();
    expect(refreshed.refresh_token).toBeTruthy();
    expect(refreshed.refresh_token).not.toBe(tokens.refresh_token);
  });

  test('authorize: unknown redirect_uri rejected (no redirect)', async () => {
    const routes = buildProvider();
    const clientId = await registerClient(routes);
    const res = await authorize(routes, {
      client_id: clientId,
      redirect_uri: 'https://evil.com/cb',
      response_type: 'code',
      code_challenge: 'x',
      resource: RESOURCE,
    });
    expect(res.status).toBe(400);
  });

  test('authorize: unserved resource → invalid_target (RFC 8707)', async () => {
    const routes = buildProvider();
    const clientId = await registerClient(routes);
    const res = await authorize(routes, {
      client_id: clientId,
      redirect_uri: REDIRECT,
      response_type: 'code',
      code_challenge: await deriveCodeChallenge('v'.repeat(64)),
      code_challenge_method: 'S256',
      resource: 'https://other.example.com/mcp',
    });
    expect(res.status).toBe(302);
    expect(param(header(res, 'Location'), 'error')).toBe('invalid_target');
  });

  test('access token aud is bound to the requested resource', async () => {
    const routes = buildProvider();
    const clientId = await registerClient(routes);
    const verifier = 'v'.repeat(64);
    const authRes = await authorize(routes, {
      client_id: clientId,
      redirect_uri: REDIRECT,
      response_type: 'code',
      code_challenge: await deriveCodeChallenge(verifier),
      code_challenge_method: 'S256',
      resource: RESOURCE,
    });
    const code = param(header(authRes, 'Location'), 'code');
    const tokRes = await token(routes, {
      grant_type: 'authorization_code',
      code,
      code_verifier: verifier,
      redirect_uri: REDIRECT,
      client_id: clientId,
    });
    const { access_token } = await tokRes.json();
    const payload = await verifyJwt(access_token, SECRET, { audience: RESOURCE });
    expect(payload.aud).toBe(RESOURCE);
    // client_id claim lets the resource server attribute calls to the OAuth client.
    expect(payload.client_id).toBe(clientId);
  });

  test('authorize: missing PKCE redirects with error', async () => {
    const routes = buildProvider();
    const clientId = await registerClient(routes);
    const res = await authorize(routes, {
      client_id: clientId,
      redirect_uri: REDIRECT,
      response_type: 'code',
      resource: RESOURCE,
    });
    expect(res.status).toBe(302);
    expect(param(header(res, 'Location'), 'error')).toBe('invalid_request');
  });

  test('token: wrong PKCE verifier rejected', async () => {
    const routes = buildProvider();
    const clientId = await registerClient(routes);
    const challenge = await deriveCodeChallenge('v'.repeat(64));
    const authRes = await authorize(routes, {
      client_id: clientId,
      redirect_uri: REDIRECT,
      response_type: 'code',
      code_challenge: challenge,
      code_challenge_method: 'S256',
      resource: RESOURCE,
    });
    const code = param(header(authRes, 'Location'), 'code');
    const tokRes = await token(routes, {
      grant_type: 'authorization_code',
      code,
      code_verifier: 'WRONG'.repeat(13),
      redirect_uri: REDIRECT,
      client_id: clientId,
    });
    expect(tokRes.status).toBe(400);
    expect((await tokRes.json()).error).toBe('invalid_grant');
  });

  test('token: code is single-use', async () => {
    const routes = buildProvider();
    const clientId = await registerClient(routes);
    const verifier = 'v'.repeat(64);
    const challenge = await deriveCodeChallenge(verifier);
    const authRes = await authorize(routes, {
      client_id: clientId,
      redirect_uri: REDIRECT,
      response_type: 'code',
      code_challenge: challenge,
      code_challenge_method: 'S256',
      resource: RESOURCE,
    });
    const code = param(header(authRes, 'Location'), 'code');
    const body = {
      grant_type: 'authorization_code',
      code,
      code_verifier: verifier,
      redirect_uri: REDIRECT,
      client_id: clientId,
    };
    expect((await token(routes, body)).status).toBe(200);
    expect((await token(routes, body)).status).toBe(400); // reused → rejected
  });

  /** Register, authorize and return a fresh `{ code, verifier }` for a client. */
  async function freshCode(
    routes: Routes,
    clientId: string,
  ): Promise<{ code: string; verifier: string }> {
    const verifier = 'v'.repeat(64);
    const authRes = await authorize(routes, {
      client_id: clientId,
      redirect_uri: REDIRECT,
      response_type: 'code',
      code_challenge: await deriveCodeChallenge(verifier),
      code_challenge_method: 'S256',
      resource: RESOURCE,
    });
    return { code: param(header(authRes, 'Location'), 'code'), verifier };
  }

  test('token: a rotated refresh token is single-use (old one rejected)', async () => {
    const routes = buildProvider();
    const clientId = await registerClient(routes);
    const { code, verifier } = await freshCode(routes, clientId);
    const tokens = await (
      await token(routes, {
        grant_type: 'authorization_code',
        code,
        code_verifier: verifier,
        redirect_uri: REDIRECT,
        client_id: clientId,
      })
    ).json();

    const rotated = await (
      await token(routes, {
        grant_type: 'refresh_token',
        refresh_token: tokens.refresh_token,
        client_id: clientId,
      })
    ).json();
    expect(rotated.refresh_token).not.toBe(tokens.refresh_token);

    // The original refresh token must now be dead (rotation is single-use).
    const reuse = await token(routes, {
      grant_type: 'refresh_token',
      refresh_token: tokens.refresh_token,
      client_id: clientId,
    });
    expect(reuse.status).toBe(400);
  });

  test('token: a code redeemed under a different client_id is rejected', async () => {
    const routes = buildProvider();
    const clientA = await registerClient(routes);
    const clientB = await registerClient(routes);
    const { code, verifier } = await freshCode(routes, clientA);
    const res = await token(routes, {
      grant_type: 'authorization_code',
      code,
      code_verifier: verifier,
      redirect_uri: REDIRECT,
      client_id: clientB, // not the client the code was issued to
    });
    expect(res.status).toBe(400);
    expect((await res.json()).error).toBe('invalid_grant');
  });

  test('token: a code redeemed with a different redirect_uri is rejected', async () => {
    const routes = buildProvider();
    const clientId = await registerClient(routes);
    const { code, verifier } = await freshCode(routes, clientId);
    const res = await token(routes, {
      grant_type: 'authorization_code',
      code,
      code_verifier: verifier,
      redirect_uri: 'https://claude.ai/other-callback', // ≠ the authorize redirect_uri
      client_id: clientId,
    });
    expect(res.status).toBe(400);
    expect((await res.json()).error).toBe('invalid_grant');
  });

  test('refresh grant is disabled (and unadvertised) without a refreshTokens store', async () => {
    const routes = buildProvider({ refreshTokens: undefined });

    const meta = await (
      await callRoute(
        routes,
        '/.well-known/oauth-authorization-server',
        new Request(`${ISSUER}/.well-known/oauth-authorization-server`),
      )
    ).json();
    expect(meta.grant_types_supported).toEqual(['authorization_code']);

    const reg = await (
      await callRoute(
        routes,
        '/oauth/register',
        new Request(`${ISSUER}/oauth/register`, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ redirect_uris: [REDIRECT] }),
        }),
      )
    ).json();
    expect(reg.grant_types).toEqual(['authorization_code']);

    const res = await token(routes, {
      grant_type: 'refresh_token',
      refresh_token: 'anything',
      client_id: 'anyone',
    });
    expect(res.status).toBe(400);
    expect((await res.json()).error).toBe('unsupported_grant_type');
  });

  test('DCR: http redirect_uri allowed only on loopback, https always', async () => {
    const routes = buildProvider();
    const register = (uris: string[]): Promise<Response> =>
      callRoute(
        routes,
        '/oauth/register',
        new Request(`${ISSUER}/oauth/register`, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ redirect_uris: uris }),
        }),
      );
    expect((await register(['http://evil.example.com/cb'])).status).toBe(400);
    expect((await register(['http://127.0.0.1:8080/cb'])).status).toBe(201);
    expect((await register(['https://claude.ai/cb'])).status).toBe(201);
  });

  test('authorizeUser may return a Response (login redirect)', async () => {
    const routes = buildProvider({
      authorizeUser: async () =>
        new Response(null, { status: 302, headers: { Location: 'https://app/login' } }),
    });
    const clientId = await registerClient(routes);
    const res = await authorize(routes, {
      client_id: clientId,
      redirect_uri: REDIRECT,
      response_type: 'code',
      code_challenge: await deriveCodeChallenge('v'.repeat(64)),
      code_challenge_method: 'S256',
      resource: RESOURCE,
    });
    expect(res.status).toBe(302);
    expect(header(res, 'Location')).toBe('https://app/login');
  });

  test('consent may narrow requested scopes and the approved snapshot reaches the token', async () => {
    const routes = buildProvider({
      scopesSupported: ['read', 'write'],
      authorizeUser: async () => ({ userId: 'user-42', approvedScopes: ['read'] }),
    });
    const clientId = await registerClient(routes);
    const verifier = 's'.repeat(64);
    const authResponse = await authorize(routes, {
      client_id: clientId,
      redirect_uri: REDIRECT,
      response_type: 'code',
      code_challenge: await deriveCodeChallenge(verifier),
      code_challenge_method: 'S256',
      resource: RESOURCE,
      scope: 'read write',
    });
    const tokenResponse = await token(routes, {
      grant_type: 'authorization_code',
      code: param(header(authResponse, 'Location'), 'code'),
      code_verifier: verifier,
      redirect_uri: REDIRECT,
      client_id: clientId,
    });
    const payload = await verifyJwt((await tokenResponse.json()).access_token, SECRET, {
      audience: RESOURCE,
    });
    expect(payload.scope).toBe('read');
  });

  test('a JavaScript authorizeUser without approvedScopes fails loudly', async () => {
    const routes = buildProvider({
      // @ts-expect-error — simulates an untyped JavaScript consumer on the removed return shape.
      authorizeUser: async () => ({ userId: 'user-42' }),
    });
    const clientId = await registerClient(routes);
    await expect(
      authorize(routes, {
        client_id: clientId,
        redirect_uri: REDIRECT,
        response_type: 'code',
        code_challenge: await deriveCodeChallenge('m'.repeat(64)),
        code_challenge_method: 'S256',
        resource: RESOURCE,
        scope: 'mcp',
      }),
    ).rejects.toThrow(/approvedScopes as an array of strings/);
  });

  test('rejects unsupported requested scopes and consent escalation', async () => {
    const unsupportedRoutes = buildProvider({ scopesSupported: ['read'] });
    const clientId = await registerClient(unsupportedRoutes);
    const base = {
      client_id: clientId,
      redirect_uri: REDIRECT,
      response_type: 'code',
      code_challenge: await deriveCodeChallenge('u'.repeat(64)),
      code_challenge_method: 'S256',
      resource: RESOURCE,
    };
    const unsupported = await authorize(unsupportedRoutes, { ...base, scope: 'write' });
    expect(param(header(unsupported, 'Location'), 'error')).toBe('invalid_scope');

    const escalatedRoutes = buildProvider({
      scopesSupported: ['read', 'write'],
      authorizeUser: async () => ({ userId: 'user-42', approvedScopes: ['admin'] }),
    });
    const escalatedClient = await registerClient(escalatedRoutes);
    await expect(
      authorize(escalatedRoutes, {
        ...base,
        client_id: escalatedClient,
        scope: 'read',
      }),
    ).rejects.toThrow(/subset of requested scopes/);
  });
});

describe('Client ID Metadata Documents', () => {
  const CLIENT_ID = 'https://client.example.com/oauth-metadata.json';
  const CLIENT_REDIRECT = 'https://client.example.com/callback';

  function metadataResponse(
    status: number,
    body: unknown,
    headers: Record<string, string> = { 'content-type': 'application/json' },
  ) {
    return {
      status,
      headers: new Headers(headers),
      body: new TextEncoder().encode(JSON.stringify(body)),
      url: new URL(CLIENT_ID),
    };
  }

  function cimdFetcher(fetch: CimdClientMetadataFetcher['fetch']): CimdClientMetadataFetcher {
    return { fetch };
  }

  test('CIMD is the default discovery mode and DCR is absent', async () => {
    const routes = buildProvider({ clientRegistration: undefined });
    expect(routes['/oauth/register']).toBeUndefined();
    const response = await callRoute(
      routes,
      '/.well-known/oauth-authorization-server',
      new Request(`${ISSUER}/.well-known/oauth-authorization-server`),
    );
    const metadata = await response.json();
    expect(metadata.client_id_metadata_document_supported).toBe(true);
    expect(metadata.registration_endpoint).toBeUndefined();
  });

  test('validated HTTPS metadata drives a complete authorize and token flow', async () => {
    let fetches = 0;
    const routes = buildProvider({
      clientRegistration: {
        cimd: {
          fetcher: cimdFetcher(async (url) => {
            fetches += 1;
            expect(url.toString()).toBe(CLIENT_ID);
            return metadataResponse(200, {
              client_id: CLIENT_ID,
              client_name: 'Example client',
              redirect_uris: [CLIENT_REDIRECT],
              token_endpoint_auth_method: 'none',
              application_type: 'web',
            });
          }),
        },
      },
    });
    const verifier = 'c'.repeat(64);
    const authorization = await authorize(routes, {
      client_id: CLIENT_ID,
      redirect_uri: CLIENT_REDIRECT,
      response_type: 'code',
      code_challenge: await deriveCodeChallenge(verifier),
      code_challenge_method: 'S256',
      resource: RESOURCE,
    });
    expect(authorization.status).toBe(302);
    const code = param(header(authorization, 'Location'), 'code');
    const tokenResponse = await token(routes, {
      grant_type: 'authorization_code',
      code,
      code_verifier: verifier,
      redirect_uri: CLIENT_REDIRECT,
      client_id: CLIENT_ID,
    });
    expect(tokenResponse.status).toBe(200);
    expect(fetches).toBe(1);
  });

  test('cache revalidates with HTTP validators and keeps the exact client identity', async () => {
    const observedHeaders: Record<string, string>[] = [];
    const fetcher = cimdFetcher(async (_url, headers) => {
      observedHeaders.push(headers);
      if (observedHeaders.length === 2) {
        return metadataResponse(304, null, { etag: '"v1"', 'cache-control': 'max-age=60' });
      }
      return metadataResponse(
        200,
        {
          client_id: CLIENT_ID,
          client_name: 'Cached client',
          redirect_uris: [CLIENT_REDIRECT],
          token_endpoint_auth_method: 'none',
        },
        {
          'content-type': 'application/problem+json',
          etag: '"v1"',
          'cache-control': 'max-age=0',
        },
      );
    });
    const routes = buildProvider({ clientRegistration: { cimd: { fetcher } } });
    const request = {
      client_id: CLIENT_ID,
      redirect_uri: CLIENT_REDIRECT,
      response_type: 'code',
      code_challenge: await deriveCodeChallenge('r'.repeat(64)),
      code_challenge_method: 'S256',
      resource: RESOURCE,
    };
    expect((await authorize(routes, request)).status).toBe(302);
    expect((await authorize(routes, request)).status).toBe(302);
    expect(observedHeaders).toHaveLength(2);
    expect(observedHeaders[1]?.['if-none-match']).toBe('"v1"');
  });

  test('freshness header abuse: fetch COUNTS match the header semantics, case by case', async () => {
    const document = {
      client_id: CLIENT_ID,
      client_name: 'Counted client',
      redirect_uris: [CLIENT_REDIRECT],
      token_endpoint_auth_method: 'none',
    };
    const request = {
      client_id: CLIENT_ID,
      redirect_uri: CLIENT_REDIRECT,
      response_type: 'code',
      code_challenge: 'a'.repeat(43),
      code_challenge_method: 'S256',
      resource: RESOURCE,
    };
    const countFetches = async (
      headers: Record<string, string>,
      body: unknown = document,
      status = 200,
    ): Promise<number> => {
      let fetches = 0;
      const routes = buildProvider({
        clientRegistration: {
          cimd: {
            fetcher: cimdFetcher(async () => {
              fetches += 1;
              return metadataResponse(status, body, {
                'content-type': 'application/json',
                ...headers,
              });
            }),
          },
        },
      });
      for (let attempt = 0; attempt < 5; attempt += 1) {
        await authorize(routes, request);
      }
      return fetches;
    };

    // A junk / list / negative Age must cost exactly what NO Age costs.
    const baseline = await countFetches({ 'cache-control': 'max-age=60' });
    expect(await countFetches({ 'cache-control': 'max-age=60', age: 'junk' })).toBe(baseline);
    expect(await countFetches({ 'cache-control': 'max-age=60', age: '10, 20' })).toBe(
      baseline,
    );
    expect(await countFetches({ 'cache-control': 'max-age=60', age: '-1000000' })).toBe(
      baseline,
    );
    // Unparseable freshness = already expired (RFC 9111), never a default TTL.
    expect(await countFetches({ 'cache-control': 'max-age=abc' })).toBe(5);
    expect(await countFetches({ expires: 'not-a-date' })).toBe(5);
    // no-store on a VALID document refetches every time…
    expect(await countFetches({ 'cache-control': 'no-store' })).toBe(5);
    // …while an INVALID document under no-store still lands in the negative
    // cache — failure caching is not governed by the origin's store policy.
    expect(
      await countFetches({ 'cache-control': 'no-store' }, { error: 'not found' }, 404),
    ).toBe(1);
  });

  test('Age list arithmetic: the FIRST proxy value counts, not zero and not the sum', async () => {
    const { responseFreshness } = await import('../src/tools/oauth-provider');
    const base = { 'content-type': 'application/json', 'cache-control': 'max-age=1800' };
    const plain = responseFreshness(new Headers(base), {}, 0);
    const single = responseFreshness(new Headers({ ...base, age: '600' }), {}, 0);
    const list = responseFreshness(new Headers({ ...base, age: '600, 5' }), {}, 0);
    const junk = responseFreshness(new Headers({ ...base, age: 'junk' }), {}, 0);
    expect(plain.freshnessMs).toBe(1_800_000);
    expect(single.freshnessMs).toBe(1_200_000);
    // The list form must cost the same staleness as its first value — the old
    // parser read it as "no Age" and granted an extra 10 minutes of freshness.
    expect(list.freshnessMs).toBe(1_200_000);
    expect(junk.freshnessMs).toBe(1_800_000);
  });

  test('a flood of alien client_ids does not evict or re-fetch a warmed client', async () => {
    const fetchesByUrl = new Map<string, number>();
    const fetcher = cimdFetcher(async (url) => {
      const key = url.toString();
      fetchesByUrl.set(key, (fetchesByUrl.get(key) ?? 0) + 1);
      if (key !== CLIENT_ID) return metadataResponse(404, { error: 'not found' });
      return metadataResponse(200, {
        client_id: CLIENT_ID,
        client_name: 'Warm client',
        redirect_uris: [CLIENT_REDIRECT],
        token_endpoint_auth_method: 'none',
      });
    });
    const routes = buildProvider({
      clientRegistration: { cimd: { fetcher, cache: { maxEntries: 4 } } },
    });
    const request = (clientId: string) => ({
      client_id: clientId,
      redirect_uri: CLIENT_REDIRECT,
      response_type: 'code',
      code_challenge: 'a'.repeat(43),
      code_challenge_method: 'S256',
      resource: RESOURCE,
    });
    // Warm the victim, then flood with 20 unresolvable aliens — negative
    // entries live in their own pool and must not push the victim out.
    expect((await authorize(routes, request(CLIENT_ID))).status).toBe(302);
    for (let index = 0; index < 20; index += 1) {
      await authorize(routes, request(`https://alien-${index}.example.com/meta.json`));
    }
    expect((await authorize(routes, request(CLIENT_ID))).status).toBe(302);
    expect(fetchesByUrl.get(CLIENT_ID)).toBe(1);
  });

  test('one client exhausting its per-client budget does not lock out a fresh client', async () => {
    const greedyId = 'https://greedy.example.com/meta.json';
    const freshId = 'https://fresh.example.com/meta.json';
    const fetcher = cimdFetcher(async (url) => {
      const clientId = url.toString();
      return metadataResponse(
        200,
        {
          client_id: clientId,
          client_name: 'Client',
          redirect_uris: [CLIENT_REDIRECT],
          token_endpoint_auth_method: 'none',
        },
        // `no-store` — every authorize costs a fresh resolution.
        { 'content-type': 'application/json', 'cache-control': 'no-store' },
      );
    });
    const routes = buildProvider({
      clientRegistration: {
        cimd: { fetcher, cache: { maxResolutionsPerClient: 2 } },
      },
    });
    const request = (clientId: string) => ({
      client_id: clientId,
      redirect_uri: CLIENT_REDIRECT,
      response_type: 'code',
      code_challenge: 'a'.repeat(43),
      code_challenge_method: 'S256',
      resource: RESOURCE,
    });
    expect((await authorize(routes, request(greedyId))).status).toBe(302);
    expect((await authorize(routes, request(greedyId))).status).toBe(302);
    // The greedy client burnt ITS budget…
    expect((await authorize(routes, request(greedyId))).status).not.toBe(302);
    // …and a brand-new legitimate client still resolves in the same window.
    expect((await authorize(routes, request(freshId))).status).toBe(302);
  });

  test('a burst of successful resolutions does not reset a failing client backoff', async () => {
    const failingId = 'https://failing.example.com/meta.json';
    const fetchesByUrl = new Map<string, number>();
    const fetcher = cimdFetcher(async (url) => {
      const clientId = url.toString();
      fetchesByUrl.set(clientId, (fetchesByUrl.get(clientId) ?? 0) + 1);
      if (clientId === failingId) return metadataResponse(500, { error: 'down' });
      return metadataResponse(200, {
        client_id: clientId,
        client_name: 'Client',
        redirect_uris: [CLIENT_REDIRECT],
        token_endpoint_auth_method: 'none',
      });
    });
    const routes = buildProvider({
      clientRegistration: { cimd: { fetcher, cache: { maxEntries: 2 } } },
    });
    const request = (clientId: string) => ({
      client_id: clientId,
      redirect_uri: CLIENT_REDIRECT,
      response_type: 'code',
      code_challenge: 'a'.repeat(43),
      code_challenge_method: 'S256',
      resource: RESOURCE,
    });
    expect((await authorize(routes, request(failingId))).status).not.toBe(302);
    // Positive entries churn their own pool past maxEntries…
    for (let index = 0; index < 3; index += 1) {
      await authorize(routes, request(`https://ok-${index}.example.com/meta.json`));
    }
    // …while the failing client's negative entry (its backoff) survives: the
    // repeat attempt is answered from the cache, not by a second fetch.
    expect((await authorize(routes, request(failingId))).status).not.toBe(302);
    expect(fetchesByUrl.get(failingId)).toBe(1);
  });

  test('coalesces concurrent cache misses and reports cache outcomes without metadata', async () => {
    let fetches = 0;
    const events: Array<{ status: string; clientId: string }> = [];
    const routes = buildProvider({
      clientRegistration: {
        cimd: {
          fetcher: cimdFetcher(async () => {
            fetches += 1;
            await Promise.resolve();
            return metadataResponse(
              200,
              {
                client_id: CLIENT_ID,
                client_name: 'Concurrent client',
                redirect_uris: [CLIENT_REDIRECT],
                token_endpoint_auth_method: 'none',
              },
              { 'content-type': 'application/json', 'cache-control': 'max-age=60' },
            );
          }),
          onCacheEvent: (event) => events.push(event),
        },
      },
    });
    const request = {
      client_id: CLIENT_ID,
      redirect_uri: CLIENT_REDIRECT,
      response_type: 'code',
      code_challenge: await deriveCodeChallenge('q'.repeat(64)),
      code_challenge_method: 'S256',
      resource: RESOURCE,
    };
    const responses = await Promise.all([
      authorize(routes, request),
      authorize(routes, request),
      authorize(routes, request),
    ]);
    expect(responses.every((response) => response.status === 302)).toBe(true);
    expect(fetches).toBe(1);
    expect(events).toEqual([{ status: 'miss', clientId: CLIENT_ID }]);
    expect(Object.keys(events[0] ?? {}).sort()).toEqual(['clientId', 'status']);
  });

  test('honours no-store and no-cache instead of serving a silently stale identity', async () => {
    for (const directive of ['no-store', 'no-cache']) {
      let fetches = 0;
      const routes = buildProvider({
        clientRegistration: {
          cimd: {
            fetcher: cimdFetcher(async () => {
              fetches += 1;
              return metadataResponse(
                200,
                {
                  client_id: CLIENT_ID,
                  client_name: directive,
                  redirect_uris: [CLIENT_REDIRECT],
                  token_endpoint_auth_method: 'none',
                },
                { 'content-type': 'application/json', 'cache-control': directive },
              );
            }),
          },
        },
      });
      const request = {
        client_id: CLIENT_ID,
        redirect_uri: CLIENT_REDIRECT,
        response_type: 'code',
        code_challenge: await deriveCodeChallenge('n'.repeat(64)),
        code_challenge_method: 'S256',
        resource: RESOURCE,
      };
      expect((await authorize(routes, request)).status).toBe(302);
      expect((await authorize(routes, request)).status).toBe(302);
      expect(fetches).toBe(2);
    }
  });

  test('never falls through an invalid absolute URL client id to DCR', async () => {
    let dcrLookups = 0;
    const routes = buildProvider({
      clientRegistration: {
        cimd: {},
        dcr: {
          register: async () => {
            throw new Error('not used');
          },
          get: async () => {
            dcrLookups += 1;
            return null;
          },
        },
      },
    });
    const response = await authorize(routes, {
      client_id: 'http://client.example.com/metadata.json',
      redirect_uri: CLIENT_REDIRECT,
      response_type: 'code',
      code_challenge: 'challenge',
      code_challenge_method: 'S256',
      resource: RESOURCE,
    });
    expect(response.status).toBe(401);
    expect(dcrLookups).toBe(0);
  });

  test('rejects mismatched identities returned by pre-registration and DCR stores', async () => {
    const mismatched: RegisteredClient = {
      clientId: 'different-client',
      redirectUris: [CLIENT_REDIRECT],
    };
    const configurations: OAuthProviderConfig['clientRegistration'][] = [
      { cimd: false, preRegistered: { get: async () => mismatched } },
      {
        cimd: false,
        dcr: {
          register: async () => mismatched,
          get: async () => mismatched,
        },
      },
    ];
    for (const clientRegistration of configurations) {
      const routes = buildProvider({ clientRegistration });
      const response = await authorize(routes, {
        client_id: 'requested-client',
        redirect_uri: CLIENT_REDIRECT,
        response_type: 'code',
        code_challenge: 'challenge',
        code_challenge_method: 'S256',
        resource: RESOURCE,
      });
      expect(response.status).toBe(401);
    }
  });

  test('pre-registered-only mode advertises neither CIMD nor DCR', async () => {
    const routes = buildProvider({
      clientRegistration: {
        cimd: false,
        preRegistered: { get: async () => null },
      },
    });
    expect(routes['/oauth/register']).toBeUndefined();
    const response = await callRoute(
      routes,
      '/.well-known/oauth-authorization-server',
      new Request(`${ISSUER}/.well-known/oauth-authorization-server`),
    );
    const metadata = await response.json();
    expect(metadata.client_id_metadata_document_supported).toBeUndefined();
    expect(metadata.registration_endpoint).toBeUndefined();
  });

  test('rejects metadata identity mismatch, missing name and redirect mismatch', async () => {
    const documents = [
      {
        client_id: 'https://other.example.com/client.json',
        client_name: 'Wrong identity',
        redirect_uris: [CLIENT_REDIRECT],
        token_endpoint_auth_method: 'none',
      },
      {
        client_id: CLIENT_ID,
        redirect_uris: [CLIENT_REDIRECT],
        token_endpoint_auth_method: 'none',
      },
      {
        client_id: CLIENT_ID,
        client_name: 'Wrong redirect',
        redirect_uris: ['https://client.example.com/other'],
        token_endpoint_auth_method: 'none',
      },
    ];
    for (const document of documents) {
      const routes = buildProvider({
        clientRegistration: {
          cimd: { fetcher: cimdFetcher(async () => metadataResponse(200, document)) },
        },
      });
      const response = await authorize(routes, {
        client_id: CLIENT_ID,
        redirect_uri: CLIENT_REDIRECT,
        response_type: 'code',
        code_challenge: 'challenge',
        code_challenge_method: 'S256',
        resource: RESOURCE,
      });
      expect(response.status).toBe(document === documents[2] ? 400 : 401);
    }
  });
});

// ─── MCP 2026-07-28 authorization hardening ──────────────────────────────────

/** Register with an explicit metadata body (the helper above is the happy path). */
function registerWith(routes: Routes, body: Record<string, unknown>): Promise<Response> {
  return callRoute(
    routes,
    '/oauth/register',
    new Request(`${ISSUER}/oauth/register`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    }),
  );
}

const LOOPBACK = 'http://127.0.0.1:8976/callback';

describe('RFC 9207 — iss on the authorization response (SEP-2468)', () => {
  test('AS metadata advertises iss support', async () => {
    const routes = buildProvider();
    const res = await callRoute(
      routes,
      '/.well-known/oauth-authorization-server',
      new Request(`${ISSUER}/.well-known/oauth-authorization-server`),
    );
    expect((await res.json()).authorization_response_iss_parameter_supported).toBe(true);
  });

  test('the success redirect carries iss', async () => {
    const routes = buildProvider();
    const clientId = await registerClient(routes);
    const challenge = await deriveCodeChallenge('v'.repeat(64));

    const res = await authorize(routes, {
      client_id: clientId,
      redirect_uri: REDIRECT,
      response_type: 'code',
      code_challenge: challenge,
      code_challenge_method: 'S256',
      resource: RESOURCE,
      state: 'xyz',
    });
    const location = new URL(header(res, 'Location') ?? '');
    expect(location.searchParams.get('code')).toBeTruthy();
    expect(location.searchParams.get('iss')).toBe(ISSUER);
    expect(location.searchParams.get('state')).toBe('xyz');
  });

  test('an error redirect carries iss too (mix-up protection covers failures)', async () => {
    const routes = buildProvider();
    const clientId = await registerClient(routes);

    const res = await authorize(routes, {
      client_id: clientId,
      redirect_uri: REDIRECT,
      response_type: 'token', // unsupported → error redirect
      resource: RESOURCE,
    });
    const location = new URL(header(res, 'Location') ?? '');
    expect(location.searchParams.get('error')).toBe('unsupported_response_type');
    expect(location.searchParams.get('iss')).toBe(ISSUER);
  });

  test('the access token is bound to the issuer', async () => {
    const routes = buildProvider();
    const clientId = await registerClient(routes);
    const verifier = 'v'.repeat(64);
    const challenge = await deriveCodeChallenge(verifier);

    const authRes = await authorize(routes, {
      client_id: clientId,
      redirect_uri: REDIRECT,
      response_type: 'code',
      code_challenge: challenge,
      code_challenge_method: 'S256',
      resource: RESOURCE,
    });
    const code = new URL(header(authRes, 'Location') ?? '').searchParams.get('code') ?? '';

    const tokenRes = await token(routes, {
      grant_type: 'authorization_code',
      code,
      code_verifier: verifier,
      redirect_uri: REDIRECT,
      client_id: clientId,
    });
    const { access_token } = await tokenRes.json();
    const claims = await verifyJwt(access_token, SECRET, { audience: RESOURCE });
    expect(claims.iss).toBe(ISSUER);
  });
});

describe('application_type in DCR (SEP-837)', () => {
  test('a native client may register an http loopback redirect', async () => {
    const routes = buildProvider();
    const res = await registerWith(routes, {
      redirect_uris: [LOOPBACK],
      application_type: 'native',
    });
    expect(res.status).toBe(201);
    const body = await res.json();
    expect(body.redirect_uris).toEqual([LOOPBACK]);
    expect(body.application_type).toBe('native');
  });

  test('a web client may not — https only', async () => {
    const routes = buildProvider();
    const res = await registerWith(routes, {
      redirect_uris: [LOOPBACK],
      application_type: 'web',
    });
    expect(res.status).toBe(400);
    expect((await res.json()).error).toBe('invalid_redirect_uri');
  });

  test('redirect URIs with credentials or fragments are rejected', async () => {
    const routes = buildProvider();
    for (const redirectUri of [
      'https://user:pass@client.example.com/callback',
      'https://client.example.com/callback#fragment',
    ]) {
      const response = await registerWith(routes, { redirect_uris: [redirectUri] });
      expect(response.status).toBe(400);
      expect((await response.json()).error).toBe('invalid_redirect_uri');
    }
  });

  test('a web client registers an https redirect fine', async () => {
    const routes = buildProvider();
    const res = await registerWith(routes, {
      redirect_uris: [REDIRECT],
      application_type: 'web',
    });
    expect(res.status).toBe(201);
  });

  test('omitting application_type keeps the previous permissive behaviour', async () => {
    const routes = buildProvider();
    const res = await registerWith(routes, { redirect_uris: [LOOPBACK] });
    expect(res.status).toBe(201);
    expect((await res.json()).application_type).toBeUndefined();
  });

  test('an unknown application_type is rejected, not silently defaulted', async () => {
    const routes = buildProvider();
    const res = await registerWith(routes, {
      redirect_uris: [REDIRECT],
      application_type: 'desktop',
    });
    expect(res.status).toBe(400);
    expect((await res.json()).error).toBe('invalid_client_metadata');
  });
});
