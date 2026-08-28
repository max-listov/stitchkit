import { afterAll, describe, expect, test } from 'bun:test';
import { once } from 'node:events';
import { createServer as createNodeServer, type Server } from 'node:http';
import { createServer as createNetServer } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { z } from 'zod';
import { createClient, createHttpClient } from '../src';
import { ApiError } from '../src/browser/http';
import { defineContract } from '../src/contract';
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

const typedProbe = defineContract(
  { prefix: 'probe' },
  {
    read: {
      method: 'GET',
      path: '/',
      desc: 'Read a typed transport probe',
      output: z.object({ ok: z.boolean() }),
    },
  },
);

async function rejectedApiError(work: Promise<unknown>): Promise<ApiError> {
  try {
    await work;
  } catch (error) {
    expect(error).toBeInstanceOf(ApiError);
    if (error instanceof ApiError) return error;
    throw error;
  }
  throw new Error('Expected the typed client request to reject');
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

  test('streaming response mode removes only the cumulative response ceiling', async () => {
    const payload = 'x'.repeat(128 * 1024);
    const unix = createNodeServer((_request, response) => response.end(payload));
    servers.push(unix);
    const socketPath = nextSocketPath();
    await listen(unix, socketPath);

    const bounded = createUnixClientTransport({ socketPath, maxResponseBytes: 1024 });
    await expect(
      bounded.fetch('http://local/bounded').then((response) => response.text()),
    ).rejects.toMatchObject({ code: 'UNIX_RESPONSE_TOO_LARGE' });
    await bounded.close();

    const streaming = createUnixClientTransport({
      socketPath,
      responseBodyMode: 'streaming',
      maxHeaderBytes: 1024,
      maxConnections: 1,
    });
    expect(
      await streaming.fetch('http://local/stream').then((response) => response.text()),
    ).toBe(payload);
    await streaming.close();
  });

  test('Bun pauses and resumes a chunked producer without corrupting framing', async () => {
    let written = 0;
    const frame = `${JSON.stringify({ index: 0, data: 'x'.repeat(32 * 1024) })}\n`;
    const unix = createNodeServer(async (_request, response) => {
      response.setHeader('content-type', 'application/octet-stream');
      try {
        for (let index = 0; index < 64; index += 1) {
          const value = frame.replace('"index":0', `"index":${index}`);
          if (!response.write(value)) await once(response, 'drain');
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
    const transport = createUnixClientTransport({
      socketPath,
      responseBodyMode: 'streaming',
    });
    const response = await transport.fetch('http://local/fast');
    const reader = response.body?.getReader();
    expect(reader).toBeDefined();
    if (!reader) return;
    const chunks: Uint8Array[] = [];
    const first = await reader.read();
    if (first.value) chunks.push(first.value);
    await Bun.sleep(200);
    expect(written).toBeLessThan(64);
    for (;;) {
      const next = await reader.read();
      if (next.done) break;
      chunks.push(next.value);
    }
    const actual = Buffer.concat(chunks.map((chunk) => Buffer.from(chunk))).toString();
    const expected = Array.from({ length: 64 }, (_, index) =>
      frame.replace('"index":0', `"index":${index}`),
    ).join('');
    expect(actual).toBe(expected);
    expect(written).toBe(64);
    await transport.close();
  });

  test('Bun still refuses malformed chunk delimiters', async () => {
    const socketPath = nextSocketPath();
    const server = createNetServer((socket) => {
      socket.once('data', () => {
        socket.end(
          'HTTP/1.1 200 OK\r\nTransfer-Encoding: chunked\r\n\r\n3\r\nabcX\r\n0\r\n\r\n',
        );
      });
    });
    await new Promise<void>((resolve, reject) => {
      server.once('error', reject);
      server.listen(socketPath, resolve);
    });
    try {
      const transport = createUnixClientTransport({ socketPath });
      await expect(
        transport.fetch('http://local/malformed').then((response) => response.text()),
      ).rejects.toMatchObject({
        code: 'UNIX_RESPONSE_ABORTED',
        delivery: 'response-received',
      });
      await transport.close();
    } finally {
      await new Promise<void>((resolve, reject) =>
        server.close((error) => (error ? reject(error) : resolve())),
      );
    }
  });

  test('close interrupts an active body once and the finite connection cap refuses without queueing', async () => {
    const unix = createNodeServer((_request, response) => {
      response.writeHead(200, { 'content-type': 'application/octet-stream' });
      response.write('first');
    });
    servers.push(unix);
    const socketPath = nextSocketPath();
    await listen(unix, socketPath);
    const transport = createUnixClientTransport({
      socketPath,
      responseBodyMode: 'streaming',
      maxConnections: 1,
    });
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

  test('typed-client cause preserves not-dispatched and post-dispatch timeout states', async () => {
    const missingTransport = createUnixClientTransport({ socketPath: nextSocketPath() });
    const missingClient = createClient(typedProbe, {
      baseUrl: 'http://local',
      fetch: missingTransport.fetch,
    });
    const missing = await rejectedApiError(missingClient.read());
    expect(missing).toMatchObject({ code: 'UNKNOWN_ERROR', status: 0 });
    expect(missing.cause).toBeInstanceOf(UnixClientTransportError);
    expect(missing.cause).toMatchObject({
      code: 'UNIX_CONNECT_FAILED',
      delivery: 'not-dispatched',
    });
    await missingTransport.close();

    const hanging = createNodeServer(() => undefined);
    servers.push(hanging);
    const socketPath = nextSocketPath();
    await listen(hanging, socketPath);
    const timedTransport = createUnixClientTransport({ socketPath, headersTimeoutMs: 25 });
    const timedClient = createClient(typedProbe, {
      baseUrl: 'http://local',
      fetch: timedTransport.fetch,
    });
    const timed = await rejectedApiError(timedClient.read());
    expect(timed.cause).toMatchObject({
      code: 'UNIX_HEADERS_TIMEOUT',
      delivery: 'possibly-dispatched',
    });
    await timedTransport.close();
  });

  test('typed-client cancellation and response bounds remain distinguishable', async () => {
    const requestStarted = Promise.withResolvers<void>();
    const unix = createNodeServer((_request, response) => {
      response.writeHead(200, { 'content-type': 'application/json' });
      response.write('{"ok":');
      requestStarted.resolve();
    });
    servers.push(unix);
    const socketPath = nextSocketPath();
    await listen(unix, socketPath);
    const transport = createUnixClientTransport({ socketPath, maxResponseBytes: 8 });
    const client = createClient(typedProbe, {
      baseUrl: 'http://local',
      fetch: transport.fetch,
    });
    const abort = new AbortController();
    const cancelledRequest = client.read.withOptions({ signal: abort.signal });
    await requestStarted.promise;
    abort.abort(new Error('caller left'));
    await expect(cancelledRequest).rejects.toMatchObject({
      name: 'ApiError',
      code: 'REQUEST_ABORTED',
      status: 0,
    });
    await transport.close();

    const oversized = createNodeServer((_request, response) => {
      response.writeHead(200, { 'content-type': 'application/json' });
      response.end(JSON.stringify({ ok: true, padding: 'too large' }));
    });
    servers.push(oversized);
    const oversizedPath = nextSocketPath();
    await listen(oversized, oversizedPath);
    const boundedTransport = createUnixClientTransport({
      socketPath: oversizedPath,
      maxResponseBytes: 8,
    });
    const boundedClient = createClient(typedProbe, {
      baseUrl: 'http://local',
      fetch: boundedTransport.fetch,
    });
    const bounded = await rejectedApiError(boundedClient.read());
    expect(bounded.cause).toMatchObject({
      code: 'UNIX_RESPONSE_TOO_LARGE',
      delivery: 'response-received',
    });
    await boundedTransport.close();
  });

  test('typed-client received domain failure stays an ApiError response', async () => {
    const unix = createNodeServer((_request, response) => {
      response.writeHead(409, { 'content-type': 'application/json' });
      response.end(
        JSON.stringify({ error: { code: 'CONFLICT', message: 'Already changed' } }),
      );
    });
    servers.push(unix);
    const socketPath = nextSocketPath();
    await listen(unix, socketPath);
    const transport = createUnixClientTransport({ socketPath });
    const client = createClient(typedProbe, {
      baseUrl: 'http://local',
      fetch: transport.fetch,
    });

    const failure = await rejectedApiError(client.read());
    expect(failure).toMatchObject({
      name: 'ApiError',
      code: 'CONFLICT',
      status: 409,
    });
    expect(failure.cause).toBeUndefined();
    await transport.close();
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
