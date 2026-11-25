/**
 * A call that never got an answer is sent again only when sending it twice is safe.
 *
 * A host process restarts, a loopback connection drops: the call was sent and
 * no answer came. A read can simply go again; a write might already have run.
 * The endpoint says which: `idempotent: true` repeats whatever the method, a
 * `GET`/`HEAD` that says nothing repeats, `idempotent: false` never does, and a
 * write that says nothing never does — whether its method says so or its declared
 * `effect: 'write'` does over a `GET`. Both client paths read the same rule
 * from the endpoint itself. The server here closes the first connection of
 * every call without a byte of answer, as a crashing host does.
 */
import { afterAll, describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { createServer as createNetServer } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { z } from 'zod';
import { ApiError } from '../src/browser/api-error';
import { createClient } from '../src/browser/client';
import { createHttpClient, shouldRetryBunNetworkError } from '../src/browser/http';
import type { ClientFetch } from '../src/browser/transport';
import { defineContract } from '../src/entrypoints/contract';
import { typedEntries } from '../src/internal/typed';
import {
  createUnixClientTransport,
  type UnixClientDeliveryState,
  UnixClientTransportError,
  type UnixClientTransportErrorCode,
} from '../src/server/unix-client';
import { reapAfterEachTest, trackProcess } from './support/process-reaper';

reapAfterEachTest();

const Ok = z.object({ ok: z.literal(true) });
const host = defineContract(
  { prefix: 'host', scope: 'host' },
  {
    read: { method: 'GET', path: '/read', desc: 'A read', output: Ok },
    peek: {
      method: 'HEAD',
      path: '/peek',
      desc: 'A head that says nothing',
      rawResponse: true,
    },
    pinnedRead: {
      method: 'GET',
      path: '/pinned-read',
      desc: 'A read the endpoint refuses to repeat',
      idempotent: false,
      output: Ok,
    },
    claim: {
      method: 'GET',
      path: '/claim',
      desc: 'A GET the contract declares a write',
      effect: 'write',
      output: Ok,
    },
    touch: {
      method: 'HEAD',
      path: '/touch',
      desc: 'A HEAD the contract declares a write',
      effect: 'write',
      rawResponse: true,
    },
    claimTwice: {
      method: 'GET',
      path: '/claim-twice',
      desc: 'A declared write that is safe twice',
      effect: 'write',
      idempotent: true,
      output: Ok,
    },
    put: {
      method: 'POST',
      path: '/put',
      desc: 'A write that is safe twice',
      idempotent: true,
      input: z.object({ value: z.string() }),
      output: Ok,
    },
    append: {
      method: 'POST',
      path: '/append',
      desc: 'A write that says nothing',
      input: z.object({ value: z.string() }),
      output: Ok,
    },
  },
);

/** Connections per path; the first one of each path is closed without an answer. */
const attempts = new Map<string, number>();
const server = Bun.listen({
  hostname: '127.0.0.1',
  port: 0,
  socket: {
    data(socket, chunk) {
      const line = new TextDecoder().decode(chunk).split('\r\n')[0] ?? '';
      const [method, path = ''] = line.split(' ');
      const seen = (attempts.get(path) ?? 0) + 1;
      attempts.set(path, seen);
      if (seen === 1) {
        socket.end();
        return;
      }
      const body = method === 'HEAD' ? '' : '{"ok":true}';
      socket.end(
        `HTTP/1.1 200 OK\r\ncontent-type: application/json\r\ncontent-length: ${body.length}\r\nconnection: close\r\n\r\n${body}`,
      );
    },
  },
});
afterAll(() => server.stop(true));
const baseUrl = `http://127.0.0.1:${server.port}`;

const clients = {
  fetch: () => createClient(host, { baseUrl }),
  ky: () => createClient(host, createHttpClient({ baseUrl })),
};

describe.each(Object.entries(clients))(
  'a dropped connection on the %s client',
  (_name, make) => {
    test('a read and a write declared idempotent go again and succeed', async () => {
      attempts.clear();
      const client = make();
      expect(await client.read()).toEqual({ ok: true });
      expect(await client.put({ value: 'v' })).toEqual({ ok: true });
      expect(attempts.get('/host/read')).toBe(2);
      expect(attempts.get('/host/put')).toBe(2);
    });

    test('a HEAD that says nothing goes again like a GET', async () => {
      attempts.clear();
      await make().peek();
      expect(attempts.get('/host/peek')).toBe(2);
    });

    test('a GET or HEAD the contract declares a write is sent once and fails', async () => {
      attempts.clear();
      const client = make();
      await expect(client.claim()).rejects.toThrow();
      await expect(client.touch()).rejects.toThrow();
      expect(attempts.get('/host/claim')).toBe(1);
      expect(attempts.get('/host/touch')).toBe(1);
      // `idempotent: true` still says the write is safe twice.
      expect(await client.claimTwice()).toEqual({ ok: true });
      expect(attempts.get('/host/claim-twice')).toBe(2);
    });

    test('a write that says nothing and a read that refuses are sent once and fail', async () => {
      attempts.clear();
      const client = make();
      await expect(client.append({ value: 'v' })).rejects.toThrow();
      await expect(client.pinnedRead()).rejects.toThrow();
      expect(attempts.get('/host/append')).toBe(1);
      expect(attempts.get('/host/pinned-read')).toBe(1);
    });
  },
);

test('a call is sent again at most retry.limit times', async () => {
  // Every connection of this path is dropped: the read never gets an answer.
  const always = Bun.listen({
    hostname: '127.0.0.1',
    port: 0,
    socket: {
      data(socket) {
        hits += 1;
        socket.end();
      },
    },
  });
  let hits = 0;
  try {
    const url = `http://127.0.0.1:${always.port}`;
    await expect(
      createClient(host, { baseUrl: url, retry: { limit: 1 } }).read(),
    ).rejects.toThrow();
    expect(hits).toBe(2);
    hits = 0;
    await expect(
      createClient(host, { baseUrl: url, retry: { limit: 0 } }).read(),
    ).rejects.toThrow();
    expect(hits).toBe(1);
  } finally {
    always.stop(true);
  }
});

test('a retry limit that is not a non-negative integer is refused when the client is made', () => {
  for (const limit of [Number.NaN, -1, 1.5, Number.POSITIVE_INFINITY])
    expect(() => createClient(host, { baseUrl, retry: { limit } })).toThrow('retry.limit');
});

test('a cancellation during the pause before a repeat ends the call at once', async () => {
  let hits = 0;
  const always = Bun.listen({
    hostname: '127.0.0.1',
    port: 0,
    socket: {
      data(socket) {
        hits += 1;
        socket.end();
      },
    },
  });
  try {
    const controller = new AbortController();
    const client = createClient(host, { baseUrl: `http://127.0.0.1:${always.port}` });
    const started = performance.now();
    const call = client.read.withOptions({ signal: controller.signal });
    // The first send fails at once; the pause before the repeat is at least 80 ms.
    setTimeout(() => controller.abort(), 20);
    await expect(call).rejects.toThrow();
    expect(performance.now() - started).toBeLessThan(75);
    expect(hits).toBe(1);
  } finally {
    always.stop(true);
  }
});

const unixSocketRoot = mkdtempSync(join(tmpdir(), 'skr-'));
afterAll(() => {
  rmSync(unixSocketRoot, { recursive: true, force: true });
});

let unixSeq = 0;
function nextUnixSocketPath(): string {
  unixSeq += 1;
  return join(unixSocketRoot, `${unixSeq}.sock`);
}

function listenUnix(server: ReturnType<typeof createNetServer>, path: string): Promise<void> {
  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(path, () => {
      server.off('error', reject);
      resolve();
    });
  });
}

function closeUnix(server: ReturnType<typeof createNetServer>, path: string): Promise<void> {
  return new Promise((resolve) => {
    server.close(() => {
      rmSync(path, { force: true });
      resolve();
    });
  });
}

async function rejectedApiError(work: Promise<unknown>): Promise<ApiError> {
  try {
    await work;
  } catch (error) {
    expect(error).toBeInstanceOf(ApiError);
    if (error instanceof ApiError) return error;
    throw error;
  }
  throw new Error('Expected call to reject with ApiError');
}

const unixClients = {
  fetch: (transportFetch: ClientFetch) =>
    createClient(host, { baseUrl: 'http://local-host', fetch: transportFetch }),
  ky: (transportFetch: ClientFetch) =>
    createClient(
      host,
      createHttpClient({ baseUrl: 'http://local-host', fetch: transportFetch }),
    ),
};

describe.each(Object.entries(unixClients))(
  'unix client transport errors on the %s client',
  (_name, makeClient) => {
    test('idempotent calls retry UNIX_CONNECT_FAILED after a host restart; non-idempotent ones do not', async () => {
      const socketPath = nextUnixSocketPath();
      const bodies: string[] = [];
      let activeServer: ReturnType<typeof createNetServer> | undefined;
      const startServer = async (): Promise<void> => {
        if (activeServer) return;
        const next = createNetServer((socket) => {
          socket.once('data', (chunk) => {
            const raw = chunk.toString('utf8');
            const [head = '', body = ''] = raw.split('\r\n\r\n');
            const [method] = (head.split('\r\n')[0] ?? '').split(' ');
            if (body) bodies.push(body);
            const responseBody = method === 'HEAD' ? '' : '{"ok":true}';
            socket.end(
              `HTTP/1.1 200 OK\r\ncontent-type: application/json\r\ncontent-length: ${responseBody.length}\r\nconnection: close\r\n\r\n${responseBody}`,
            );
          });
        });
        await listenUnix(next, socketPath);
        activeServer = next;
      };
      const transport = createUnixClientTransport({ socketPath });
      try {
        // Non-idempotent calls fail on the first UNIX_CONNECT_FAILED without retrying.
        let nonIdempotentAttempts = 0;
        const failingFetch: ClientFetch = (input, init) => {
          nonIdempotentAttempts += 1;
          return transport.fetch(input, init);
        };
        const nonIdempotentClient = makeClient(failingFetch);
        const appendError = await rejectedApiError(
          nonIdempotentClient.append({ value: 'once' }),
        );
        expect(appendError.cause).toMatchObject({
          code: 'UNIX_CONNECT_FAILED',
          delivery: 'not-dispatched',
        });
        expect(nonIdempotentAttempts).toBe(1);

        nonIdempotentAttempts = 0;
        const pinnedError = await rejectedApiError(nonIdempotentClient.pinnedRead());
        expect(pinnedError.cause).toMatchObject({
          code: 'UNIX_CONNECT_FAILED',
          delivery: 'not-dispatched',
        });
        expect(nonIdempotentAttempts).toBe(1);

        // Idempotent GET, HEAD and POST retry after the host socket comes back up.
        for (const run of [
          async (client: ReturnType<typeof makeClient>) => {
            expect(await client.read()).toEqual({ ok: true });
          },
          async (client: ReturnType<typeof makeClient>) => {
            await client.peek();
          },
          async (client: ReturnType<typeof makeClient>) => {
            expect(await client.put({ value: 'restarted' })).toEqual({ ok: true });
          },
        ]) {
          if (activeServer) {
            await closeUnix(activeServer, socketPath);
            activeServer = undefined;
          }
          const errors: unknown[] = [];
          const restartingFetch: ClientFetch = async (input, init) => {
            try {
              return await transport.fetch(input, init);
            } catch (error) {
              errors.push(error);
              if (errors.length === 1) await startServer();
              throw error;
            }
          };
          await run(makeClient(restartingFetch));
          expect(errors).toHaveLength(1);
          expect(errors[0]).toBeInstanceOf(UnixClientTransportError);
          expect(errors[0]).toMatchObject({
            code: 'UNIX_CONNECT_FAILED',
            delivery: 'not-dispatched',
          });
        }
        expect(bodies).toEqual(['{"value":"restarted"}']);
      } finally {
        await transport.close();
        if (activeServer) await closeUnix(activeServer, socketPath);
        else rmSync(socketPath, { force: true });
      }
    });

    test('idempotent calls retry UNIX_DELIVERY_UNCERTAIN when the socket drops before headers; non-idempotent POST does not', async () => {
      const socketPath = nextUnixSocketPath();
      const hitsByPath = new Map<string, number>();
      const bodies: string[] = [];
      const unixServer = createNetServer((socket) => {
        socket.once('data', (chunk) => {
          const raw = chunk.toString('utf8');
          const [head = '', body = ''] = raw.split('\r\n\r\n');
          const [method, path = ''] = (head.split('\r\n')[0] ?? '').split(' ');
          const count = (hitsByPath.get(path) ?? 0) + 1;
          hitsByPath.set(path, count);
          if (count === 1) {
            socket.end();
            return;
          }
          if (body) bodies.push(body);
          const responseBody = method === 'HEAD' ? '' : '{"ok":true}';
          socket.end(
            `HTTP/1.1 200 OK\r\ncontent-type: application/json\r\ncontent-length: ${responseBody.length}\r\nconnection: close\r\n\r\n${responseBody}`,
          );
        });
      });
      await listenUnix(unixServer, socketPath);
      const transport = createUnixClientTransport({ socketPath });
      const firstErrors = new Map<string, unknown>();
      const spyingFetch: ClientFetch = async (input, init) => {
        try {
          return await transport.fetch(input, init);
        } catch (error) {
          const url = input instanceof Request ? input.url : String(input);
          const path = new URL(url).pathname;
          if (!firstErrors.has(path)) firstErrors.set(path, error);
          throw error;
        }
      };
      try {
        const client = makeClient(spyingFetch);
        expect(await client.read()).toEqual({ ok: true });
        await client.peek();
        expect(await client.put({ value: 'after-drop' })).toEqual({ ok: true });
        expect(hitsByPath.get('/host/read')).toBe(2);
        expect(hitsByPath.get('/host/peek')).toBe(2);
        expect(hitsByPath.get('/host/put')).toBe(2);
        expect(bodies).toEqual(['{"value":"after-drop"}']);
        for (const path of ['/host/read', '/host/peek', '/host/put']) {
          expect(firstErrors.get(path)).toMatchObject({
            code: 'UNIX_DELIVERY_UNCERTAIN',
            delivery: 'possibly-dispatched',
          });
        }

        const appendError = await rejectedApiError(client.append({ value: 'once' }));
        expect(appendError.cause).toMatchObject({
          code: 'UNIX_DELIVERY_UNCERTAIN',
          delivery: 'possibly-dispatched',
        });
        expect(hitsByPath.get('/host/append')).toBe(1);

        const pinnedError = await rejectedApiError(client.pinnedRead());
        expect(pinnedError.cause).toMatchObject({
          code: 'UNIX_DELIVERY_UNCERTAIN',
          delivery: 'possibly-dispatched',
        });
        expect(hitsByPath.get('/host/pinned-read')).toBe(1);
      } finally {
        await transport.close();
        await closeUnix(unixServer, socketPath);
      }
    });

    test('UNIX_RESPONSE_TOO_LARGE is never retried, even for idempotent GET and POST', async () => {
      const socketPath = nextUnixSocketPath();
      let hits = 0;
      const unixServer = createNetServer((socket) => {
        socket.once('data', () => {
          hits += 1;
          const body = JSON.stringify({ ok: true, padding: 'exceeds-limit' });
          socket.end(
            `HTTP/1.1 200 OK\r\ncontent-type: application/json\r\ncontent-length: ${body.length}\r\nconnection: close\r\n\r\n${body}`,
          );
        });
      });
      await listenUnix(unixServer, socketPath);
      const transport = createUnixClientTransport({ socketPath, maxResponseBytes: 8 });
      try {
        const client = makeClient(transport.fetch);

        hits = 0;
        const readError = await rejectedApiError(client.read());
        expect(readError.cause).toMatchObject({
          code: 'UNIX_RESPONSE_TOO_LARGE',
          delivery: 'response-received',
        });
        expect(hits).toBe(1);

        hits = 0;
        const putError = await rejectedApiError(client.put({ value: 'v' }));
        expect(putError.cause).toMatchObject({
          code: 'UNIX_RESPONSE_TOO_LARGE',
          delivery: 'response-received',
        });
        expect(hits).toBe(1);
      } finally {
        await transport.close();
        await closeUnix(unixServer, socketPath);
      }
    });

    test('headers overflow, malformed response, header timeout, request overflow and closed transport are never retried', async () => {
      // 1. UNIX_HEADERS_TOO_LARGE (response-received)
      {
        const socketPath = nextUnixSocketPath();
        let hits = 0;
        const unixServer = createNetServer((socket) => {
          socket.once('data', () => {
            hits += 1;
            socket.end(
              `HTTP/1.1 200 OK\r\nx-big: ${'a'.repeat(256)}\r\ncontent-length: 11\r\nconnection: close\r\n\r\n{"ok":true}`,
            );
          });
        });
        await listenUnix(unixServer, socketPath);
        const transport = createUnixClientTransport({ socketPath, maxHeaderBytes: 64 });
        try {
          const error = await rejectedApiError(makeClient(transport.fetch).read());
          expect(error.cause).toMatchObject({
            code: 'UNIX_HEADERS_TOO_LARGE',
            delivery: 'response-received',
          });
          expect(hits).toBe(1);
        } finally {
          await transport.close();
          await closeUnix(unixServer, socketPath);
        }
      }

      // 2. UNIX_RESPONSE_ABORTED (malformed status line, response-received)
      {
        const socketPath = nextUnixSocketPath();
        let hits = 0;
        const unixServer = createNetServer((socket) => {
          socket.once('data', () => {
            hits += 1;
            socket.end('NOT-HTTP\r\n\r\n');
          });
        });
        await listenUnix(unixServer, socketPath);
        const transport = createUnixClientTransport({ socketPath });
        try {
          const error = await rejectedApiError(makeClient(transport.fetch).read());
          expect(error.cause).toMatchObject({
            code: 'UNIX_RESPONSE_ABORTED',
            delivery: 'response-received',
          });
          expect(hits).toBe(1);
        } finally {
          await transport.close();
          await closeUnix(unixServer, socketPath);
        }
      }

      // 3. UNIX_HEADERS_TIMEOUT (hanging server, never retried like TimeoutError)
      {
        const socketPath = nextUnixSocketPath();
        let hits = 0;
        const sockets: Array<{ destroy(): void }> = [];
        const unixServer = createNetServer((socket) => {
          sockets.push(socket);
          socket.once('data', () => {
            hits += 1;
          });
        });
        await listenUnix(unixServer, socketPath);
        const transport = createUnixClientTransport({ socketPath, headersTimeoutMs: 25 });
        try {
          const error = await rejectedApiError(makeClient(transport.fetch).read());
          expect(error.cause).toMatchObject({
            code: 'UNIX_HEADERS_TIMEOUT',
            delivery: 'possibly-dispatched',
          });
          expect(hits).toBe(1);
        } finally {
          for (const socket of sockets) socket.destroy();
          await transport.close();
          await closeUnix(unixServer, socketPath);
        }
      }

      // 4. UNIX_REQUEST_TOO_LARGE and UNIX_CLIENT_CLOSED (deterministic local refusals)
      {
        const socketPath = nextUnixSocketPath();
        const transport = createUnixClientTransport({ socketPath, maxRequestBytes: 4 });
        let calls = 0;
        const countingFetch: ClientFetch = (input, init) => {
          calls += 1;
          return transport.fetch(input, init);
        };
        try {
          const oversizedError = await rejectedApiError(
            makeClient(countingFetch).put({ value: 'too-large-body' }),
          );
          expect(oversizedError.cause).toMatchObject({
            code: 'UNIX_REQUEST_TOO_LARGE',
            delivery: 'not-dispatched',
          });
          expect(calls).toBe(1);

          await transport.close();
          calls = 0;
          const closedError = await rejectedApiError(makeClient(countingFetch).read());
          expect(closedError.cause).toMatchObject({
            code: 'UNIX_CLIENT_CLOSED',
            delivery: 'not-dispatched',
          });
          expect(calls).toBe(1);
        } finally {
          await transport.close();
          rmSync(socketPath, { force: true });
        }
      }
    });

    test('exhaustive unix error code and delivery matrix only retries pre-response no-answer failures', async () => {
      const matrix = {
        UNIX_CONNECT_FAILED: [
          { delivery: 'not-dispatched', shouldRetry: true },
          { delivery: 'response-received', shouldRetry: false },
        ],
        UNIX_DELIVERY_UNCERTAIN: [
          { delivery: 'possibly-dispatched', shouldRetry: true },
          { delivery: 'response-received', shouldRetry: false },
        ],
        UNIX_RESPONSE_TOO_LARGE: [{ delivery: 'response-received', shouldRetry: false }],
        UNIX_HEADERS_TOO_LARGE: [{ delivery: 'response-received', shouldRetry: false }],
        UNIX_REDIRECT_REFUSED: [{ delivery: 'response-received', shouldRetry: false }],
        UNIX_RESPONSE_ABORTED: [{ delivery: 'response-received', shouldRetry: false }],
        UNIX_HEADERS_TIMEOUT: [{ delivery: 'possibly-dispatched', shouldRetry: false }],
        UNIX_REQUEST_TOO_LARGE: [{ delivery: 'not-dispatched', shouldRetry: false }],
        UNIX_CLIENT_CLOSED: [
          { delivery: 'not-dispatched', shouldRetry: false },
          { delivery: 'possibly-dispatched', shouldRetry: false },
        ],
        UNIX_CONNECTION_LIMIT: [{ delivery: 'not-dispatched', shouldRetry: false }],
        UNIX_TARGET_REFUSED: [{ delivery: 'not-dispatched', shouldRetry: false }],
      } satisfies Record<
        UnixClientTransportErrorCode,
        ReadonlyArray<{ delivery: UnixClientDeliveryState; shouldRetry: boolean }>
      >;

      for (const [code, entries] of typedEntries(matrix)) {
        for (const entry of entries) {
          let attempts = 0;
          const mockFetch: ClientFetch = async () => {
            attempts += 1;
            if (attempts === 1) {
              throw new UnixClientTransportError(
                code,
                `${code} (${entry.delivery})`,
                entry.delivery,
              );
            }
            return new Response('{"ok":true}', {
              status: 200,
              headers: { 'content-type': 'application/json' },
            });
          };
          const client = makeClient(mockFetch);
          if (entry.shouldRetry) {
            expect(await client.read()).toEqual({ ok: true });
            expect(attempts).toBe(2);
          } else {
            const error = await rejectedApiError(client.read());
            expect(error.cause).toMatchObject({
              code,
              delivery: entry.delivery,
            });
            expect(attempts).toBe(1);
          }
        }
      }
    });
  },
);

test('unix error classifier is own-property-only and never invokes accessors', () => {
  const connectFailed = new UnixClientTransportError(
    'UNIX_CONNECT_FAILED',
    'connect failed',
    'not-dispatched',
  );
  expect(shouldRetryBunNetworkError(connectFailed)).toBe(true);
  expect(
    shouldRetryBunNetworkError(
      new UnixClientTransportError(
        'UNIX_DELIVERY_UNCERTAIN',
        'dropped before headers',
        'possibly-dispatched',
      ),
    ),
  ).toBe(true);
  expect(
    shouldRetryBunNetworkError(
      new UnixClientTransportError(
        'UNIX_RESPONSE_TOO_LARGE',
        'body too large',
        'response-received',
      ),
    ),
  ).toBe(false);

  const inherited = Object.create(connectFailed);
  expect(shouldRetryBunNetworkError(inherited)).toBeUndefined();

  let getterCalled = false;
  const spoofed = new Error('spoofed');
  Object.defineProperty(spoofed, 'name', { value: 'UnixClientTransportError' });
  Object.defineProperty(spoofed, 'code', {
    get() {
      getterCalled = true;
      return 'UNIX_CONNECT_FAILED';
    },
  });
  Object.defineProperty(spoofed, 'delivery', { value: 'not-dispatched' });
  expect(shouldRetryBunNetworkError(spoofed)).toBe(false);
  expect(getterCalled).toBe(false);
});

test('ky clears the previous attempt failure before retrying, so a later body abort does not inherit it', async () => {
  let attempts = 0;
  const bodyStarted = Promise.withResolvers<void>();
  const firstFailure = new UnixClientTransportError(
    'UNIX_CONNECT_FAILED',
    'first attempt failed',
    'not-dispatched',
  );
  const transportFetch: ClientFetch = async (_input, init) => {
    attempts += 1;
    if (attempts === 1) throw firstFailure;
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new TextEncoder().encode('{"ok":'));
        bodyStarted.resolve();
        init?.signal?.addEventListener(
          'abort',
          () => controller.error(new DOMException('body read aborted', 'AbortError')),
          { once: true },
        );
      },
    });
    return new Response(body, {
      status: 200,
      headers: { 'content-type': 'application/json' },
    });
  };

  const client = createClient(
    host,
    createHttpClient({ baseUrl: 'http://local-host', fetch: transportFetch }),
  );
  const controller = new AbortController();
  const pending = client.read.withOptions({ signal: controller.signal });
  await bodyStarted.promise;
  controller.abort();
  const error = await rejectedApiError(pending);
  expect(attempts).toBe(2);
  expect(error.code).toBe('REQUEST_ABORTED');
  expect(error.cause).not.toBe(firstFailure);
  expect(error.cause).not.toBeInstanceOf(UnixClientTransportError);
});

const NodeProbeResultSchema = z.object({
  malformed: z.record(
    z.enum(['fetch', 'ky']),
    z.object({
      hits: z.number(),
      code: z.string().optional(),
      delivery: z.string().optional(),
    }),
  ),
  inFlightClose: z.record(
    z.enum(['fetch', 'ky']),
    z.object({
      hits: z.number(),
      code: z.string().optional(),
      delivery: z.string().optional(),
    }),
  ),
});

test('Node lane classifies HPE_* malformed HTTP as UNIX_RESPONSE_ABORTED and in-flight close as UNIX_CLIENT_CLOSED without retrying', async () => {
  const node = Bun.which('node');
  if (!node) throw new Error('Node is required for the Node unix transport lane check');
  const root = mkdtempSync(join(tmpdir(), 'sk-node-unix-replay-'));
  try {
    const source = join(root, 'probe.ts');
    const zodUrl = fileURLToPath(import.meta.resolve('zod'));
    const clientUrl = fileURLToPath(new URL('../src/browser/client.ts', import.meta.url));
    const httpUrl = fileURLToPath(new URL('../src/browser/http.ts', import.meta.url));
    const contractUrl = fileURLToPath(
      new URL('../src/entrypoints/contract.ts', import.meta.url),
    );
    const unixUrl = fileURLToPath(new URL('../src/server/unix-client.ts', import.meta.url));
    writeFileSync(
      source,
      `
import { rmSync } from 'node:fs';
import { createServer as createNetServer } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { z } from ${JSON.stringify(zodUrl)};
import { createClient } from ${JSON.stringify(clientUrl)};
import { createHttpClient } from ${JSON.stringify(httpUrl)};
import { defineContract } from ${JSON.stringify(contractUrl)};
import { createUnixClientTransport } from ${JSON.stringify(unixUrl)};

const contract = defineContract(
  { prefix: 'host' },
  { read: { method: 'GET', path: '/read', desc: 'read', output: z.object({ ok: z.literal(true) }) } },
);

let seq = 0;
const nextSock = () => join(${JSON.stringify(root)}, \`s-\${++seq}.sock\`);
const listen = (s: ReturnType<typeof createNetServer>, p: string) =>
  new Promise<void>((res, rej) => { s.once('error', rej); s.listen(p, () => { s.off('error', rej); res(); }); });
const closeNet = (s: ReturnType<typeof createNetServer>, p: string) =>
  new Promise<void>((res) => s.close(() => { rmSync(p, { force: true }); res(); }));

const makers = {
  fetch: (f: typeof fetch) => createClient(contract, { baseUrl: 'http://local-host', fetch: f }),
  ky: (f: typeof fetch) => createClient(contract, createHttpClient({ baseUrl: 'http://local-host', fetch: f })),
};

async function runMalformed(kind: 'fetch' | 'ky') {
  const path = nextSock();
  let hits = 0;
  const server = createNetServer((socket) => {
    socket.once('data', () => {
      hits += 1;
      socket.end('NOT-HTTP\\r\\n\\r\\n');
    });
  });
  await listen(server, path);
  const transport = createUnixClientTransport({ socketPath: path });
  try {
    await makers[kind](transport.fetch).read();
    throw new Error('Expected malformed HTTP to reject');
  } catch (error: unknown) {
    const cause = error && typeof error === 'object' && 'cause' in error ? error.cause : undefined;
    const code = cause && typeof cause === 'object' && 'code' in cause ? String(cause.code) : undefined;
    const delivery = cause && typeof cause === 'object' && 'delivery' in cause ? String(cause.delivery) : undefined;
    return { hits, code, delivery };
  } finally {
    await transport.close();
    await closeNet(server, path);
  }
}

async function runInFlightClose(kind: 'fetch' | 'ky') {
  const path = nextSock();
  let hits = 0;
  const sockets: Array<{ destroy(): void }> = [];
  let onData: (() => void) | undefined;
  const received = new Promise<void>((res) => { onData = res; });
  const server = createNetServer((socket) => {
    sockets.push(socket);
    socket.once('data', () => {
      hits += 1;
      onData?.();
    });
  });
  await listen(server, path);
  const transport = createUnixClientTransport({ socketPath: path });
  try {
    const call = makers[kind](transport.fetch).read();
    await received;
    await transport.close();
    await call;
    throw new Error('Expected in-flight close to reject');
  } catch (error: unknown) {
    const cause = error && typeof error === 'object' && 'cause' in error ? error.cause : undefined;
    const code = cause && typeof cause === 'object' && 'code' in cause ? String(cause.code) : undefined;
    const delivery = cause && typeof cause === 'object' && 'delivery' in cause ? String(cause.delivery) : undefined;
    return { hits, code, delivery };
  } finally {
    for (const s of sockets) s.destroy();
    await transport.close();
    await closeNet(server, path);
  }
}

const out = {
  malformed: { fetch: await runMalformed('fetch'), ky: await runMalformed('ky') },
  inFlightClose: { fetch: await runInFlightClose('fetch'), ky: await runInFlightClose('ky') },
};
console.log(JSON.stringify(out));
`,
    );
    const built = await Bun.build({ entrypoints: [source], outdir: root, target: 'node' });
    expect(built.success).toBe(true);
    const entry = built.outputs[0];
    if (!entry) throw new Error('Missing bundled Node probe');
    const child = Bun.spawn([node, entry.path], { stdout: 'pipe', stderr: 'pipe' });
    trackProcess(child.pid);
    const timer = setTimeout(() => child.kill('SIGKILL'), 15_000);
    const [exitCode, stdout, stderr] = await Promise.all([
      child.exited,
      new Response(child.stdout).text(),
      new Response(child.stderr).text(),
    ]).finally(() => clearTimeout(timer));
    expect(exitCode, stderr).toBe(0);
    const result = NodeProbeResultSchema.parse(JSON.parse(stdout));
    expect(result.malformed).toEqual({
      fetch: { hits: 1, code: 'UNIX_RESPONSE_ABORTED', delivery: 'response-received' },
      ky: { hits: 1, code: 'UNIX_RESPONSE_ABORTED', delivery: 'response-received' },
    });
    expect(result.inFlightClose).toEqual({
      fetch: { hits: 1, code: 'UNIX_CLIENT_CLOSED', delivery: 'possibly-dispatched' },
      ky: { hits: 1, code: 'UNIX_CLIENT_CLOSED', delivery: 'possibly-dispatched' },
    });
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
