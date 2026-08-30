import { afterAll, describe, expect, test } from 'bun:test';
import { connect } from 'node:net';
import { z } from 'zod';
import { defineContract } from '../src/contract';
import { implement } from '../src/server/implement';
import { type NodeSocketLifecycle, serveNode } from '../src/server/node';

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

  test('bounds an upgraded Node socket whose owner never completes close', async () => {
    const serverSawUpgrade = Promise.withResolvers<void>();
    const socketLifecycle: NodeSocketLifecycle = {
      attach(httpServer) {
        httpServer.on('upgrade', () => {
          serverSawUpgrade.resolve();
        });
      },
      beginShutdown() {
        // Admission is owned by the fixture lifecycle.
      },
      close: () => new Promise(() => undefined),
      connections: () => 1,
    };
    const managed = await serveNode({ port: 0, socket: socketLifecycle });
    const peer = connect({ host: 'localhost', port: managed.port });
    await new Promise<void>((resolve) => peer.once('connect', resolve));
    peer.write(
      [
        'GET /socket HTTP/1.1',
        `Host: localhost:${managed.port}`,
        'Connection: Upgrade',
        'Upgrade: websocket',
        'Sec-WebSocket-Version: 13',
        'Sec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==',
        '',
        '',
      ].join('\r\n'),
    );
    await Promise.race([
      serverSawUpgrade.promise,
      Bun.sleep(500).then(() => {
        throw new Error('fixture upgrade did not complete');
      }),
    ]);
    expect(managed.status.pendingWebSockets).toBe(1);
    const beganAt = performance.now();

    const result = await Promise.race([
      managed.shutdown({
        gracePeriodMs: 2_000,
        realtimeCloseTimeoutMs: 20,
        forceTimeoutMs: 1_000,
      }),
      Bun.sleep(500).then(() => {
        throw new Error(
          `fixture shutdown did not complete: ${JSON.stringify(managed.status)}`,
        );
      }),
    ]);

    expect(result.outcome).toBe('clean');
    expect(result.pendingWebSocketsAtForce).toBe(0);
    expect(result.forcedWebSockets).toBe(1);
    expect(result.pendingWebSockets).toBe(0);
    expect(performance.now() - beganAt).toBeLessThan(500);
  });
});
