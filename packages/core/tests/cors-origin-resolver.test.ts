/**
 * CORS decided per request origin, credentials included.
 *
 * An application that hands short bearer tokens to other sites' pages needs to
 * allow those origins without cookies while its own pages keep them — and it
 * knows which origins are which only by looking them up when the request comes.
 * One answer per request, reached once, read by every exit: preflight, the
 * `onRequest` short-circuit, raw routes, each kind of endpoint response and
 * every error.
 */
import { describe, expect, test } from 'bun:test';
import { z } from 'zod';
import { defineContract } from '../src/entrypoints/contract';
import {
  type CorsOriginDecision,
  type CorsOriginPolicy,
  createHandler,
  implement,
} from '../src/entrypoints/server';

const OWN = 'https://voice.example.com';
const PARTNER = 'https://partner.example.org';
const STRANGER = 'https://stranger.example.net';

const notes = defineContract(
  { prefix: 'notes', scope: 'public' },
  {
    list: {
      method: 'GET',
      path: '/list',
      desc: 'Data response',
      output: z.object({ notes: z.array(z.string()) }),
    },
    download: {
      method: 'GET',
      path: '/download',
      desc: 'Raw response',
      rawResponse: true,
      contentType: 'text/plain',
    },
    observe: {
      method: 'GET',
      path: '/observe',
      desc: 'Stream response',
      stream: { item: z.object({ n: z.number() }).strict(), format: 'sse' },
    },
    fail: {
      method: 'GET',
      path: '/fail',
      desc: 'Error envelope',
      output: z.object({}),
    },
    track: {
      method: 'POST',
      path: '/track',
      desc: 'Safelisted text body',
      input: z.object({ page: z.string() }),
      output: z.object({ ok: z.boolean() }),
      safelistedBody: true,
    },
  },
);

/** The application's own lookup: its pages with cookies, a partner without, nobody else. */
function lookup(origin: string): CorsOriginDecision {
  if (origin === OWN) return { credentials: true };
  if (origin === PARTNER) return { credentials: false };
  return false;
}

function handlerWith(cors: CorsOriginPolicy, onError?: (error: unknown) => void) {
  const calls = { endpoint: 0, resolver: 0 };
  const policy: CorsOriginPolicy = {
    ...cors,
    origin: (origin) => {
      calls.resolver += 1;
      return cors.origin(origin);
    },
  };
  const handler = createHandler({
    cors: policy,
    services: [
      implement(notes, {
        list: () => {
          calls.endpoint += 1;
          return { notes: ['a'] };
        },
        download: () => {
          calls.endpoint += 1;
          return new Response('bytes', { headers: { Vary: 'Accept-Encoding' } });
        },
        observe: async function* () {
          calls.endpoint += 1;
          yield { n: 1 };
        },
        fail: () => {
          calls.endpoint += 1;
          throw new Error('handler failed');
        },
        track: ({ input }) => {
          calls.endpoint += 1;
          return { ok: input.page.length > 0 };
        },
      }),
    ],
    rawRoutes: [
      {
        method: 'GET',
        path: '/raw',
        handler: () => {
          calls.endpoint += 1;
          return new Response('raw');
        },
      },
    ],
    hooks: {
      onRequest: (req) =>
        new URL(req.url).pathname === '/wall'
          ? new Response('wall', { status: 401 })
          : undefined,
      ...(onError && {
        onError: (error: unknown) => {
          onError(error);
        },
      }),
    },
  });
  return { handler, calls };
}

function request(path: string, origin: string | null, init: RequestInit = {}): Request {
  const headers = new Headers(init.headers);
  if (origin !== null) headers.set('origin', origin);
  return new Request(`http://localhost${path}`, { ...init, headers });
}

function preflight(path: string, origin: string | null): Request {
  return request(path, origin, {
    method: 'OPTIONS',
    headers: {
      'access-control-request-method': 'GET',
      'access-control-request-headers': 'authorization',
    },
  });
}

function allowance(res: Response) {
  return {
    origin: res.headers.get('access-control-allow-origin'),
    credentials: res.headers.get('access-control-allow-credentials'),
    vary: res.headers.get('vary'),
  };
}

const granted = (origin: string, credentials: boolean) => ({
  origin,
  credentials: credentials ? 'true' : null,
});

describe('three origins, three answers', () => {
  test('own origin with credentials, partner without, stranger nothing — on preflight and the request after it', async () => {
    const { handler, calls } = handlerWith({ origin: lookup });
    for (const [origin, expected] of [
      [OWN, granted(OWN, true)],
      [PARTNER, granted(PARTNER, false)],
      [STRANGER, { origin: null, credentials: null }],
    ] as const) {
      const before = calls.resolver;
      const options = await handler(preflight('/notes/list', origin));
      expect(options.status).toBe(204);
      expect(allowance(options)).toMatchObject(expected);
      expect(options.headers.get('access-control-allow-headers')).toContain('Authorization');
      const get = await handler(request('/notes/list', origin));
      expect(get.status).toBe(200);
      expect(allowance(get)).toMatchObject(expected);
      // Once per request, not once per header or per exit.
      expect(calls.resolver - before).toBe(2);
    }
  });

  test('every exit carries the same answer', async () => {
    const { handler } = handlerWith({ origin: lookup });
    const aborted = new AbortController();
    aborted.abort();
    const exits: [string, Request][] = [
      ['onRequest', request('/wall', PARTNER)],
      ['raw route', request('/raw', PARTNER)],
      ['raw endpoint', request('/notes/download', PARTNER)],
      ['stream endpoint', request('/notes/observe', PARTNER)],
      ['data endpoint', request('/notes/list', PARTNER)],
      ['error envelope', request('/notes/fail', PARTNER)],
      ['unknown operation', request('/notes/missing', PARTNER)],
      ['method not allowed', request('/notes/list', PARTNER, { method: 'DELETE' })],
      ['client closed', request('/notes/list', PARTNER, { signal: aborted.signal })],
    ];
    for (const [name, req] of exits) {
      const res = await handler(req);
      expect({ name, ...allowance(res) }).toMatchObject({ name, ...granted(PARTNER, false) });
      await res.body?.cancel();
    }
    const denied = await handler(request('/notes/fail', STRANGER));
    expect(allowance(denied)).toMatchObject({ origin: null, credentials: null });
  });

  test('Vary: Origin is on every answer, granted or not, and never twice', async () => {
    const { handler } = handlerWith({ origin: lookup });
    for (const origin of [OWN, PARTNER, STRANGER, null]) {
      const res = await handler(request('/notes/list', origin));
      expect(res.headers.get('vary')).toBe('Origin');
      const options = await handler(preflight('/notes/list', origin));
      expect(options.headers.get('vary')).toBe('Origin');
    }
    const raw = await handler(request('/notes/download', PARTNER));
    expect(raw.headers.get('vary')).toBe('Accept-Encoding, Origin');
  });
});

describe('a policy that cannot answer grants nothing', () => {
  for (const [name, origin] of [
    [
      'throws',
      () => {
        throw new Error('the key store is down');
      },
    ],
    ['rejects', () => Promise.reject(new Error('the key store is down'))],
    [
      'throws undefined',
      () => {
        throw undefined;
      },
    ],
    ['rejects without a reason', () => Promise.reject()],
    ['answers true', () => true as unknown as CorsOriginDecision],
    ['answers an empty object', () => ({}) as unknown as CorsOriginDecision],
    ['answers an origin', () => '*' as unknown as CorsOriginDecision],
  ] as const) {
    test(`a resolver that ${name} opens nothing and runs nothing`, async () => {
      const errors: unknown[] = [];
      const { handler, calls } = handlerWith({ origin }, (error) => errors.push(error));
      for (const req of [preflight('/notes/list', OWN), request('/notes/list', OWN)]) {
        const res = await handler(req);
        expect(res.status).toBe(500);
        expect(allowance(res)).toEqual({ origin: null, credentials: null, vary: 'Origin' });
        expect(await res.text()).not.toContain('key store');
      }
      expect(calls.endpoint).toBe(0);
      expect(errors).toHaveLength(2);
    });
  }

  test('the resolver is never asked about a missing, null or malformed Origin', async () => {
    const { handler, calls } = handlerWith({ origin: () => ({ credentials: true }) });
    for (const origin of [null, 'null', 'https://voice.example.com/path', 'not an origin']) {
      const res = await handler(request('/notes/list', origin));
      expect(allowance(res)).toMatchObject({ origin: null, credentials: null });
    }
    expect(calls.resolver).toBe(0);
  });
});

describe('a text/plain body needs an origin trusted with credentials', () => {
  test('own origin is read; partner and stranger are refused before the body', async () => {
    const { handler, calls } = handlerWith({ origin: lookup });
    const send = (origin: string) =>
      handler(
        request('/notes/track', origin, {
          method: 'POST',
          headers: { 'content-type': 'text/plain;charset=UTF-8' },
          body: JSON.stringify({ page: '/' }),
        }),
      );
    expect((await send(OWN)).status).toBe(200);
    expect(calls.endpoint).toBe(1);
    for (const origin of [PARTNER, STRANGER]) {
      const res = await send(origin);
      expect(res.status).toBe(403);
    }
    expect(calls.endpoint).toBe(1);
  });
});

describe('construction', () => {
  test('a resolver beside a credentials flag is refused; static mistakes keep their errors', () => {
    const services = [] as never[];
    expect(() =>
      createHandler({
        services,
        cors: { origin: lookup, credentials: true } as unknown as CorsOriginPolicy,
      }),
    ).toThrow('decides credentials per origin');
    expect(() => createHandler({ services, cors: { origin: [] } })).toThrow('empty list');
    expect(() =>
      createHandler({ services, cors: { origin: '*', credentials: true } }),
    ).toThrow('wildcard origin');
    expect(() => createHandler({ services, cors: {} })).toThrow('`origin` is required');
  });
});

describe('the shared fields of a policy shape its answers', () => {
  test('methods, headers and exposeHeaders reach a granted answer', async () => {
    const { handler } = handlerWith({
      origin: lookup,
      methods: 'GET, POST',
      headers: 'Authorization, X-Key',
      exposeHeaders: ['X-Request-Id'],
    });
    const res = await handler(preflight('/notes/list', PARTNER));
    expect(res.headers.get('access-control-allow-methods')).toBe('GET, POST');
    expect(res.headers.get('access-control-allow-headers')).toBe('Authorization, X-Key');
    expect(res.headers.get('access-control-expose-headers')).toBe('X-Request-Id');
    const none = await handlerWith({ origin: lookup, exposeHeaders: [] }).handler(
      request('/notes/list', PARTNER),
    );
    expect(none.headers.has('access-control-expose-headers')).toBeFalse();
  });
});
