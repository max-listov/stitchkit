import { expect, test } from 'bun:test';
import { request } from 'node:http';
import type { Socket } from 'node:net';
import { createServer, isLoopbackAddress } from '../src/entrypoints/server';

const headers = { host: 'tenant.invalid', 'x-forwarded-proto': 'https' };

test('proxy origin retains native WebSocket upgrade, socket peer and managed shutdown', async () => {
  const upgraded = Promise.withResolvers<Socket>();
  const server = createServer({
    hostname: '127.0.0.1',
    port: 0,
    proxyOrigin: { trustedPeer: isLoopbackAddress },
    rawRoutes: [
      {
        method: 'GET',
        path: '/ws',
        handler: (req, ctx) => {
          expect(ctx.server?.requestIP(req)?.address).toBe('127.0.0.1');
          expect(new URL(req.url).origin).toBe('https://tenant.invalid');
          return ctx.server?.upgrade(req, { data: undefined })
            ? new Response(null)
            : new Response('upgrade refused', { status: 400 });
        },
      },
    ],
    websocket: {
      open(ws) {
        ws.send('upgraded');
      },
      message() {
        /* This upgrade control sends no client messages. */
      },
    },
  });
  const client = request(`${server.url}/ws`, {
    headers: {
      ...headers,
      connection: 'Upgrade',
      upgrade: 'websocket',
      'sec-websocket-version': '13',
      'sec-websocket-key': Buffer.alloc(16, 7).toString('base64'),
    },
  });
  client.on('error', upgraded.reject);
  client.on('response', (response) => {
    response.resume();
    upgraded.reject(new Error('Upgrade refused'));
  });
  client.on('upgrade', (response, socket) => {
    expect(response.statusCode).toBe(101);
    // Reply to the server's close with a masked empty WebSocket close frame.
    socket.on('data', (bytes: Buffer) => {
      if (bytes[0] === 0x88) socket.end(Buffer.from([0x88, 0x80, 0, 0, 0, 0]));
    });
    upgraded.resolve(socket);
  });
  client.end();
  let connection: Socket | undefined;
  try {
    connection = await upgraded.promise;
    const closed = new Promise<void>((resolve) => {
      connection?.once('close', resolve);
    });
    const result = await server.shutdown({ gracePeriodMs: 1000 });
    await closed;
    expect(result.outcome).toBe('clean');
    expect(result.pendingWebSockets).toBe(0);
  } finally {
    client.destroy();
    connection?.destroy();
    if (server.status.state === 'running') await server.shutdown();
  }
});

test('proxy origin carries native request cancellation to the normalized Request signal', async () => {
  const entered = Promise.withResolvers<void>();
  const aborted = Promise.withResolvers<boolean>();
  const server = createServer({
    hostname: '127.0.0.1',
    port: 0,
    proxyOrigin: { trustedPeer: isLoopbackAddress },
    rawRoutes: [
      {
        method: 'POST',
        path: '/',
        handler: async (req) => {
          expect(req.url).toBe('https://tenant.invalid/');
          await req.text();
          req.signal.addEventListener('abort', () => aborted.resolve(req.signal.aborted), {
            once: true,
          });
          entered.resolve();
          await aborted.promise;
          return new Response('cancelled');
        },
      },
    ],
  });
  const controller = new AbortController();
  const pending = fetch(server.url, {
    headers,
    method: 'POST',
    body: 'hello',
    signal: controller.signal,
  }).catch(() => undefined);
  try {
    await entered.promise;
    controller.abort();
    expect(await aborted.promise).toBe(true);
    await pending;
  } finally {
    controller.abort();
    await server.shutdown();
  }
});

test('proxy origin preserves explicit wire authority ports and refuses malformed authority', async () => {
  const server = createServer({
    hostname: '127.0.0.1',
    port: 0,
    proxyOrigin: { trustedPeer: isLoopbackAddress },
    rawRoutes: [{ method: 'GET', path: '/', handler: (req) => Response.json(req.url) }],
  });
  try {
    const cases: [string, string, string][] = [
      ['tenant.invalid:80', 'https', 'https://tenant.invalid:80/'],
      ['tenant.invalid:443', 'http', 'http://tenant.invalid:443/'],
      ['[::1]:8443', 'https', 'https://[::1]:8443/'],
    ];
    for (const [host, proto, expected] of cases) {
      expect(
        await (
          await fetch(server.url, { headers: { host, 'x-forwarded-proto': proto } })
        ).json(),
      ).toBe(expected);
    }
    for (const host of [
      'user@tenant.invalid',
      'tenant.invalid:65536',
      'tenant.invalid,evil.invalid',
      'tenant.invalid/path',
      'tenant.invalid?x',
      'tenant.invalid#x',
    ]) {
      expect((await fetch(server.url, { headers: { ...headers, host } })).status).toBe(400);
    }
  } finally {
    await server.shutdown();
  }
});
