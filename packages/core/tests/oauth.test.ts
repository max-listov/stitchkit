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
      protectedResource: { resource: RESOURCE, authorizationServers: [ISSUER] },
    });
    const res = await handler(new Request(RESOURCE, { method: 'POST' }));
    expect(res.status).toBe(401);
    expect(res.headers.get('WWW-Authenticate')).toBe(wwwAuthenticateHeader(RESOURCE));
  });

  test('MCP handler 401 omits WWW-Authenticate without protectedResource', async () => {
    const handler = createMcpHandler({
      serverInfo: { name: 't', version: '1' },
      auth: () => null,
      services: [],
    });
    const res = await handler(new Request(RESOURCE, { method: 'POST' }));
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
    clients: {
      register: async (meta) => {
        const client: RegisteredClient = {
          clientId: `client-${++clientSeq}`,
          redirectUris: meta.redirectUris,
          clientName: meta.clientName,
        };
        clientStore.set(client.clientId, client);
        return client;
      },
      get: async (id) => clientStore.get(id) ?? null,
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
    authorizeUser: async () => ({ userId: 'user-42' }),
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
});
