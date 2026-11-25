import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import {
  chmodSync,
  chownSync,
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { z } from 'zod';
import { ApiError } from '../src/browser/api-error';
import { createClient } from '../src/browser/client';
import { createHttpClient } from '../src/browser/http';
import type { ClientFetch } from '../src/browser/transport';
import { unauthorized } from '../src/contract/errors';
import type { RuntimeContext } from '../src/contract/runtime-context';
import { defineContract } from '../src/entrypoints/contract';
import {
  bindProcessSignals,
  createLocalHostGuard,
  createScopedImplement,
  createServer,
  createUnixClientTransport,
  type ProcessSignalName,
  type ShutdownOptions,
  type ShutdownResult,
  type ShutdownTarget,
  type SignalSource,
  UnixClientTransportError,
  type UnixClientTransportErrorCode,
} from '../src/entrypoints/server';
import { MAX_UNIX_SOCKET_PATH_BYTES } from '../src/internal/unix-socket';
import type { AuthorizationContext, MethodDef } from '../src/server/types';

const OwnerIdentitySchema = z.object({
  id: z.string(),
  role: z.literal('owner'),
});
type OwnerIdentity = z.infer<typeof OwnerIdentitySchema>;

const MACHINE_OWNER: OwnerIdentity = { id: 'local-session-owner', role: 'owner' };
const HOST_SECRET = 'host-unix-channel-secret-32-chars!';
const ALLOWED_ORIGIN = 'tauri://localhost';
const EVIL_ORIGIN = 'https://evil.example';

const itemsContract = defineContract(
  { prefix: 'items', scope: 'public' },
  {
    list: {
      method: 'GET',
      path: '/',
      desc: 'List items available to both window and local CLI',
      output: z.object({ items: z.array(z.string()) }),
    },
  },
);

const vaultContract = defineContract(
  { prefix: 'vault', scope: 'owner' },
  {
    whoami: {
      method: 'GET',
      path: '/whoami',
      desc: 'Return the owner identity attached to this channel',
      output: z.object({ owner: OwnerIdentitySchema }),
    },
  },
);

const implementScoped = createScopedImplement<{
  public: Record<string, never>;
  owner: { owner: OwnerIdentity };
}>();

const services = [
  implementScoped(itemsContract, {
    list: () => ({ items: ['alpha', 'beta'] }),
  }),
  implementScoped(vaultContract, {
    whoami: ({ owner }) => ({ owner }),
  }),
];

function createFakeSignalSource(): SignalSource & { emit(signal: ProcessSignalName): void } {
  const listeners = new Map<ProcessSignalName, Set<() => void>>();
  return {
    on(signal, handler) {
      let set = listeners.get(signal);
      if (!set) {
        set = new Set();
        listeners.set(signal, set);
      }
      set.add(handler);
    },
    off(signal, handler) {
      listeners.get(signal)?.delete(handler);
    },
    raiseDefault() {
      return true;
    },
    emit(signal) {
      for (const handler of [...(listeners.get(signal) ?? [])]) handler();
    },
  };
}

let root = '';
let counter = 0;

beforeAll(() => {
  root = mkdtempSync(join(tmpdir(), 'huc-'));
});

afterAll(() => {
  rmSync(root, { recursive: true, force: true });
});

function nextSocketPath(name?: string): string {
  counter += 1;
  return join(root, name ?? `s${counter}.sock`);
}

function makePathOfByteLength(dir: string, targetBytes: number): string {
  const prefix = `${dir}/`;
  const suffix = '.sock';
  const fillBytes = targetBytes - Buffer.byteLength(prefix) - Buffer.byteLength(suffix);
  if (fillBytes < 1)
    throw new Error(`Directory "${dir}" is too long for ${targetBytes} bytes`);
  const path = `${prefix}${'a'.repeat(fillBytes)}${suffix}`;
  if (Buffer.byteLength(path) !== targetBytes) {
    throw new Error(`Expected ${targetBytes} bytes, got ${Buffer.byteLength(path)}`);
  }
  return path;
}

async function expectUnixTransportError(
  promise: Promise<unknown>,
  code: UnixClientTransportErrorCode,
  message?: RegExp,
): Promise<UnixClientTransportError> {
  const error = await promise.then(
    () => undefined,
    (caught: unknown) => caught,
  );
  expect(error).toBeInstanceOf(UnixClientTransportError);
  if (!(error instanceof UnixClientTransportError)) {
    throw new Error(`Expected UnixClientTransportError, got ${String(error)}`);
  }
  expect(error.code).toBe(code);
  expect(error.delivery).toBe('not-dispatched');
  if (message) expect(error.message).toMatch(message);
  return error;
}

describe('host with loopback TCP window channel and unix socket channel', () => {
  test('serves identical results over guarded loopback and unguarded 0600 unix socket with composite shutdown', async () => {
    const guard = createLocalHostGuard({ secret: HOST_SECRET, origins: [ALLOWED_ORIGIN] });
    const auditLog: Array<{ operation: string; client: string | null }> = [];
    const scopePrefixes = { public: '/api', owner: '/api' } as const;

    const requireOwnerScope = (ctx: AuthorizationContext, endpoint: MethodDef): void => {
      if (endpoint.scope === 'owner' && !OwnerIdentitySchema.safeParse(ctx.owner).success) {
        unauthorized('Owner identity is required');
      }
    };

    const baseConfig = {
      services,
      scopePrefixes,
      logging: false as const,
      hooks: {
        afterHandle(ctx: RuntimeContext, result: unknown, endpoint: MethodDef) {
          auditLog.push({
            operation: `${endpoint.serviceName}.${endpoint.key}`,
            client: ctx.headers?.get('x-client-name') ?? null,
          });
          return result;
        },
      },
    };

    const socketPath = nextSocketPath('host.sock');
    const tcp = createServer({
      ...baseConfig,
      port: 0,
      hostname: '127.0.0.1',
      cors: guard.cors,
      hooks: {
        ...baseConfig.hooks,
        onRequest: (req) => guard.onRequest(req),
        authorize(ctx, endpoint) {
          ctx.owner = MACHINE_OWNER;
          requireOwnerScope(ctx, endpoint);
        },
      },
    });
    const unix = createServer({
      ...baseConfig,
      unix: { path: socketPath, mode: 0o600 },
      hooks: {
        ...baseConfig.hooks,
        authorize(ctx, endpoint) {
          ctx.owner = MACHINE_OWNER;
          requireOwnerScope(ctx, endpoint);
        },
      },
    });

    const transport = createUnixClientTransport({ socketPath });
    const compositeHost: ShutdownTarget<[ShutdownResult, ShutdownResult]> = {
      shutdown: (options?: ShutdownOptions) =>
        Promise.all([tcp.shutdown(options), unix.shutdown(options)]),
    };
    const signals = createFakeSignalSource();
    const binding = bindProcessSignals(compositeHost, {
      signals: ['SIGTERM'],
      signalSource: signals,
      shutdown: { gracePeriodMs: 1_000 },
    });

    try {
      expect(lstatSync(socketPath).mode & 0o777).toBe(0o600);

      // Same public operation: loopback with secret -> 200, without secret -> 401, evil Origin -> 403.
      const tcpOk = await fetch(`${tcp.url}/api/items`, {
        headers: { authorization: `Bearer ${HOST_SECRET}` },
      });
      expect(tcpOk.status).toBe(200);
      const tcpBody = await tcpOk.json();
      expect(tcpBody).toEqual({ items: ['alpha', 'beta'] });

      const tcpNoSecret = await fetch(`${tcp.url}/api/items`);
      expect(tcpNoSecret.status).toBe(401);

      const tcpEvilOrigin = await fetch(`${tcp.url}/api/items`, {
        headers: {
          authorization: `Bearer ${HOST_SECRET}`,
          origin: EVIL_ORIGIN,
        },
      });
      expect(tcpEvilOrigin.status).toBe(403);

      // Same operation over unix socket without secret -> 200 with identical body.
      const unixOk = await transport.fetch('http://local-app/api/items', {
        headers: { 'x-client-name': 'local-cli' },
      });
      expect(unixOk.status).toBe(200);
      expect(await unixOk.json()).toEqual(tcpBody);

      // Scoped owner endpoint on the same services array:
      // unix attaches machine owner unconditionally -> 200; TCP without secret -> 401; TCP with secret -> 200.
      const unixScoped = await transport.fetch('http://local-app/api/vault/whoami', {
        headers: { 'x-client-name': 'local-cli' },
      });
      expect(unixScoped.status).toBe(200);
      expect(await unixScoped.json()).toEqual({ owner: MACHINE_OWNER });

      const tcpScopedNoSecret = await fetch(`${tcp.url}/api/vault/whoami`);
      expect(tcpScopedNoSecret.status).toBe(401);

      const tcpScopedWithSecret = await fetch(`${tcp.url}/api/vault/whoami`, {
        headers: { authorization: `Bearer ${HOST_SECRET}` },
      });
      expect(tcpScopedWithSecret.status).toBe(200);
      expect(await tcpScopedWithSecret.json()).toEqual({ owner: MACHINE_OWNER });

      // Shared audit hook observed all 4 authorized calls across both listeners (refused 401/403 excluded).
      expect(auditLog).toHaveLength(4);
      expect(auditLog).toEqual([
        { operation: 'items.list', client: null },
        { operation: 'items.list', client: 'local-cli' },
        { operation: 'vault.whoami', client: 'local-cli' },
        { operation: 'vault.whoami', client: null },
      ]);
    } finally {
      await transport.close();
      signals.emit('SIGTERM');
      const results = await binding.promise;
      expect(results?.map((r) => r.outcome)).toEqual(['clean', 'clean']);
      binding.close();
    }

    expect(existsSync(socketPath)).toBe(false);
  });
});

describe('unix socket portable sun_path length ceiling (103 bytes)', () => {
  test('refuses paths over 103 UTF-8 bytes on both host and client, and accepts exactly 103 bytes', async () => {
    expect(MAX_UNIX_SOCKET_PATH_BYTES).toBe(103);

    const path104 = makePathOfByteLength(root, 104);
    expect(() => createServer({ unix: path104, services })).toThrow(
      /103.*shorter path|shorter path/i,
    );
    expect(() => createUnixClientTransport({ socketPath: path104 })).toThrow(
      /103.*shorter path|shorter path/i,
    );

    const path150 = makePathOfByteLength(root, 150);
    expect(() => createServer({ unix: path150, services })).toThrow(/103/);
    expect(() => createUnixClientTransport({ socketPath: path150 })).toThrow(/103/);

    // Multi-byte UTF-8: fewer than 103 UTF-16 code units, but 104+ UTF-8 bytes.
    const prefix = `${root}/`;
    const suffix = '.sock';
    const remaining = 104 - Buffer.byteLength(prefix) - Buffer.byteLength(suffix);
    const euroCount = Math.ceil(remaining / 3);
    const multibytePath = `${prefix}${'€'.repeat(euroCount)}${suffix}`;
    expect(multibytePath.length).toBeLessThanOrEqual(103);
    expect(Buffer.byteLength(multibytePath)).toBeGreaterThan(103);
    expect(() => createServer({ unix: multibytePath, services })).toThrow(/103/);
    expect(() => createUnixClientTransport({ socketPath: multibytePath })).toThrow(/103/);

    // Positive control: exactly 103 bytes binds and answers cleanly.
    const path103 = makePathOfByteLength(root, 103);
    const server = createServer({ unix: { path: path103, mode: 0o600 }, services });
    const transport = createUnixClientTransport({ socketPath: path103 });
    try {
      const response = await transport.fetch('http://local-app/items');
      expect(response.status).toBe(200);
      expect(await response.json()).toEqual({ items: ['alpha', 'beta'] });
    } finally {
      await transport.close();
      await server.shutdown({ gracePeriodMs: 1_000 });
    }
  });
});

describe('unix socket directory and owner checks', () => {
  test('refuses world-writable (0777) and group-writable (0770) directories on host and client without retrying', async () => {
    for (const badMode of [0o777, 0o770]) {
      const dir = join(root, `wide-${badMode.toString(8)}`);
      mkdirSync(dir);
      chmodSync(dir, badMode);
      const sock = join(dir, 'app.sock');

      expect(() => createServer({ unix: { path: sock, mode: 0o600 }, services })).toThrow(
        /writable by group or others/i,
      );

      // Even without a socket file on disk, an unsafe directory fails with UNIX_TARGET_REFUSED (not UNIX_CONNECT_FAILED).
      const absentInWide = createUnixClientTransport({ socketPath: sock });
      try {
        await expectUnixTransportError(
          absentInWide.fetch('http://local-app/items'),
          'UNIX_TARGET_REFUSED',
          /writable by group or others/i,
        );
      } finally {
        await absentInWide.close();
      }

      // Start a socket while dir is 0o700, then widen dir to badMode and confirm client refuses before connect.
      chmodSync(dir, 0o700);
      const server = createServer({ unix: { path: sock, mode: 0o600 }, services });
      const transport = createUnixClientTransport({ socketPath: sock });
      try {
        chmodSync(dir, badMode);
        await expectUnixTransportError(
          transport.fetch('http://local-app/items'),
          'UNIX_TARGET_REFUSED',
          /writable by group or others/i,
        );
      } finally {
        chmodSync(dir, 0o700);
        await transport.close();
        await server.shutdown({ gracePeriodMs: 1_000 });
      }
    }

    // Typed clients (bare-fetch and ky) must NOT retry UNIX_TARGET_REFUSED on idempotent GET.
    const wideDir = join(root, 'wide-no-retry');
    mkdirSync(wideDir);
    chmodSync(wideDir, 0o777);
    const transport = createUnixClientTransport({ socketPath: join(wideDir, 'app.sock') });
    try {
      for (const mode of ['fetch', 'ky'] as const) {
        let attempts = 0;
        const countedFetch: ClientFetch = (input, init) => {
          attempts += 1;
          return transport.fetch(input, init);
        };
        const client =
          mode === 'fetch'
            ? createClient(itemsContract, { baseUrl: 'http://local-app', fetch: countedFetch })
            : createClient(
                itemsContract,
                createHttpClient({ baseUrl: 'http://local-app', fetch: countedFetch }),
              );
        const caught = await client.list().then(
          () => undefined,
          (error: unknown) => error,
        );
        expect(caught).toBeInstanceOf(ApiError);
        expect(attempts).toBe(1);
        expect(caught instanceof ApiError ? caught.cause : undefined).toMatchObject({
          code: 'UNIX_TARGET_REFUSED',
          delivery: 'not-dispatched',
        });
      }
    } finally {
      await transport.close();
    }
  });

  test('refuses symlink dirs, symlink/regular-file targets, missing server dir, and ENOTDIR ancestors', async () => {
    // Missing parent directory on server refuses loudly.
    expect(() =>
      createServer({
        unix: { path: join(root, 'no-such-dir', 'app.sock'), mode: 0o600 },
        services,
      }),
    ).toThrow(/does not exist/i);

    const realDir = join(root, 'real-dir');
    mkdirSync(realDir, { mode: 0o700 });
    chmodSync(realDir, 0o700);
    const linkDir = join(root, 'link-dir');
    symlinkSync(realDir, linkDir);

    const viaLink = join(linkDir, 'app.sock');
    expect(() => createServer({ unix: { path: viaLink, mode: 0o600 }, services })).toThrow(
      /symlink/i,
    );

    const realSock = join(realDir, 'app.sock');
    const linkSock = join(realDir, 'link.sock');
    const regularFile = join(realDir, 'not-a-socket.txt');
    writeFileSync(regularFile, 'plain file');

    const server = createServer({ unix: { path: realSock, mode: 0o600 }, services });
    symlinkSync(realSock, linkSock);
    const linkDirTransport = createUnixClientTransport({ socketPath: viaLink });
    const linkSockTransport = createUnixClientTransport({ socketPath: linkSock });
    const fileTransport = createUnixClientTransport({ socketPath: regularFile });
    const enotdirTransport = createUnixClientTransport({
      socketPath: join(regularFile, 'sub', 'app.sock'),
    });
    try {
      await expectUnixTransportError(
        linkDirTransport.fetch('http://local-app/items'),
        'UNIX_TARGET_REFUSED',
        /symlink/i,
      );
      await expectUnixTransportError(
        linkSockTransport.fetch('http://local-app/items'),
        'UNIX_TARGET_REFUSED',
        /symlink/i,
      );
      await expectUnixTransportError(
        fileTransport.fetch('http://local-app/items'),
        'UNIX_TARGET_REFUSED',
        /not a unix socket/i,
      );
      const enotdirErr = await expectUnixTransportError(
        enotdirTransport.fetch('http://local-app/items'),
        'UNIX_TARGET_REFUSED',
        /ENOTDIR/,
      );
      expect(enotdirErr.cause).toBeDefined();
    } finally {
      await linkDirTransport.close();
      await linkSockTransport.close();
      await fileTransport.close();
      await enotdirTransport.close();
      rmSync(linkSock, { force: true });
      await server.shutdown({ gracePeriodMs: 1_000 });
    }
  });

  test.skipIf(typeof process.getuid !== 'function' || process.getuid() !== 0)(
    'refuses a socket and a parent directory owned by another uid',
    async () => {
      const nobody = 65534;
      const dir = join(root, 'foreign-sock-dir');
      mkdirSync(dir, { mode: 0o700 });
      chmodSync(dir, 0o700);
      const sock = join(dir, 'app.sock');
      const server = createServer({ unix: { path: sock, mode: 0o600 }, services });
      const transport = createUnixClientTransport({ socketPath: sock });
      try {
        chownSync(sock, nobody, nobody);
        await expectUnixTransportError(
          transport.fetch('http://local-app/items'),
          'UNIX_TARGET_REFUSED',
          /owned by uid/i,
        );
      } finally {
        chownSync(sock, 0, 0);
        await transport.close();
        await server.shutdown({ gracePeriodMs: 1_000 });
      }

      const foreignDir = join(root, 'foreign-dir');
      mkdirSync(foreignDir, { mode: 0o700 });
      chmodSync(foreignDir, 0o700);
      chownSync(foreignDir, nobody, nobody);
      try {
        const foreignSock = join(foreignDir, 'app.sock');
        expect(() =>
          createServer({ unix: { path: foreignSock, mode: 0o600 }, services }),
        ).toThrow(/owned by uid/i);
        const foreignTransport = createUnixClientTransport({ socketPath: foreignSock });
        try {
          await expectUnixTransportError(
            foreignTransport.fetch('http://local-app/items'),
            'UNIX_TARGET_REFUSED',
            /owned by uid/i,
          );
        } finally {
          await foreignTransport.close();
        }
      } finally {
        chownSync(foreignDir, 0, 0);
      }
    },
  );

  test('allows 0700 and 0755 directories of current uid, and maps missing socket to not-dispatched', async () => {
    for (const okMode of [0o700, 0o755]) {
      const dir = join(root, `ok-${okMode.toString(8)}`);
      mkdirSync(dir, { mode: okMode });
      chmodSync(dir, okMode);

      const livePath = join(dir, 'live.sock');
      const server = createServer({ unix: { path: livePath, mode: 0o600 }, services });
      const transport = createUnixClientTransport({ socketPath: livePath });
      try {
        const response = await transport.fetch('http://local-app/items');
        expect(response.status).toBe(200);
        expect(await response.json()).toEqual({ items: ['alpha', 'beta'] });
      } finally {
        await transport.close();
        await server.shutdown({ gracePeriodMs: 1_000 });
      }
    }

    // Missing socket in a valid 0700 directory and missing parent directory both yield UNIX_CONNECT_FAILED (not-dispatched).
    const missingTransport = createUnixClientTransport({
      socketPath: join(root, 'ok-700', 'missing.sock'),
    });
    const missingDirTransport = createUnixClientTransport({
      socketPath: join(root, 'does-not-exist-yet', 'app.sock'),
    });
    try {
      await expectUnixTransportError(
        missingTransport.fetch('http://local-app/items'),
        'UNIX_CONNECT_FAILED',
      );
      await expectUnixTransportError(
        missingDirTransport.fetch('http://local-app/items'),
        'UNIX_CONNECT_FAILED',
      );
    } finally {
      await missingTransport.close();
      await missingDirTransport.close();
    }
  });
});
