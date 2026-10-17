import { describe, expect, test } from 'bun:test';
import { z } from 'zod';
import { mountOAuthProvider, type OAuthProviderConfig } from '../src/server/oauth/provider';
import { parseBody } from '../src/server/raw';
import type { RawRoute } from '../src/server/types';

const ISSUER = 'https://api.example.com';
const REDIRECT = 'https://claude.ai/callback';
const Schema = z.object({ name: z.string() });

/** A body of `bytes` bytes that counts how many of them were pulled from the wire. */
function counted(bytes: number, chunk = 1024) {
  const state = { pulled: 0, cancelled: false };
  const body = new ReadableStream<Uint8Array>({
    pull(controller) {
      if (state.pulled >= bytes) return controller.close();
      const size = Math.min(chunk, bytes - state.pulled);
      state.pulled += size;
      controller.enqueue(new Uint8Array(size).fill(0x61));
    },
    cancel() {
      state.cancelled = true;
    },
  });
  return { body, state };
}
const post = (url: string, body: BodyInit, type: string) =>
  new Request(url, {
    method: 'POST',
    headers: { 'content-type': type },
    body,
    // @ts-expect-error — a streamed upload needs half duplex outside the browser typings
    duplex: 'half',
  });

describe('parseBody reads no further than its limit', () => {
  test('a body within the limit is parsed', async () => {
    const request = post('http://x/', JSON.stringify({ name: 'a' }), 'application/json');
    expect(await parseBody(request, Schema)).toEqual({ name: 'a' });
  });

  test('a body over the limit is null, the read stops near the limit and the source is cancelled', async () => {
    const { body, state } = counted(10 * 1024 * 1024);
    const request = post('http://x/', body, 'application/json');
    expect(await parseBody(request, Schema, { maxBytes: 4096 })).toBeNull();
    expect(state.cancelled).toBe(true);
    expect(state.pulled).toBeLessThan(4096 + 64 * 1024);
  });

  test('a body of exactly the limit is read, one byte more is not', async () => {
    const exact = JSON.stringify({ name: 'x'.repeat(64 - 11) });
    expect(exact.length).toBe(64);
    expect(
      await parseBody(post('http://x/', exact, 'application/json'), Schema, { maxBytes: 64 }),
    ).toEqual({
      name: 'x'.repeat(53),
    });
    expect(
      await parseBody(post('http://x/', `${exact} `, 'application/json'), Schema, {
        maxBytes: 64,
      }),
    ).toBeNull();
  });

  test('a limit that is not a positive integer is refused, never silently unbounded', async () => {
    const request = post('http://x/', '{"name":"a"}', 'application/json');
    for (const maxBytes of [Number.NaN, Number.POSITIVE_INFINITY, 0, -1]) {
      await expect(parseBody(request, Schema, { maxBytes })).rejects.toThrow(
        /positive safe integer/,
      );
    }
  });

  test('malformed JSON, a schema mismatch and an aborted request stay null', async () => {
    expect(await parseBody(post('http://x/', '{', 'application/json'), Schema)).toBeNull();
    expect(
      await parseBody(post('http://x/', '{"n":1}', 'application/json'), Schema),
    ).toBeNull();
    const controller = new AbortController();
    controller.abort();
    const aborted = new Request('http://x/', {
      method: 'POST',
      body: '{"name":"a"}',
      signal: controller.signal,
    });
    expect(await parseBody(aborted, Schema)).toBeNull();
  });
});

describe('the authorization server reads no more than 64 KiB of a request', () => {
  const routes: Record<string, RawRoute> = {};
  const config: OAuthProviderConfig = {
    issuer: ISSUER,
    signingSecret: 'test-secret-please-change',
    resource: `${ISSUER}/mcp`,
    scopesSupported: ['mcp'],
    clientRegistration: {
      cimd: false,
      dcr: {
        register: async (meta) => ({
          clientId: 'client-1',
          redirectUris: meta.redirectUris,
          clientName: meta.clientName,
          applicationType: meta.applicationType,
        }),
        get: async () => null,
      },
    },
    codes: { save: async () => undefined, take: async () => null },
    refreshTokens: { save: async () => undefined, take: async () => null },
    authorizeUser: async () => ({ userId: 'u', approvedScopes: [] }),
  };
  for (const route of mountOAuthProvider(config)) routes[route.path] = route;
  const call = (path: string, request: Request) => {
    const route = routes[path];
    if (!route) throw new Error(`no route ${path}`);
    return Promise.resolve(route.handler(request, { params: {} }));
  };

  test('registration within the limit still works', async () => {
    const response = await call(
      '/oauth/register',
      post(
        `${ISSUER}/oauth/register`,
        JSON.stringify({ redirect_uris: ['https://claude.ai/callback'], client_name: 'C' }),
        'application/json',
      ),
    );
    expect(response.status).toBe(201);
  });

  for (const [path, type] of [
    ['/oauth/register', 'application/json'],
    ['/oauth/token', 'application/json'],
    ['/oauth/token', 'application/x-www-form-urlencoded'],
  ] as const) {
    test(`${path} (${type}) over the limit answers 413 without reading the rest`, async () => {
      const { body, state } = counted(50 * 1024 * 1024);
      const response = await call(path, post(`${ISSUER}${path}`, body, type));
      expect(response.status).toBe(413);
      expect(await response.json()).toMatchObject({ error: 'invalid_request' });
      expect(state.cancelled).toBe(true);
      expect(state.pulled).toBeLessThan(64 * 1024 + 64 * 1024);
    });
  }

  test('a token request within the limit reaches the grant checks', async () => {
    const response = await call(
      '/oauth/token',
      post(`${ISSUER}/oauth/token`, 'grant_type=nope', 'application/x-www-form-urlencoded'),
    );
    expect(response.status).toBe(400);
    expect(await response.json()).toMatchObject({ error: 'unsupported_grant_type' });
  });
});

describe('the authorization server limit is configurable', () => {
  const routesWith = (maxRequestBodyBytes: number | undefined) => {
    const routes: Record<string, RawRoute> = {};
    const config: OAuthProviderConfig = {
      issuer: ISSUER,
      signingSecret: 'test-secret-please-change',
      resource: `${ISSUER}/mcp`,
      scopesSupported: ['mcp'],
      ...(maxRequestBodyBytes !== undefined && { maxRequestBodyBytes }),
      clientRegistration: {
        cimd: false,
        dcr: {
          register: async (meta) => ({
            clientId: 'client-1',
            redirectUris: meta.redirectUris,
            clientName: meta.clientName,
            applicationType: meta.applicationType,
          }),
          get: async () => null,
        },
      },
      codes: { save: async () => undefined, take: async () => null },
      refreshTokens: { save: async () => undefined, take: async () => null },
      authorizeUser: async () => ({ userId: 'u', approvedScopes: [] }),
    };
    for (const route of mountOAuthProvider(config)) routes[route.path] = route;
    return routes;
  };
  const register = (routes: Record<string, RawRoute>, bytes: number) => {
    const route = routes['/oauth/register'];
    if (!route) throw new Error('no register route');
    const name = 'n'.repeat(bytes);
    return Promise.resolve(
      route.handler(
        post(
          `${ISSUER}/oauth/register`,
          JSON.stringify({ redirect_uris: [REDIRECT], client_name: name }),
          'application/json',
        ),
        { params: {} },
      ),
    );
  };

  test('a larger limit admits what the default refuses, a smaller one refuses what it admits', async () => {
    expect((await register(routesWith(undefined), 70 * 1024)).status).toBe(413);
    expect((await register(routesWith(256 * 1024), 70 * 1024)).status).toBe(201);
    expect((await register(routesWith(undefined), 200)).status).toBe(201);
    expect((await register(routesWith(128), 200)).status).toBe(413);
  });

  test('a limit that is not a positive integer is refused when the provider is mounted', () => {
    for (const value of [0, -1, 1.5, Number.NaN]) {
      expect(() => routesWith(value)).toThrow(/maxRequestBodyBytes/);
    }
  });
});
