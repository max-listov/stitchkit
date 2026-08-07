import { afterAll, describe, expect, test } from 'bun:test';
import { z } from 'zod';
import { contractEndpointMatchers, createHttpClient } from '../src';
import { defineContract } from '../src/contract';

const EmptySchema = z.object({});

const auth = defineContract(
  { prefix: 'auth' },
  {
    complete: {
      method: 'POST',
      path: '/complete/:token',
      desc: 'Complete auth',
      params: z.object({ token: z.string() }),
      output: EmptySchema,
    },
    verify: {
      method: 'GET',
      path: '/verify',
      desc: 'Verify auth',
      output: EmptySchema,
    },
    protected: {
      method: 'GET',
      path: '/protected',
      desc: 'Protected auth data',
      output: EmptySchema,
    },
    toolOnly: {
      method: 'GET',
      path: '/tool',
      desc: 'Tool only',
      expose: ['MCP'],
      output: EmptySchema,
    },
  },
);

const callback = defineContract(
  { prefix: 'callbacks' },
  {
    receive: {
      method: 'POST',
      path: '/:provider/*filePath',
      desc: 'Receive callback',
      params: z.object({ provider: z.string(), filePath: z.string() }),
      output: EmptySchema,
    },
  },
);

const server = Bun.serve({
  port: 0,
  fetch: () =>
    Response.json(
      { error: { code: 'UNAUTHORIZED', message: 'Expected failure' } },
      { status: 401 },
    ),
});
const baseUrl = `http://localhost:${server.port}`;

afterAll(() => server.stop(true));

describe('contractEndpointMatchers', () => {
  test('suppresses only the selected expected 401 operation', async () => {
    const client = createHttpClient({
      baseUrl,
      retry: { limit: 0 },
      suppressUnauthorizedFor: contractEndpointMatchers(auth, ['complete']),
    });
    const events: string[] = [];
    client.subscribe((event) => events.push(event.type));

    await expect(client.post('/auth/complete/token-one')).rejects.toMatchObject({
      code: 'UNAUTHORIZED',
    });
    expect(events).toEqual([]);

    await expect(client.get('/auth/protected')).rejects.toMatchObject({
      code: 'UNAUTHORIZED',
    });
    expect(events).toEqual(['unauthorized']);
  });

  test('tracks contract prefix, params, dynamic scope and wildcard exactly', () => {
    const [matches] = contractEndpointMatchers(callback, ['receive'], {
      stripPrefixKeys: ['tenantId'],
      pathPrefix: ({ tenantId }) => `tenants/${tenantId}`,
    });
    expect(matches?.('/tenants/t%20one/callbacks/github/a/b')).toBe(true);
    expect(matches?.('/tenants/t%20one/callbacks/git%2Fhub/a')).toBe(true);
    expect(matches?.('/tenants/t-one/callbacks/github')).toBe(true);
    expect(matches?.('/tenants/t-one/callbacks')).toBe(false);
    expect(matches?.('/tenants/t-one/callbacks/githubish')).toBe(true);
    expect(matches?.('/other/t-one/callbacks/github/a')).toBe(false);
  });

  test('supports whole-contract selection without broad prefix matching', () => {
    const matchers = contractEndpointMatchers(auth);
    expect(matchers.some((matches) => matches('/auth/verify'))).toBe(true);
    expect(matchers.some((matches) => matches('/auth/verify-neighbour'))).toBe(false);
  });

  test('fails first on non-HTTP selections and underspecified dynamic prefixes', () => {
    expect(() => contractEndpointMatchers(auth, ['toolOnly'])).toThrow('non-HTTP endpoint');
    expect(() =>
      contractEndpointMatchers(auth, ['complete'], {
        pathPrefix: () => 'tenants/dynamic',
      }),
    ).toThrow('require stripPrefixKeys');
  });

  test('logout and reset semantics remain unchanged', async () => {
    const client = createHttpClient({ baseUrl, retry: { limit: 0 } });
    const events: string[] = [];
    client.subscribe((event) => events.push(event.type));
    client.logout();
    await expect(client.get('/auth/protected')).rejects.toBeDefined();
    client.resetLogoutState();
    await expect(client.get('/auth/protected')).rejects.toBeDefined();
    expect(events).toEqual(['logout', 'unauthorized']);
  });
});
