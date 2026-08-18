import { afterAll, describe, expect, test } from 'bun:test';
import { existsSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { z } from 'zod';
import { createClient, createHttpClient } from '../src';
import { ApiError } from '../src/browser/http';
import { defineContract } from '../src/contract';
import { createServer, implement } from '../src/server';

// sun_path is ~104-108 bytes — keep socket paths short and unique.
let socketCounter = 0;
function socketPath(): string {
  socketCounter += 1;
  return join(tmpdir(), `sk-${process.pid}-${socketCounter}.sock`);
}

const echo = defineContract(
  { prefix: 'echo' },
  {
    ping: {
      method: 'GET',
      path: '/ping',
      desc: 'Ping over the socket',
      output: z.object({ ok: z.boolean() }),
    },
    say: {
      method: 'POST',
      path: '/say',
      desc: 'Echo a message back',
      input: z.object({ message: z.string() }),
      output: z.object({ echoed: z.string() }),
    },
    boom: {
      method: 'GET',
      path: '/boom',
      desc: 'Always fails',
      output: z.object({ never: z.boolean() }),
    },
  },
);

const echoService = implement(echo, {
  ping: () => ({ ok: true }),
  say: ({ input }) => ({ echoed: input.message }),
  boom: () => {
    throw new Error('boom');
  },
});

const cleanups: Array<() => Promise<void> | void> = [];
afterAll(async () => {
  for (const cleanup of cleanups.reverse()) await cleanup();
});

function serveUnix(unix: Parameters<typeof createServer>[0]['unix']) {
  const server = createServer({ unix, services: [echoService] });
  cleanups.push(() => server.shutdown({ gracePeriodMs: 1_000 }).then(() => undefined));
  return server;
}

describe('createServer({ unix })', () => {
  test('serves the typed client end-to-end over a unix socket, POST body included', async () => {
    const path = socketPath();
    const server = serveUnix(path);
    expect(server.url).toBe(`unix://${path}`);
    expect(server.port).toBe(0);

    const client = createClient(
      echo,
      createHttpClient({ baseUrl: 'http://localhost', unix: path, retry: { limit: 0 } }),
    );
    expect(await client.ping()).toEqual({ ok: true });
    expect(await client.say({ message: 'through the door' })).toEqual({
      echoed: 'through the door',
    });
  });

  test('delivers the stitchkit error envelope over the socket', async () => {
    const path = socketPath();
    serveUnix(path);
    const client = createClient(
      echo,
      createHttpClient({ baseUrl: 'http://localhost', unix: path, retry: { limit: 0 } }),
    );
    await expect(client.boom()).rejects.toMatchObject({ name: 'ApiError', status: 500 });
  });

  test('a missing socket file yields an ApiError, not a hang', async () => {
    const client = createHttpClient({
      baseUrl: 'http://localhost',
      unix: socketPath(),
      retry: { limit: 0 },
      timeout: 2_000,
    });
    await expect(client.get('/echo/ping')).rejects.toBeInstanceOf(ApiError);
  });

  test('rejects unix combined with port or hostname, and with the Socket.IO lifecycle', async () => {
    const path = socketPath();
    expect(() => createServer({ unix: path, port: 0, services: [echoService] })).toThrow(
      'mutually exclusive',
    );
    expect(() =>
      createServer({ unix: path, hostname: '127.0.0.1', services: [echoService] }),
    ).toThrow('mutually exclusive');

    const { createSocketIOServer } = await import('../src/server/socket-io');
    const socket = await createSocketIOServer({ cors: { origin: '*' } });
    expect(() => createServer({ unix: path, socket, services: [echoService] })).toThrow(
      'cannot listen on a unix socket',
    );
    await socket.close();
  });

  test('rejects an empty socket path instead of silently starting TCP', () => {
    expect(() => createServer({ unix: '', services: [echoService] })).toThrow(
      'non-empty socket path',
    );
    expect(() => createServer({ unix: { path: '' }, services: [echoService] })).toThrow(
      'non-empty socket path',
    );
  });

  test('transport retry through the unix seam stays materialized and still fails cleanly', async () => {
    const client = createHttpClient({
      baseUrl: 'http://localhost',
      unix: socketPath(),
      retry: { limit: 1 },
      timeout: 3_000,
    });
    await expect(client.get('/echo/ping')).rejects.toBeInstanceOf(ApiError);
  });

  test('applies the requested socket file mode', async () => {
    const path = socketPath();
    serveUnix({ path, mode: 0o600 });
    expect(statSync(path).mode & 0o777).toBe(0o600);
    const client = createClient(
      echo,
      createHttpClient({ baseUrl: 'http://localhost', unix: path, retry: { limit: 0 } }),
    );
    expect(await client.ping()).toEqual({ ok: true });
  });

  test('a clean shutdown removes the socket file — idle and with in-flight work', async () => {
    const idlePath = socketPath();
    const idle = createServer({ unix: idlePath, services: [echoService] });
    cleanups.push(() => idle.shutdown({ gracePeriodMs: 0 }).then(() => undefined));
    expect(existsSync(idlePath)).toBe(true);
    await idle.shutdown({ gracePeriodMs: 1_000 });
    expect(existsSync(idlePath)).toBe(false);

    const busyPath = socketPath();
    const started = Promise.withResolvers<void>();
    const release = Promise.withResolvers<void>();
    const slow = defineContract(
      { prefix: 'slow' },
      {
        wait: { method: 'GET', path: '/', desc: 'Wait for release', output: z.object({}) },
      },
    );
    const busy = createServer({
      unix: busyPath,
      services: [
        implement(slow, {
          async wait() {
            started.resolve();
            await release.promise;
            return {};
          },
        }),
      ],
    });
    cleanups.push(() => busy.shutdown({ gracePeriodMs: 0 }).then(() => undefined));
    const inFlight = fetch('http://localhost/slow', { unix: busyPath });
    await started.promise;
    const shutdown = busy.shutdown({ gracePeriodMs: 5_000 });
    release.resolve();
    expect((await inFlight).status).toBe(200);
    await shutdown;
    expect(existsSync(busyPath)).toBe(false);
  });

  test('reclaims a stale socket left by a SIGKILLed process', async () => {
    const path = socketPath();
    const holder = Bun.spawn({
      cmd: [process.execPath, join(import.meta.dir, 'fixtures/unix-socket-holder.ts')],
      env: { ...process.env, STITCHKIT_TEST_UNIX_PATH: path },
      stdout: 'pipe',
    });
    const reader = holder.stdout.getReader();
    await reader.read(); // 'holder-listening'
    holder.kill(9);
    await holder.exited;
    expect(existsSync(path)).toBe(true); // SIGKILL leaves the file behind

    const server = serveUnix(path);
    const client = createClient(
      echo,
      createHttpClient({ baseUrl: 'http://localhost', unix: path, retry: { limit: 0 } }),
    );
    expect(await client.ping()).toEqual({ ok: true });
    expect(server.url).toBe(`unix://${path}`);
  });

  test('refuses a path answered by a live listener and does not unlink it', async () => {
    const path = socketPath();
    serveUnix(path);
    expect(() => createServer({ unix: path, services: [echoService] })).toThrow(
      'already in use by a live listener',
    );
    expect(existsSync(path)).toBe(true);
    const client = createClient(
      echo,
      createHttpClient({ baseUrl: 'http://localhost', unix: path, retry: { limit: 0 } }),
    );
    expect(await client.ping()).toEqual({ ok: true }); // the live server survived
  });

  test('refuses a regular file at the socket path and does not unlink it', () => {
    const path = socketPath();
    writeFileSync(path, 'not a socket');
    cleanups.push(() => rmSync(path, { force: true }));
    expect(() => createServer({ unix: path, services: [echoService] })).toThrow(
      'is not a socket',
    );
    expect(existsSync(path)).toBe(true);
  });
});
