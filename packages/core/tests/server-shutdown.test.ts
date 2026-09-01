import { describe, expect, test } from 'bun:test';
import { io as ioClient } from 'socket.io-client';
import { z } from 'zod';
import { defineContract } from '../src/contract';
import {
  type BunServerConfig,
  createServer,
  createSocketIOServer,
  implement,
} from '../src/server';

const contract = defineContract(
  { prefix: 'lifecycle' },
  {
    wait: {
      method: 'GET',
      path: '/',
      desc: 'Wait for the test to release the request',
      output: z.object({ ok: z.boolean() }),
    },
  },
);

describe('managed Bun server shutdown', () => {
  test('closes admission outside wrapFetch, drains accepted work and reuses one Promise', async () => {
    const started = Promise.withResolvers<void>();
    const release = Promise.withResolvers<void>();
    let wrapperCalls = 0;
    const service = implement(contract, {
      async wait() {
        started.resolve();
        await release.promise;
        return { ok: true };
      },
    });
    const server = createServer({
      port: 0,
      services: [service],
      wrapFetch: (handler) => async (request, runtime) => {
        wrapperCalls += 1;
        return handler(request, runtime);
      },
    });

    const accepted = fetch(`${server.url}/lifecycle`);
    await started.promise;
    const firstShutdown = server.shutdown({ gracePeriodMs: 1_000, retryAfterSeconds: 9 });
    const secondShutdown = server.shutdown({ gracePeriodMs: 0 });
    expect(secondShutdown).toBe(firstShutdown);

    const rejected = await fetch(`${server.url}/lifecycle`);
    expect(rejected.status).toBe(503);
    expect(rejected.headers.get('retry-after')).toBe('9');
    expect(rejected.headers.get('connection')).toBe('close');
    expect(wrapperCalls).toBe(1);

    release.resolve();
    expect(await (await accepted).json()).toEqual({ ok: true });
    const result = await firstShutdown;
    expect(result.outcome).toBe('clean');
    expect(result.acceptedRequests).toBe(1);
    expect(result.completedRequests).toBe(1);
    expect(result.pendingRequests).toBe(0);
    expect(server.status.state).toBe('clean');
  });

  /**
   * The harness budget has to exceed the budget the test hands the code.
   *
   * This test grants `forceTimeoutMs: 5_000` and used to run under Bun's default 5 s per-test
   * timeout, so it passed only while forcing finished far inside its own allowance — and the
   * bound below already permitted 5.5 s, a range the harness could never reach. On a loaded CI
   * runner the two deadlines met: the run died as "timed out after 5000ms" plus an unhandled
   * "forced shutdown did not complete within 5000ms", which reads like a product hang and is
   * really a test racing itself. The explicit timeout keeps the assertion the thing that fails.
   */
  test('forces after the grace budget and preserves the pending snapshot', async () => {
    const started = Promise.withResolvers<void>();
    const service = implement(contract, {
      async wait() {
        started.resolve();
        await new Promise(() => undefined);
        return { ok: true };
      },
    });
    const server = createServer({ port: 0, services: [service] });
    const request = fetch(`${server.url}/lifecycle`).catch(() => undefined);
    await started.promise;
    const beganAt = performance.now();
    const result = await server.shutdown({ gracePeriodMs: 25, forceTimeoutMs: 5_000 });
    expect(result.outcome).toBe('forced');
    expect(result.reason).toBe('deadline');
    expect(result.pendingRequestsAtForce).toBeGreaterThan(0);
    expect(result.abortedRequests).toBeGreaterThan(0);
    expect(result.pendingRequests).toBe(0);
    const elapsedMs = performance.now() - beganAt;
    expect(elapsedMs).toBeGreaterThanOrEqual(20);
    expect(elapsedMs).toBeLessThan(5_500);
    await request;
  }, 20_000);

  test('an already-aborted external signal forces immediately', async () => {
    const server = createServer({ port: 0 });
    const controller = new AbortController();
    controller.abort();
    const result = await server.shutdown({ gracePeriodMs: 10_000, signal: controller.signal });
    expect(result.outcome).toBe('forced');
    expect(result.reason).toBe('signal');
    expect(result.durationMs).toBeLessThan(500);
  });

  for (const transport of ['websocket', 'polling'] as const) {
    test(`cleanly closes an active Socket.IO ${transport} transport`, async () => {
      const socket = await createSocketIOServer({
        cors: { origin: '*' },
        transports: [transport],
      });
      const server = createServer({ port: 0, socket });
      const client = ioClient(server.url, { transports: [transport], reconnection: false });
      await new Promise<void>((resolve, reject) => {
        client.once('connect', () => resolve());
        client.once('connect_error', reject);
      });
      expect(server.status.acceptedRequests).toBe(0);
      expect(server.status.pendingWebSockets).toBe(transport === 'websocket' ? 1 : 0);
      const disconnected = new Promise<void>((resolve) =>
        client.once('disconnect', () => resolve()),
      );
      const result = await server.shutdown({ gracePeriodMs: 1_000 });
      await disconnected;
      expect(result.outcome).toBe('clean');
      expect(result.pendingWebSockets).toBe(0);
      client.close();
    });
  }

  test('keeps Socket.IO transport outside application admission and composes handshake policy', async () => {
    const started = Promise.withResolvers<void>();
    const release = Promise.withResolvers<void>();
    let policyCalls = 0;
    const service = implement(contract, {
      async wait() {
        started.resolve();
        await release.promise;
        return { ok: true };
      },
    });
    const socket = await createSocketIOServer({
      cors: { origin: '*' },
      transports: ['polling'],
      allowRequest(request) {
        policyCalls += 1;
        return new URL(request.url).pathname === '/socket.io/';
      },
    });
    const server = createServer({ port: 0, services: [service], socket });
    const accepted = fetch(`${server.url}/lifecycle`);
    await started.promise;
    const shutdown = server.shutdown({ gracePeriodMs: 1_000 });
    const rejectedClient = ioClient(server.url, {
      transports: ['polling'],
      reconnection: false,
    });
    await new Promise<void>((resolve) =>
      rejectedClient.once('connect_error', () => resolve()),
    );
    expect(policyCalls).toBe(1);
    expect(server.status.acceptedRequests).toBe(1);
    rejectedClient.close();
    release.resolve();
    await accepted;
    expect((await shutdown).outcome).toBe('clean');
  });

  test('closes a tracked raw Bun WebSocket before graceful runtime stop', async () => {
    const opened = Promise.withResolvers<void>();
    const server = createServer({
      port: 0,
      rawRoutes: [
        {
          method: 'GET',
          path: '/raw',
          handler(request, context) {
            return context.server?.upgrade(request, { data: undefined })
              ? new Response(null)
              : new Response('upgrade failed', { status: 400 });
          },
        },
      ],
      websocket: {
        open() {
          opened.resolve();
        },
        message() {
          // no-op
        },
      },
    });
    const client = new WebSocket(`${server.url.replace('http:', 'ws:')}/raw`);
    await opened.promise;
    const closed = new Promise<void>((resolve) =>
      client.addEventListener('close', () => resolve()),
    );
    const result = await server.shutdown({ gracePeriodMs: 1_000 });
    await closed;
    expect(result.outcome).toBe('clean');
    expect(result.pendingWebSockets).toBe(0);
  });

  test('forced raw Bun WebSocket waits for the server-side close callback', async () => {
    const opened = Promise.withResolvers<void>();
    let physicalCloseObserved = false;
    const server = createServer({
      port: 0,
      rawRoutes: [
        {
          method: 'GET',
          path: '/forced-raw',
          handler(request, context) {
            return context.server?.upgrade(request, { data: undefined })
              ? new Response(null)
              : new Response('upgrade failed', { status: 400 });
          },
        },
      ],
      websocket: {
        open() {
          opened.resolve();
        },
        message() {
          // no-op
        },
        close() {
          physicalCloseObserved = true;
        },
      },
    });
    const client = new WebSocket(`${server.url.replace('http:', 'ws:')}/forced-raw`);
    await opened.promise;
    const closed = new Promise<void>((resolve) =>
      client.addEventListener('close', () => resolve()),
    );
    const controller = new AbortController();
    controller.abort();

    const result = await server.shutdown({
      gracePeriodMs: 10_000,
      forceTimeoutMs: 1_000,
      signal: controller.signal,
    });
    expect(physicalCloseObserved).toBe(true);
    expect(result.outcome).toBe('forced');
    expect(result.reason).toBe('signal');
    expect(result.pendingWebSocketsAtForce).toBe(1);
    expect(result.forcedWebSockets).toBe(1);
    expect(result.pendingWebSockets).toBe(0);
    await closed;
    const listenerStillAccepts = await fetch(`${server.url}/after-force`).then(
      () => true,
      () => false,
    );
    expect(listenerStillAccepts).toBe(false);
  });

  test('native Bun routes are a compile-time error because they bypass admission', () => {
    const rejectedConfig: BunServerConfig = {
      port: 0,
      // @ts-expect-error Managed servers require Fetch-clean rawRoutes.
      routes: { '/bypass': () => new Response('unsafe') },
    };
    expect('routes' in rejectedConfig).toBe(true);
  });
});
