import { expect, test } from 'bun:test';
import { z } from 'zod';
import { defineContract } from '../src/entrypoints/contract';
import { createServer, implement, isLoopbackAddress } from '../src/entrypoints/server';

const headers = { host: 'tenant.invalid', 'x-forwarded-proto': 'https' };
const externalOrigin = 'https://tenant.invalid';
const contract = defineContract(
  { prefix: 'origin' },
  {
    read: {
      method: 'GET',
      path: '/',
      desc: 'Read origin',
      output: z.object({ origin: z.string(), ip: z.string().optional() }),
    },
  },
);

test('trusted proxy origin precedes wrappers, hooks, contracts and raw same-origin guards', async () => {
  const origins: string[] = [];
  const service = implement(contract, {
    read: (ctx) => {
      if (!ctx.req) throw new Error('HTTP request missing');
      return { origin: new URL(ctx.req.url).origin, ip: ctx.ipAddress };
    },
  });
  const server = createServer({
    hostname: '127.0.0.1',
    port: 0,
    services: [service],
    proxyOrigin: { trustedPeer: isLoopbackAddress },
    wrapFetch: (handler) => async (req, runtime) => {
      origins.push(new URL(req.url).origin);
      expect(runtime?.requestIP(req)?.address).toBe('127.0.0.1');
      runtime?.timeout(req, 5);
      return handler(req, runtime);
    },
    hooks: {
      onRequest: (req) => {
        origins.push(new URL(req.url).origin);
      },
    },
    rawRoutes: [
      {
        method: 'ALL',
        path: '/session',
        handler: async (req, ctx) => {
          const url = new URL(req.url);
          const asserted = req.headers.get('origin') ?? req.headers.get('referer');
          if (
            url.hostname !== 'tenant.invalid' ||
            !asserted ||
            new URL(asserted).origin !== url.origin
          )
            return new Response(null, { status: 403 });
          const cloned = req.clone();
          const body = await req.text();
          expect(await cloned.text()).toBe(body);
          return Response.json({
            method: req.method,
            body,
            ip: ctx.ipAddress,
            header: req.headers.get('x-test'),
            cloned: cloned.url,
          });
        },
      },
    ],
  });
  try {
    const response = await fetch(`${server.url}/origin`, { headers });
    expect(await response.json()).toEqual({ origin: externalOrigin, ip: '127.0.0.1' });
    for (const method of ['GET', 'POST']) {
      const response = await fetch(`${server.url}/session?q=1`, {
        method,
        headers: {
          ...headers,
          'x-test': 'preserved',
          ...(method === 'GET'
            ? { referer: `${externalOrigin}/page` }
            : { origin: externalOrigin }),
        },
        ...(method === 'POST' && { body: 'body preserved' }),
      });
      expect(response.status).toBe(200);
      expect(await response.json()).toEqual({
        method,
        body: method === 'GET' ? '' : 'body preserved',
        ip: '127.0.0.1',
        header: 'preserved',
        cloned: `${externalOrigin}/session?q=1`,
      });
    }
    for (const change of [{ origin: 'https://other.invalid' }, { host: 'other.invalid' }]) {
      expect(
        (
          await fetch(`${server.url}/session`, {
            headers: { ...headers, origin: externalOrigin, ...change },
          })
        ).status,
      ).toBe(403);
    }
    expect(origins.every((origin) => origin.startsWith('https://'))).toBe(true);
  } finally {
    expect((await server.shutdown()).outcome).toBe('clean');
  }
});

test('proxy origin requires a trusted socket peer independently of trustProxy client IP', async () => {
  for (const mode of ['default', 'ip-only', 'denied', 'trusted']) {
    const seenPeers: string[] = [];
    const server = createServer({
      hostname: '127.0.0.1',
      port: 0,
      trustProxy: mode === 'ip-only' || mode === 'denied',
      ...(mode !== 'default' &&
        mode !== 'ip-only' && {
          proxyOrigin: {
            trustedPeer: (ip: string) => {
              seenPeers.push(ip);
              return mode === 'trusted';
            },
          },
        }),
      rawRoutes: [{ method: 'GET', path: '/', handler: (req) => Response.json(req.url) }],
    });
    try {
      const response = await fetch(server.url, {
        headers: {
          ...headers,
          'x-forwarded-for': '203.0.113.1',
          'x-real-ip': '203.0.113.2',
          'x-forwarded-host': 'spoof.invalid',
        },
      });
      if (mode === 'trusted') expect(response.status).toBe(400);
      else expect(await response.json()).toBe('http://tenant.invalid/');
      expect(seenPeers).toEqual(mode === 'denied' || mode === 'trusted' ? ['127.0.0.1'] : []);
    } finally {
      await server.shutdown();
    }
  }
});

test('trusted proxy origin refuses missing, chained and conflicting forwarding fields before dispatch', async () => {
  let dispatched = 0;
  const server = createServer({
    hostname: '127.0.0.1',
    port: 0,
    proxyOrigin: { trustedPeer: isLoopbackAddress },
    wrapFetch: (handler) => (req, runtime) => {
      dispatched++;
      return handler(req, runtime);
    },
    rawRoutes: [{ method: 'GET', path: '/', handler: (req) => Response.json(req.url) }],
  });
  try {
    for (const proto of [
      undefined,
      '',
      'HTTPS',
      'https,http',
      'ftp',
      'https;host=evil.invalid',
    ]) {
      const response = await fetch(server.url, {
        headers: {
          host: headers.host,
          ...(proto !== undefined && { 'x-forwarded-proto': proto }),
        },
      });
      expect(response.status).toBe(400);
    }
    for (const name of ['forwarded', 'x-forwarded-host', 'x-forwarded-port']) {
      expect(
        (await fetch(server.url, { headers: { ...headers, [name]: 'conflict' } })).status,
      ).toBe(400);
    }
    expect(dispatched).toBe(0);
    expect(
      await (
        await fetch(server.url, { headers: { ...headers, 'x-forwarded-proto': 'http' } })
      ).json(),
    ).toBe('http://tenant.invalid/');
  } finally {
    await server.shutdown();
  }
});
