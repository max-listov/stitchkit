import { afterAll, describe, expect, test } from 'bun:test';
import { once } from 'node:events';
import { createServer as createNodeServer, type Server } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHttpClient } from '../src';
import {
  createUnixClientTransport,
  UnixClientTransportError,
} from '../src/server/unix-client';

let counter = 0;
function nextSocketPath(): string {
  counter += 1;
  return join(tmpdir(), `sk-client-${process.pid}-${counter}.sock`);
}

function listen(server: Server, target: string | number): Promise<void> {
  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(target, () => {
      server.off('error', reject);
      resolve();
    });
  });
}

function close(server: Server): Promise<void> {
  return new Promise((resolve, reject) => {
    server.close((error) => (error ? reject(error) : resolve()));
    server.closeAllConnections();
  });
}

const servers: Server[] = [];
afterAll(async () => {
  for (const server of servers.reverse()) await close(server);
});

describe('createUnixClientTransport', () => {
  test('the selected socket is the only transport, including an absolute redirect', async () => {
    let tcpRequests = 0;
    const tcp = createNodeServer((_request, response) => {
      tcpRequests += 1;
      response.end('wrong transport');
    });
    servers.push(tcp);
    await listen(tcp, 0);
    const address = tcp.address();
    if (!address || typeof address === 'string') throw new Error('TCP sentinel has no port');

    const paths: string[] = [];
    const unix = createNodeServer((request, response) => {
      paths.push(request.url ?? '');
      if (request.url === '/redirect') {
        response.writeHead(302, {
          location: `http://127.0.0.1:${address.port}/final`,
        });
        response.end();
        return;
      }
      response.setHeader('content-type', 'application/json');
      response.end(JSON.stringify({ transport: 'unix' }));
    });
    servers.push(unix);
    const socketPath = nextSocketPath();
    await listen(unix, socketPath);

    const transport = createUnixClientTransport({ socketPath });
    const response = await transport.fetch(`http://127.0.0.1:${address.port}/redirect`);
    expect(await response.json()).toEqual({ transport: 'unix' });
    expect(paths).toEqual(['/redirect', '/final']);
    expect(tcpRequests).toBe(0);
    await transport.close();
    expect(transport.closed).toBeTrue();
  });

  test('composes with createHttpClient and preserves received HTTP failures', async () => {
    const unix = createNodeServer((request, response) => {
      if (request.url === '/failed') {
        response.writeHead(503, { 'content-type': 'application/json' });
        response.end(JSON.stringify({ error: { code: 'UNAVAILABLE' } }));
        return;
      }
      response.setHeader('content-type', 'application/json');
      response.end(JSON.stringify({ ok: true }));
    });
    servers.push(unix);
    const socketPath = nextSocketPath();
    await listen(unix, socketPath);
    const transport = createUnixClientTransport({ socketPath });
    const http = createHttpClient({
      baseUrl: 'http://local-daemon',
      fetch: transport.fetch,
      retry: { limit: 0 },
    });

    expect(await http.get<{ ok: boolean }>('/ok')).toEqual({ ok: true });
    await expect(http.get('/failed')).rejects.toMatchObject({
      code: 'UNAVAILABLE',
      status: 503,
    });
    await transport.close();
  });

  test('bounds request and response bytes before retained memory can grow', async () => {
    const unix = createNodeServer((_request, response) => response.end('0123456789'));
    servers.push(unix);
    const socketPath = nextSocketPath();
    await listen(unix, socketPath);
    const transport = createUnixClientTransport({
      socketPath,
      maxRequestBytes: 4,
      maxResponseBytes: 4,
    });

    await expect(
      transport.fetch('http://local/upload', { method: 'POST', body: '12345' }),
    ).rejects.toMatchObject({ code: 'UNIX_REQUEST_TOO_LARGE' });
    await expect(
      transport.fetch('http://local/download').then((response) => response.text()),
    ).rejects.toMatchObject({ code: 'UNIX_RESPONSE_TOO_LARGE' });
    await transport.close();
  });

  test('Bun pauses a fast producer when the response reader stalls', async () => {
    let written = 0;
    const unix = createNodeServer(async (_request, response) => {
      response.setHeader('content-type', 'application/octet-stream');
      try {
        for (let index = 0; index < 512; index += 1) {
          if (!response.write(Buffer.alloc(32 * 1024))) await once(response, 'drain');
          written += 1;
        }
        response.end();
      } catch {
        // Reader cancellation intentionally closes the producer.
      }
    });
    servers.push(unix);
    const socketPath = nextSocketPath();
    await listen(unix, socketPath);
    const transport = createUnixClientTransport({ socketPath });
    const response = await transport.fetch('http://local/fast');
    const reader = response.body?.getReader();
    expect(reader).toBeDefined();
    if (!reader) return;
    await reader.read();
    await Bun.sleep(200);
    expect(written).toBeLessThan(512);
    await reader.cancel();
    await transport.close();
  });

  test('close interrupts an active body once and the finite connection cap refuses without queueing', async () => {
    const unix = createNodeServer((_request, response) => {
      response.writeHead(200, { 'content-type': 'application/octet-stream' });
      response.write('first');
    });
    servers.push(unix);
    const socketPath = nextSocketPath();
    await listen(unix, socketPath);
    const transport = createUnixClientTransport({ socketPath, maxConnections: 1 });
    const response = await transport.fetch('http://local/active');
    const reader = response.body?.getReader();
    expect(reader).toBeDefined();
    if (!reader) return;
    await reader.read();
    await expect(transport.fetch('http://local/second')).rejects.toMatchObject({
      code: 'UNIX_CONNECTION_LIMIT',
      delivery: 'not-dispatched',
    });
    await transport.close();
    await expect(reader.read()).rejects.toMatchObject({ code: 'UNIX_CLIENT_CLOSED' });
  });

  test('missing sockets, pre-abort, header timeout and close settle explicitly', async () => {
    const missing = createUnixClientTransport({ socketPath: nextSocketPath() });
    await expect(missing.fetch('http://local/test')).rejects.toMatchObject({
      code: 'UNIX_CONNECT_FAILED',
      delivery: 'not-dispatched',
    });
    await missing.close();

    const hanging = createNodeServer(() => undefined);
    servers.push(hanging);
    const socketPath = nextSocketPath();
    await listen(hanging, socketPath);
    const timed = createUnixClientTransport({ socketPath, headersTimeoutMs: 25 });
    await expect(timed.fetch('http://local/hang')).rejects.toMatchObject({
      code: 'UNIX_HEADERS_TIMEOUT',
    });

    const abort = new AbortController();
    abort.abort(new Error('caller left'));
    await expect(
      timed.fetch('http://local/pre-aborted', { signal: abort.signal }),
    ).rejects.toThrow('caller left');
    await timed.close();
    await expect(timed.fetch('http://local/closed')).rejects.toBeInstanceOf(
      UnixClientTransportError,
    );
  });

  test('rejects ambiguous configuration and unsafe legacy Unix selection', () => {
    expect(() => createUnixClientTransport({ socketPath: 'relative.sock' })).toThrow(
      'absolute Unix socket path',
    );
    expect(() =>
      createHttpClient({
        baseUrl: 'http://local',
        unix: '/tmp/local.sock',
        fetch: globalThis.fetch,
      }),
    ).toThrow('mutually exclusive');
  });
});
