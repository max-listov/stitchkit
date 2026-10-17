import { describe, expect, test } from 'bun:test';
import { z } from 'zod';
import { defineContract } from '../src/entrypoints/contract';
import {
  createHandler,
  createServer,
  defineRequestIngress,
  implement,
  isLoopbackAddress,
} from '../src/entrypoints/server';

interface Caller {
  node: string;
}

const caller = defineRequestIngress<Caller>('caller');
const other = defineRequestIngress<string>('caller');

const contract = defineContract(
  { prefix: 'orders' },
  {
    place: {
      method: 'POST',
      path: '/',
      desc: 'Place an order',
      expose: ['HTTP'],
      input: z.object({ item: z.string() }),
      output: z.object({ node: z.string().nullable() }),
    },
  },
);

function build(
  seen: Record<string, string | undefined>,
  extra: { throwOnRequest?: true } = {},
) {
  return createHandler({
    services: [
      implement(contract, {
        place: (ctx) => ({ node: caller.from(ctx)?.node ?? null }),
      }),
    ],
    hooks: {
      onRequest: () => {
        if (extra.throwOnRequest) throw new Error('refused before routing');
      },
      authorize: (ctx) => {
        seen.authorize = caller.from(ctx)?.node;
      },
      beforeHandle: (ctx) => {
        seen.beforeHandle = caller.from(ctx)?.node;
      },
      onError: (ctx) => {
        seen.onError = caller.from(ctx)?.node;
      },
    },
  });
}

const post = (body: unknown, path = '/orders') =>
  new Request(`http://localhost${path}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });

describe('request ingress', () => {
  test('a value attached by the ingress is visible to authorize, beforeHandle and the handler', async () => {
    const seen: Record<string, string | undefined> = {};
    const request = post({ item: 'tea' });
    caller.attach(request, { node: 'node-7' });
    const response = await build(seen)(request);
    expect(await response.json()).toEqual({ node: 'node-7' });
    expect(seen).toEqual({ authorize: 'node-7', beforeHandle: 'node-7' });
  });

  test('onError reads it after a validation failure, an unknown path and a refused method', async () => {
    const cases: Array<[Request, number]> = [
      [post({ wrong: true }), 400],
      [post({ item: 'tea' }, '/missing'), 404],
      [new Request('http://localhost/orders', { method: 'DELETE' }), 405],
    ];
    for (const [request, status] of cases) {
      const seen: Record<string, string | undefined> = {};
      caller.attach(request, { node: 'node-7' });
      const response = await build(seen)(request);
      expect(response.status).toBe(status);
      expect(seen.onError).toBe('node-7');
    }
  });

  test('onError reads it when onRequest refuses the request', async () => {
    const seen: Record<string, string | undefined> = {};
    const request = post({ item: 'tea' });
    caller.attach(request, { node: 'node-7' });
    const response = await build(seen, { throwOnRequest: true })(request);
    expect(response.status).toBe(500);
    expect(seen.onError).toBe('node-7');
  });

  test('a copy of the request, a header and a request from another ingress carry nothing', async () => {
    const attached = post({ item: 'tea' });
    caller.attach(attached, { node: 'node-7' });
    const copies = [
      attached.clone(),
      new Request(attached.url, {
        method: 'POST',
        headers: attached.headers,
        body: '{"item":"tea"}',
      }),
    ];
    const forged = post({ item: 'tea' });
    forged.headers.set('caller', 'node-7');
    forged.headers.set('x-caller', 'node-7');
    for (const request of [...copies, forged, post({ item: 'tea' })]) {
      const seen: Record<string, string | undefined> = {};
      const response = await build(seen)(request);
      expect(await response.json()).toEqual({ node: null });
      expect(seen.authorize).toBeUndefined();
    }
  });

  test('two keys with the same name never meet, and a second attach is refused', () => {
    const request = post({ item: 'tea' });
    caller.attach(request, { node: 'node-7' });
    expect(other.from({ req: request })).toBeUndefined();
    other.attach(request, 'other');
    expect(caller.from({ req: request })?.node).toBe('node-7');
    expect(() => caller.attach(request, { node: 'node-8' })).toThrow(/already attached/);
    expect(caller.from({})).toBeUndefined();
  });

  test('a value attached in wrapFetch reaches the endpoint behind a trusted proxy origin', async () => {
    const server = createServer({
      hostname: '127.0.0.1',
      port: 0,
      proxyOrigin: { trustedPeer: isLoopbackAddress },
      services: [
        implement(contract, {
          place: (ctx) => ({ node: caller.from(ctx)?.node ?? null }),
        }),
      ],
      wrapFetch: (next) => (req, runtime) => {
        // The proxy origin has already replaced the request: the value belongs to the final one.
        expect(new URL(req.url).origin).toBe('https://tenant.invalid');
        caller.attach(req, { node: 'node-9' });
        return next(req, runtime);
      },
    });
    try {
      const response = await fetch(`http://127.0.0.1:${server.port}/orders`, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          host: 'tenant.invalid',
          'x-forwarded-proto': 'https',
        },
        body: JSON.stringify({ item: 'tea' }),
      });
      expect(await response.json()).toEqual({ node: 'node-9' });
    } finally {
      await server.shutdown({ gracePeriodMs: 0 });
    }
  });
});
