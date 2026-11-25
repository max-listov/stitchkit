/**
 * A host serves its own machine's windows, and nobody else.
 *
 * Loopback keeps other machines out but not a web page on the same machine: it
 * can call `http://127.0.0.1:<port>` and open a WebSocket there, and a
 * DNS-rebinding page reaches it under an attacker's host name. The guard
 * refuses a foreign `Host`, a foreign `Origin` and a missing or wrong secret,
 * on every route and on the Socket.IO handshake, through the real server.
 */
import { afterAll, describe, expect, test } from 'bun:test';
import { z } from 'zod';
import { createSocketIOClient } from '../src/browser/socket-io';
import { defineContract } from '../src/entrypoints/contract';
import { secretsEqual } from '../src/internal/secret-equal';
import { createServer } from '../src/server/bun';
import { createHandler } from '../src/server/create';
import { implement } from '../src/server/implement';
import { createLocalHostGuard } from '../src/server/local-host';
import { createSocketIOServer } from '../src/server/socket-io';

/** A port in a `Host` header only; nothing listens on it. */
const HOST_PORT = 4100;
const secret = 'a-host-secret-of-32-characters!!';
const guard = createLocalHostGuard({ secret, origins: ['tauri://localhost'] });

const request = (headers: Record<string, string>) =>
  new Request(`http://127.0.0.1:${HOST_PORT}/records`, { headers });

describe('the rules', () => {
  test('a loopback host with the secret is served, with or without an allowed origin', () => {
    for (const host of [
      `127.0.0.1:${HOST_PORT}`,
      `localhost:${HOST_PORT}`,
      'localhost',
      `[::1]:${HOST_PORT}`,
    ]) {
      expect(
        guard.check(request({ host, authorization: `Bearer ${secret}` })),
      ).toBeUndefined();
    }
    expect(
      guard.check(
        request({
          host: 'localhost',
          origin: 'tauri://localhost',
          authorization: `Bearer ${secret}`,
        }),
      ),
    ).toBeUndefined();
    // The scheme is case-insensitive; the secret is not.
    expect(
      guard.check(request({ host: 'localhost', authorization: `bearer ${secret}` })),
    ).toBeUndefined();
    expect(
      guard.check(
        request({ host: 'localhost', authorization: `Bearer ${secret.toUpperCase()}` }),
      ),
    ).toBe('secret-mismatch');
  });

  test('a rebinding host name, a foreign origin and a wrong secret are each refused by name', () => {
    expect(
      guard.check(
        request({ host: `attacker.example:${HOST_PORT}`, authorization: `Bearer ${secret}` }),
      ),
    ).toBe('host-not-loopback');
    expect(guard.check(request({ authorization: `Bearer ${secret}` }))).toBe(
      'host-not-loopback',
    );
    expect(
      guard.check(
        request({
          host: 'localhost',
          origin: 'https://site.example',
          authorization: `Bearer ${secret}`,
        }),
      ),
    ).toBe('origin-not-allowed');
    for (const authorization of [
      '',
      `Bearer ${secret}x`,
      `Bearer ${secret.slice(0, -1)}`,
      secret,
    ])
      expect(guard.check(request({ host: 'localhost', authorization }))).toBe(
        'secret-mismatch',
      );
  });

  test('a short secret is refused when the guard is created', () => {
    expect(() => createLocalHostGuard({ secret: 'short', origins: [] })).toThrow(
      'createLocalHostGuard requires a secret of at least 16 characters',
    );
  });

  test('secrets compare equal only when they are equal, whatever their lengths', () => {
    expect(secretsEqual(secret, secret)).toBe(true);
    expect(secretsEqual(`${secret}x`, secret)).toBe(false);
    expect(secretsEqual(secret.slice(0, -1), secret)).toBe(false);
    expect(secretsEqual('', secret)).toBe(false);
    // A tail of NUL characters is still a different secret.
    expect(secretsEqual('abc', 'abc\u0000')).toBe(false);
    expect(secretsEqual('', '')).toBe(true);
  });
});

const records = defineContract(
  { prefix: 'records', scope: 'host' },
  {
    list: {
      method: 'GET',
      path: '/',
      desc: 'List records',
      output: z.object({ count: z.int() }),
    },
  },
);
const socket = await createSocketIOServer({
  allowRequest: guard.allowRequest,
  handshake: guard.handshake,
  cors: guard.cors,
});
const server = createServer({
  port: 0,
  hostname: '127.0.0.1',
  cors: guard.cors,
  services: [implement(records, { list: () => ({ count: 3 }) })],
  hooks: { onRequest: (incoming) => guard.onRequest(incoming) },
  socket,
});
const base = `http://127.0.0.1:${server.port}`;
afterAll(() => server.shutdown({ gracePeriodMs: 0 }));

describe('through the real server', () => {
  test('every route answers only a window with the secret, in the framework error envelope', async () => {
    const served = await fetch(`${base}/records`, {
      headers: { authorization: `Bearer ${secret}` },
    });
    expect(await served.json()).toEqual({ count: 3 });
    const refused = await fetch(`${base}/records`);
    expect(refused.status).toBe(401);
    expect(((await refused.json()) as { error: { code: string } }).error.code).toBe(
      'UNAUTHORIZED',
    );
    const foreign = await fetch(`${base}/records`, {
      headers: { authorization: `Bearer ${secret}`, origin: 'https://site.example' },
    });
    expect(foreign.status).toBe(403);
  });

  test('a window in a webview gets through its preflight and can read the answer; a foreign page cannot', async () => {
    const preflight = await fetch(`${base}/records`, {
      method: 'OPTIONS',
      headers: {
        origin: 'tauri://localhost',
        'access-control-request-method': 'GET',
        'access-control-request-headers': 'authorization',
      },
    });
    expect(preflight.status).toBe(204);
    expect(preflight.headers.get('access-control-allow-origin')).toBe('tauri://localhost');
    expect(preflight.headers.get('access-control-allow-headers')).toContain('Authorization');
    const answered = await fetch(`${base}/records`, {
      headers: { origin: 'tauri://localhost', authorization: `Bearer ${secret}` },
    });
    expect(answered.status).toBe(200);
    expect(answered.headers.get('access-control-allow-origin')).toBe('tauri://localhost');
    const foreign = await fetch(`${base}/records`, {
      method: 'OPTIONS',
      headers: { origin: 'https://site.example', 'access-control-request-method': 'GET' },
    });
    expect(foreign.headers.get('access-control-allow-origin')).toBeNull();
  });

  test('the Socket.IO handshake takes the secret, and a wrong one is refused for good', async () => {
    const connect = (presented: string) => {
      const errors: { terminal: boolean }[] = [];
      const client = createSocketIOClient<Record<string, never>, Record<string, never>>({
        url: base,
        transports: ['websocket'],
        auth: { secret: presented },
        onConnectError: (error) => errors.push(error),
      });
      return { client, errors };
    };
    const window = connect(secret);
    window.client.connect();
    await new Promise<void>((resolve) => {
      const off = window.client.onConnectionChange((connected) => {
        if (connected) {
          off();
          resolve();
        }
      });
    });
    window.client.disconnect();

    const stranger = connect('a-different-secret-of-32-chars!!');
    stranger.client.connect();
    while (stranger.errors.length === 0) await Bun.sleep(10);
    expect(stranger.errors[0]?.terminal).toBe(true);
    expect(stranger.client.connected).toBe(false);
  });

  test('a page from a foreign origin cannot open the socket at all', async () => {
    const policy = await guard.allowRequest(
      new Request(`${base}/socket.io/?EIO=4&transport=websocket`, {
        headers: { host: `127.0.0.1:${server.port}`, origin: 'https://site.example' },
      }),
    );
    expect(policy).toBe(false);
    const allowed = await guard.allowRequest(
      new Request(`${base}/socket.io/?EIO=4&transport=websocket`, {
        headers: { host: `127.0.0.1:${server.port}` },
      }),
    );
    expect(allowed).toBe(true);
  });

  test('an empty origins list disables CORS cleanly across createHandler, createServer and createSocketIOServer', async () => {
    expect(guard.cors).toEqual({ origin: ['tauri://localhost'], credentials: false });

    const nativeGuard = createLocalHostGuard({ secret, origins: [] });

    const handler = createHandler({
      cors: nativeGuard.cors,
      services: [implement(records, { list: () => ({ count: 3 }) })],
      hooks: { onRequest: (incoming) => nativeGuard.onRequest(incoming) },
    });
    expect(nativeGuard.cors).toBeUndefined();
    const ok = await handler(
      new Request(`http://127.0.0.1:${HOST_PORT}/records`, {
        headers: { host: `127.0.0.1:${HOST_PORT}`, authorization: `Bearer ${secret}` },
      }),
    );
    expect(ok.status).toBe(200);
    expect(await ok.json()).toEqual({ count: 3 });
    expect(ok.headers.get('access-control-allow-origin')).toBeNull();

    const rejectedOrigin = await handler(
      new Request(`http://127.0.0.1:${HOST_PORT}/records`, {
        headers: {
          host: `127.0.0.1:${HOST_PORT}`,
          origin: 'tauri://localhost',
          authorization: `Bearer ${secret}`,
        },
      }),
    );
    expect(rejectedOrigin.status).toBe(403);
    expect(rejectedOrigin.headers.get('access-control-allow-origin')).toBeNull();

    const nativeSocket = await createSocketIOServer({
      allowRequest: nativeGuard.allowRequest,
      handshake: nativeGuard.handshake,
      cors: nativeGuard.cors,
    });
    const nativeServer = createServer({
      port: 0,
      hostname: '127.0.0.1',
      cors: nativeGuard.cors,
      services: [implement(records, { list: () => ({ count: 3 }) })],
      hooks: { onRequest: (incoming) => nativeGuard.onRequest(incoming) },
      socket: nativeSocket,
    });
    try {
      const nativeBase = `http://127.0.0.1:${nativeServer.port}`;
      const served = await fetch(`${nativeBase}/records`, {
        headers: { authorization: `Bearer ${secret}` },
      });
      expect(served.status).toBe(200);
      expect(await served.json()).toEqual({ count: 3 });
      expect(served.headers.get('access-control-allow-origin')).toBeNull();

      const foreignPoll = await fetch(`${nativeBase}/socket.io/?EIO=4&transport=polling`, {
        headers: { origin: 'https://site.example' },
      });
      expect(foreignPoll.status).toBe(403);
      expect(foreignPoll.headers.get('access-control-allow-origin')).toBeNull();

      const client = createSocketIOClient<Record<string, never>, Record<string, never>>({
        url: nativeBase,
        transports: ['websocket'],
        auth: { secret },
      });
      try {
        client.connect();
        await new Promise<void>((resolve) => {
          const off = client.onConnectionChange((connected) => {
            if (connected) {
              off();
              resolve();
            }
          });
        });
        expect(client.connected).toBe(true);
      } finally {
        client.disconnect();
      }
    } finally {
      await nativeServer.shutdown({ gracePeriodMs: 0 });
    }
  });
});
