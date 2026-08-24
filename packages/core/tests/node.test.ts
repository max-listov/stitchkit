import { afterAll, describe, expect, test } from 'bun:test';
import { z } from 'zod';
import { defineContract } from '../src/contract';
import { isFetchBlockedPort } from '../src/internal/fetch-port';
import { implement } from '../src/server/implement';
import { serveNode } from '../src/server/node';

const contract = defineContract(
  { prefix: '/api' },
  {
    ping: {
      method: 'GET',
      path: '/ping',
      desc: 'Health check',
      output: z.object({ pong: z.boolean() }),
    },
    echo: {
      method: 'POST',
      path: '/echo',
      desc: 'Echo message',
      input: z.object({ message: z.string() }),
      output: z.object({ message: z.string() }),
    },
    whoami: {
      method: 'GET',
      path: '/whoami',
      desc: 'Report the resolved client IP',
      output: z.object({ ip: z.string().nullable() }),
    },
  },
);

const service = implement(contract, {
  ping: () => ({ pong: true }),
  echo: (ctx) => ({ message: ctx.input.message }),
  whoami: (ctx) => ({ ip: ctx.ipAddress ?? null }),
});

const server = await serveNode({
  services: [service],
  port: 0,
});

const base = `http://localhost:${server.port}`;

afterAll(() => server.shutdown({ gracePeriodMs: 0 }));

describe('serveNode', () => {
  test('recognizes ports that Fetch blocks before network I/O', () => {
    expect(isFetchBlockedPort(4045)).toBe(true);
    expect(isFetchBlockedPort(4046)).toBe(false);
  });

  test('GET returns JSON', async () => {
    const res = await fetch(`${base}/api/ping`);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ pong: true });
  });

  test('POST with body', async () => {
    const res = await fetch(`${base}/api/echo`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ message: 'hello' }),
    });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ message: 'hello' });
  });

  test('404 for unknown path', async () => {
    const res = await fetch(`${base}/nope`);
    expect(res.status).toBe(404);
  });

  test('405 for wrong method', async () => {
    const res = await fetch(`${base}/api/ping`, { method: 'POST' });
    expect(res.status).toBe(405);
  });

  test('trace id header present', async () => {
    const res = await fetch(`${base}/api/ping`);
    expect(res.headers.get('x-request-id')).toBeTruthy();
  });

  test('ctx.ipAddress is the real socket peer — no trustProxy needed', async () => {
    const res = await fetch(`${base}/api/whoami`);
    const body = await res.json();
    // srvx resolves the loopback peer — non-empty without any header trust.
    expect(body.ip).toBeTruthy();
  });

  test('a spoofed x-forwarded-for is ignored without trustProxy', async () => {
    const res = await fetch(`${base}/api/whoami`, {
      headers: { 'x-forwarded-for': '9.9.9.9' },
    });
    const body = await res.json();
    expect(body.ip).not.toBe('9.9.9.9');
  });

  test('CORS headers when configured', async () => {
    const corsServer = await serveNode({
      services: [service],
      port: 0,
      cors: { origin: 'https://example.com', methods: 'GET, POST' },
    });
    const corsBase = `http://localhost:${corsServer.port}`;

    const res = await fetch(`${corsBase}/api/ping`, {
      headers: { origin: 'https://example.com' },
    });
    expect(res.headers.get('access-control-allow-origin')).toBe('https://example.com');

    await corsServer.shutdown({ gracePeriodMs: 0 });
  });

  test('does not install hidden srvx signal listeners', async () => {
    const beforeTerm = process.listenerCount('SIGTERM');
    const beforeInterrupt = process.listenerCount('SIGINT');
    const managed = await serveNode({ port: 0 });
    expect(process.listenerCount('SIGTERM')).toBe(beforeTerm);
    expect(process.listenerCount('SIGINT')).toBe(beforeInterrupt);
    await managed.shutdown({ gracePeriodMs: 0 });
  });

  test('forces a physically open streaming response and preserves its snapshot', async () => {
    const streamStarted = Promise.withResolvers<void>();
    const managed = await serveNode({
      port: 0,
      rawRoutes: [
        {
          method: 'GET',
          path: '/stream',
          handler: () =>
            new Response(
              new ReadableStream({
                start(controller) {
                  controller.enqueue(new TextEncoder().encode('started'));
                  streamStarted.resolve();
                },
              }),
            ),
        },
      ],
    });
    const request = fetch(`${managed.url}/stream`).catch(() => undefined);
    await streamStarted.promise;
    const result = await managed.shutdown({ gracePeriodMs: 25 });
    expect(result.outcome).toBe('forced');
    expect(result.pendingRequestsAtForce).toBeGreaterThan(0);
    expect(result.pendingRequests).toBe(0);
    await request;
  });
});
