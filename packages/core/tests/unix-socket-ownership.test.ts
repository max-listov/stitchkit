import { afterAll, beforeAll, describe, expect, spyOn, test } from 'bun:test';
import {
  chmodSync,
  existsSync,
  linkSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  rmSync,
  symlinkSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { z } from 'zod';
import { defineContract } from '../src/entrypoints/contract';
import { createServer, implement } from '../src/entrypoints/server';
import { recordOwner } from '../src/internal/exclusive-lock-owner';
import { machineIdentitySync } from '../src/internal/process-identity';
import { readProcessInstanceSync } from '../src/internal/process-instance';
import {
  assertUnixSocketPathLength,
  chooseStagingSocketName,
  publishStagedUnixSocket,
} from '../src/internal/unix-socket';
import { withUnixSocketLockSync } from '../src/internal/unix-socket-lock';
import { reapAfterEachTest, trackProcess } from './support/process-reaper';

reapAfterEachTest();

const HOLDER = join(import.meta.dir, 'fixtures', 'unix-socket-holder.ts');
const LOCK_OWNER_MODULE = join(import.meta.dir, '../src/internal/exclusive-lock-owner.ts');
const PROCESS_IDENTITY_MODULE = join(import.meta.dir, '../src/internal/process-identity.ts');
const PROCESS_INSTANCE_MODULE = join(import.meta.dir, '../src/internal/process-instance.ts');

/** The owner record a startup lock holds, naming `pid` within this process's boot. */
function deadOwnerRecord(pid: number): string {
  const own = readProcessInstanceSync(process.pid);
  if (own === null) throw new Error('no process instance for this process');
  return `${JSON.stringify({ ...recordOwner(machineIdentitySync(undefined), { ...own, startId: '1' }), pid })}\n`;
}
const RACER = join(import.meta.dir, 'fixtures', 'unix-server-racer.ts');

const whoContract = defineContract(
  { prefix: 'who' },
  {
    get: {
      method: 'GET',
      path: '/',
      desc: 'Identify listener',
      output: z.object({ id: z.string() }),
    },
  },
);

function whoService(id: string) {
  return implement(whoContract, {
    get: () => ({ id }),
  });
}

let root = '';
let counter = 0;

beforeAll(() => {
  root = mkdtempSync(join(tmpdir(), 'sko-'));
});

afterAll(() => {
  rmSync(root, { recursive: true, force: true });
});

function socketPath(name?: string): string {
  counter += 1;
  return join(root, name ?? `s${counter}.sock`);
}

async function createStaleSocket(path: string): Promise<void> {
  const holder = Bun.spawn({
    cmd: [process.execPath, HOLDER],
    env: { ...process.env, STITCHKIT_TEST_UNIX_PATH: path },
    stdout: 'pipe',
  });
  trackProcess(holder.pid);
  const reader = holder.stdout.getReader();
  await reader.read();
  holder.kill(9);
  await holder.exited;
  expect(existsSync(path)).toBe(true);
}

function createLineReader(stream: ReadableStream<Uint8Array>): () => Promise<string> {
  const reader = stream.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  return async () => {
    while (!buffer.includes('\n')) {
      const { value, done } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
    }
    const index = buffer.indexOf('\n');
    if (index === -1) {
      const rest = buffer;
      buffer = '';
      return rest;
    }
    const line = buffer.slice(0, index);
    buffer = buffer.slice(index + 1);
    return line;
  };
}

const RacerLineSchema = z.discriminatedUnion('status', [
  z.object({ status: z.literal('started'), id: z.string(), dev: z.number(), ino: z.number() }),
  z.object({ status: z.literal('failed'), id: z.string(), message: z.string() }),
]);

describe('unix socket ownership and startup locking', () => {
  test('two concurrent starts racing a stale socket leave exactly one live winner', async () => {
    for (let round = 0; round < 5; round += 1) {
      const path = socketPath(`race-${round}.sock`);
      await createStaleSocket(path);

      const spawnRacer = (id: string) => {
        const child = Bun.spawn({
          cmd: [process.execPath, RACER],
          env: {
            ...process.env,
            STITCHKIT_TEST_UNIX_PATH: path,
            STITCHKIT_TEST_RACER_ID: id,
            ...(round === 1 && { STITCHKIT_TEST_UNIX_MODE: '600' }),
          },
          stdin: 'pipe',
          stdout: 'pipe',
          stderr: 'pipe',
        });
        trackProcess(child.pid);
        return child;
      };

      const a = spawnRacer('racer-a');
      const b = spawnRacer('racer-b');
      const readA = createLineReader(a.stdout);
      const readB = createLineReader(b.stdout);

      try {
        expect(await Promise.all([readA(), readB()])).toEqual(['ready', 'ready']);
        // Release both racers at the exact same instant so their probes overlap.
        a.stdin.write('go\n');
        b.stdin.write('go\n');
        await Promise.all([a.stdin.flush(), b.stdin.flush()]);

        const [lineA, lineB] = await Promise.all([readA(), readB()]);
        const outcomes = [
          { child: a, result: RacerLineSchema.parse(JSON.parse(lineA)) },
          { child: b, result: RacerLineSchema.parse(JSON.parse(lineB)) },
        ];
        const winners = outcomes.filter((entry) => entry.result.status === 'started');
        const losers = outcomes.filter((entry) => entry.result.status === 'failed');

        expect(winners).toHaveLength(1);
        expect(losers).toHaveLength(1);

        const winner = winners[0];
        const loser = losers[0];
        if (!winner || !loser || winner.result.status !== 'started') {
          throw new Error('Expected exactly one winner and one loser');
        }

        // Loser exits cleanly without removing the winner's socket.
        expect(await loser.child.exited).toBe(1);
        expect(existsSync(path)).toBe(true);
        const onDisk = lstatSync(path);
        expect(onDisk.dev).toBe(winner.result.dev);
        expect(onDisk.ino).toBe(winner.result.ino);

        // Winner is still answering requests at the socket path.
        const response = await fetch('http://localhost/who', { unix: path });
        expect(response.status).toBe(200);
        expect(await response.json()).toEqual({ id: winner.result.id });

        // Shutting down the winner removes its own socket.
        winner.child.stdin.end();
        expect(await winner.child.exited).toBe(0);
        expect(existsSync(path)).toBe(false);
      } finally {
        a.stdin.end();
        b.stdin.end();
      }
    }
  }, 30_000);

  test('stopping a server whose socket path was replaced does not unlink the replacement socket', async () => {
    const path = socketPath('replace.sock');
    const first = createServer({ unix: path, services: [whoService('first')] });
    const firstStat = lstatSync(path);

    // Replace the socket path with a second server (different inode).
    unlinkSync(path);
    const second = createServer({ unix: path, services: [whoService('second')] });
    const secondStat = lstatSync(path);
    expect(secondStat.ino).not.toBe(firstStat.ino);

    try {
      // Stopping the first server must NOT remove the second server's socket.
      await first.shutdown({ gracePeriodMs: 1_000 });
      expect(existsSync(path)).toBe(true);
      const afterFirstStop = lstatSync(path);
      expect(afterFirstStop.dev).toBe(secondStat.dev);
      expect(afterFirstStop.ino).toBe(secondStat.ino);

      const response = await fetch('http://localhost/who', { unix: path });
      expect(response.status).toBe(200);
      expect(await response.json()).toEqual({ id: 'second' });
    } finally {
      await second.shutdown({ gracePeriodMs: 1_000 });
    }
    expect(existsSync(path)).toBe(false);
  });

  test('non-ECONNREFUSED/ENOENT probe errors and overlong socket names fail loudly without removing the socket file', async () => {
    const shortPath = socketPath('short.sock');
    const live = createServer({ unix: shortPath, services: [whoService('live')] });
    const shortIno = lstatSync(shortPath).ino;
    // Hard-link the live socket to a 125-char filename (> 103-byte portable sun_path limit).
    const longSocketPath = join(root, `${'x'.repeat(120)}.sock`);
    linkSync(shortPath, longSocketPath);

    try {
      // Case 1: overlong path (> 103 bytes) fails at config check without touching the file.
      expect(lstatSync(longSocketPath).isSocket()).toBe(true);
      expect(() => createServer({ unix: longSocketPath, services: [] })).toThrow(
        /ENAMETOOLONG|too long/,
      );
      expect(existsSync(longSocketPath)).toBe(true);
      expect(lstatSync(longSocketPath).ino).toBe(shortIno);

      // Exceeding NAME_MAX (> 255 bytes) also fails loudly without touching anything.
      const overNameMax = join(root, `${'y'.repeat(260)}.sock`);
      expect(() => createServer({ unix: overNameMax, services: [] })).toThrow();

      // A brand-new unconnectable 125-char socket name must also fail loudly and leave no file.
      const freshLong = join(root, `${'z'.repeat(120)}.sock`);
      expect(() => createServer({ unix: freshLong, services: [] })).toThrow(
        /ENAMETOOLONG|too long/,
      );
      expect(existsSync(freshLong)).toBe(false);

      // Case 2: <= 103-byte existing socket reaching reclaimStaleUnixSocket with non-ECONNREFUSED/ENOENT
      // probe failures (EACCES, EPROTOTYPE, timeout) refuses loudly and preserves the socket inode.
      const realSpawnSync = Bun.spawnSync.bind(Bun);
      const probeCases: Array<{ script: string; timeout?: number; expected: RegExp }> = [
        {
          script: 'process.stdout.write("error:EACCES\\n"); process.exit(20);',
          expected: /connect permission denied/,
        },
        {
          script: 'process.stdout.write("error:EPROTOTYPE\\n"); process.exit(20);',
          expected: /failed to probe unix socket.*EPROTOTYPE/,
        },
        {
          script: 'process.stdout.write("error:EAGAIN\\n"); process.exit(20);',
          expected: /failed to probe unix socket.*EAGAIN/,
        },
        {
          script: 'process.stdout.write("error:EPERM\\n"); process.exit(20);',
          expected: /failed to probe unix socket.*EPERM/,
        },
        {
          script: 'await Bun.sleep(2_000);',
          timeout: 50,
          expected: /liveness probe.*timed out/,
        },
      ];

      for (const { script, timeout, expected } of probeCases) {
        const spawnSpy = spyOn(Bun, 'spawnSync').mockImplementation(() =>
          realSpawnSync({
            cmd: [process.execPath, '--config=/dev/null', '-e', script],
            stdin: 'ignore',
            ...(timeout !== undefined && { timeout }),
          }),
        );
        try {
          expect(() => createServer({ unix: shortPath, services: [] })).toThrow(expected);
          expect(existsSync(shortPath)).toBe(true);
          expect(lstatSync(shortPath).ino).toBe(shortIno);
        } finally {
          spawnSpy.mockRestore();
        }
      }
    } finally {
      rmSync(longSocketPath, { force: true });
      await live.shutdown({ gracePeriodMs: 1_000 });
    }
  });

  test('liveness probe works inside a compiled standalone binary even with empty PATH', async () => {
    const entry = join(root, 'compiled-probe.ts');
    const binary = join(root, 'compiled-probe-bin');
    const serverEntry = join(import.meta.dir, '../src/entrypoints/server.ts');

    writeFileSync(
      entry,
      [
        `import { createServer } from ${JSON.stringify(serverEntry)};`,
        'const path = process.env.STITCHKIT_TEST_UNIX_PATH;',
        'if (!path) throw new Error("missing path");',
        'const server = createServer({ unix: path, services: [] });',
        'process.stdout.write("started\\n");',
        'await server.shutdown({ gracePeriodMs: 1_000 });',
      ].join('\n'),
    );

    const build = Bun.spawnSync({
      cmd: [process.execPath, 'build', '--compile', entry, '--outfile', binary],
    });
    expect(build.exitCode).toBe(0);

    // Case A: live socket — compiled binary with PATH="" refuses loudly and leaves live socket intact.
    const livePath = socketPath('compiled-live.sock');
    const live = createServer({ unix: livePath, services: [whoService('live')] });
    try {
      const againstLive = Bun.spawnSync({
        cmd: [binary],
        env: { PATH: '', STITCHKIT_TEST_UNIX_PATH: livePath },
      });
      expect(againstLive.exitCode).not.toBe(0);
      expect(againstLive.stderr.toString('utf8')).toContain(
        'already in use by a live listener',
      );
      expect(existsSync(livePath)).toBe(true);
      const response = await fetch('http://localhost/who', { unix: livePath });
      expect(response.status).toBe(200);
      expect(await response.json()).toEqual({ id: 'live' });
    } finally {
      await live.shutdown({ gracePeriodMs: 1_000 });
    }

    // Case B: stale socket — compiled binary with PATH="" reclaims it and starts cleanly.
    const stalePath = socketPath('compiled-stale.sock');
    await createStaleSocket(stalePath);
    const againstStale = Bun.spawnSync({
      cmd: [binary],
      env: { PATH: '', STITCHKIT_TEST_UNIX_PATH: stalePath },
    });
    expect(againstStale.exitCode).toBe(0);
    expect(againstStale.stdout.toString('utf8').trim()).toBe('started');
    expect(existsSync(stalePath)).toBe(false);
  }, 30_000);

  test('startup lock recovers from a stale lock owned by a dead PID', async () => {
    const path = socketPath('dead-lock.sock');
    await createStaleSocket(path);

    // Spawn a short-lived child to get a guaranteed dead PID.
    const ephemeral = Bun.spawn({ cmd: [process.execPath, '-e', 'process.exit(0)'] });
    trackProcess(ephemeral.pid);
    await ephemeral.exited;

    const lockPath = join(root, '.dead-lock.sock.lock');
    writeFileSync(lockPath, deadOwnerRecord(ephemeral.pid), { mode: 0o600 });

    const server = createServer({ unix: path, services: [whoService('recovered')] });
    try {
      expect(existsSync(lockPath)).toBe(false);
      const response = await fetch('http://localhost/who', { unix: path });
      expect(response.status).toBe(200);
      expect(await response.json()).toEqual({ id: 'recovered' });
    } finally {
      await server.shutdown({ gracePeriodMs: 1_000 });
    }
  });

  test('startup lock waits for a live holder to release rather than stomping it', async () => {
    const path = socketPath('wait-lock.sock');
    const lockPath = join(root, '.wait-lock.sock.lock');

    const holder = Bun.spawn({
      cmd: [
        process.execPath,
        '-e',
        [
          'import { unlinkSync, writeFileSync } from "node:fs";',
          `import { recordOwner } from ${JSON.stringify(LOCK_OWNER_MODULE)};`,
          `import { machineIdentitySync } from ${JSON.stringify(PROCESS_IDENTITY_MODULE)};`,
          `import { readProcessInstanceSync } from ${JSON.stringify(PROCESS_INSTANCE_MODULE)};`,
          'const lock = Bun.env.LOCK_PATH ?? "";',
          'const owner = recordOwner(machineIdentitySync(undefined), readProcessInstanceSync(process.pid));',
          'writeFileSync(lock, JSON.stringify(owner) + "\\n", { mode: 0o600 });',
          'process.stdout.write("locked\\n");',
          'await Bun.sleep(150);',
          'unlinkSync(lock);',
        ].join('\n'),
      ],
      env: { ...process.env, LOCK_PATH: lockPath },
      stdout: 'pipe',
    });
    trackProcess(holder.pid);
    const readHolder = createLineReader(holder.stdout);
    expect(await readHolder()).toBe('locked');

    const startedAt = performance.now();
    const server = createServer({ unix: path, services: [whoService('waited')] });
    const elapsedMs = performance.now() - startedAt;
    try {
      expect(elapsedMs).toBeGreaterThanOrEqual(100);
      expect(await holder.exited).toBe(0);
      expect(existsSync(lockPath)).toBe(false);
      const response = await fetch('http://localhost/who', { unix: path });
      expect(response.status).toBe(200);
      expect(await response.json()).toEqual({ id: 'waited' });
    } finally {
      await server.shutdown({ gracePeriodMs: 1_000 });
    }
  });

  test('refuses a symlink at the socket path without removing the symlink or target', async () => {
    const targetPath = socketPath('sym-target.sock');
    const linkPath = socketPath('sym-link.sock');
    const live = createServer({ unix: targetPath, services: [whoService('target')] });
    symlinkSync(targetPath, linkPath);
    try {
      expect(() => createServer({ unix: linkPath, services: [] })).toThrow(
        'exists and is not a socket',
      );
      expect(lstatSync(linkPath).isSymbolicLink()).toBe(true);
      expect(existsSync(targetPath)).toBe(true);
      const response = await fetch('http://localhost/who', { unix: targetPath });
      expect(response.status).toBe(200);
      expect(await response.json()).toEqual({ id: 'target' });
    } finally {
      rmSync(linkPath, { force: true });
      await live.shutdown({ gracePeriodMs: 1_000 });
    }
  });

  test('liveness probe ignores noisy BUN_OPTIONS and cwd bunfig.toml preloads', async () => {
    const preloadDir = join(root, 'noisy-cwd');
    const cleanDir = join(root, 'clean-cwd');
    mkdirSync(preloadDir, { recursive: true });
    mkdirSync(cleanDir, { recursive: true });
    const noisyPreload = join(preloadDir, 'noisy.ts');
    writeFileSync(noisyPreload, 'console.log("NOISY_PRELOAD");\n');
    writeFileSync(
      join(preloadDir, 'bunfig.toml'),
      `preload = [${JSON.stringify(noisyPreload)}]\n`,
    );

    const serverEntry = join(import.meta.dir, '../src/entrypoints/server.ts');
    const runner = [
      `import { createServer } from ${JSON.stringify(serverEntry)};`,
      'const path = Bun.env.STITCHKIT_TEST_UNIX_PATH ?? "";',
      'const server = createServer({ unix: path, services: [] });',
      'process.stdout.write("started\\n");',
      'await server.shutdown({ gracePeriodMs: 1_000 });',
    ].join('\n');

    const scenarios: Array<{ label: string; cwd: string; extraEnv: Record<string, string> }> =
      [
        { label: 'bunfig', cwd: preloadDir, extraEnv: {} },
        {
          label: 'bun-options',
          cwd: cleanDir,
          extraEnv: { BUN_OPTIONS: `--preload=${noisyPreload}` },
        },
      ];

    for (const { label, cwd, extraEnv } of scenarios) {
      const livePath = socketPath(`probe-live-${label}.sock`);
      const live = createServer({ unix: livePath, services: [whoService(label)] });
      try {
        const res = Bun.spawnSync({
          cmd: [process.execPath, '-e', runner],
          cwd,
          env: { ...process.env, ...extraEnv, STITCHKIT_TEST_UNIX_PATH: livePath },
        });
        expect(res.exitCode).not.toBe(0);
        expect(res.stderr.toString('utf8')).toContain('already in use by a live listener');
        expect(existsSync(livePath)).toBe(true);
      } finally {
        await live.shutdown({ gracePeriodMs: 1_000 });
      }

      const stalePath = socketPath(`probe-stale-${label}.sock`);
      await createStaleSocket(stalePath);
      const reclaimed = Bun.spawnSync({
        cmd: [process.execPath, '-e', runner],
        cwd,
        env: { ...process.env, ...extraEnv, STITCHKIT_TEST_UNIX_PATH: stalePath },
      });
      expect(reclaimed.exitCode).toBe(0);
      expect(reclaimed.stdout.toString('utf8')).toContain('started');
      expect(existsSync(stalePath)).toBe(false);
    }
  });

  test('invalid unix.mode fails before taking the lock or reclaiming a stale socket', async () => {
    const path = socketPath('bad-mode.sock');
    await createStaleSocket(path);
    const lockPath = join(root, '.bad-mode.sock.lock');
    expect(() => createServer({ unix: { path, mode: 0o1000 }, services: [] })).toThrow(
      '`mode` must be permission bits 0o000–0o777',
    );
    expect(existsSync(path)).toBe(true);
    expect(existsSync(lockPath)).toBe(false);
  });

  test('sun_path length checks, adaptive staging names, and symlink lock refusal', () => {
    // Portable 103-byte sun_path ceiling applies on every platform.
    expect(() =>
      assertUnixSocketPathLength(`/${'a'.repeat(102)}`, 'createServer'),
    ).not.toThrow();
    expect(() => assertUnixSocketPathLength(`/${'a'.repeat(103)}`, 'createServer')).toThrow(
      'ENAMETOOLONG',
    );

    // Adaptive staging names shorten down to 3 bytes on both darwin (104B) and linux (108B),
    // and fail loudly with ENAMETOOLONG when fewer than 3 bytes remain.
    expect(chooseStagingSocketName(`/${'a'.repeat(90)}`, '/t', 'darwin').length).toBe(10);
    expect(chooseStagingSocketName(`/${'a'.repeat(95)}`, '/t', 'darwin').length).toBe(6);
    expect(chooseStagingSocketName(`/${'a'.repeat(97)}`, '/t', 'darwin').length).toBe(4);
    expect(chooseStagingSocketName(`/${'a'.repeat(98)}`, '/t', 'darwin').length).toBe(3);
    expect(() => chooseStagingSocketName(`/${'a'.repeat(99)}`, '/t', 'darwin')).toThrow(
      'ENAMETOOLONG',
    );

    expect(chooseStagingSocketName(`/${'a'.repeat(95)}`, '/t', 'linux').length).toBe(10);
    expect(chooseStagingSocketName(`/${'a'.repeat(97)}`, '/t', 'linux').length).toBe(8);
    expect(chooseStagingSocketName(`/${'a'.repeat(99)}`, '/t', 'linux').length).toBe(6);
    expect(chooseStagingSocketName(`/${'a'.repeat(102)}`, '/t', 'linux').length).toBe(3);
    expect(() => chooseStagingSocketName(`/${'a'.repeat(103)}`, '/t', 'linux')).toThrow(
      'ENAMETOOLONG',
    );

    // Multi-byte UTF-8 directories are budgeted by UTF-8 bytes, not UTF-16 code units.
    const utf8Dir98 = `/${'€'.repeat(32)}a`;
    expect(utf8Dir98.length).toBe(34);
    expect(Buffer.byteLength(utf8Dir98)).toBe(98);
    const darwinUtf8Name = chooseStagingSocketName(utf8Dir98, '/t', 'darwin');
    expect(Buffer.byteLength(darwinUtf8Name)).toBe(4);
    expect(Buffer.byteLength(join(utf8Dir98, darwinUtf8Name))).toBe(103);
    const linuxUtf8Name = chooseStagingSocketName(utf8Dir98, '/t', 'linux');
    expect(Buffer.byteLength(linuxUtf8Name)).toBe(8);
    expect(Buffer.byteLength(join(utf8Dir98, linuxUtf8Name))).toBe(107);
    const utf8Dir104 = `/${'€'.repeat(34)}a`;
    expect(Buffer.byteLength(utf8Dir104)).toBe(104);
    expect(() => chooseStagingSocketName(utf8Dir104, '/t', 'linux')).toThrow('ENAMETOOLONG');
    expect(() => chooseStagingSocketName(utf8Dir104, '/t', 'darwin')).toThrow('ENAMETOOLONG');

    // A symlink standing at the lock path is never followed or removed and times out within bound.
    const target = join(root, 'dead-pid-target.txt');
    writeFileSync(target, '999999999\n');
    const symSock = socketPath('symlock.sock');
    const symLock = join(root, '.symlock.sock.lock');
    symlinkSync(target, symLock);
    try {
      expect(() => withUnixSocketLockSync(symSock, () => undefined, 40)).toThrow(
        'timed out waiting for unix socket startup lock',
      );
      expect(lstatSync(symLock).isSymbolicLink()).toBe(true);
      expect(existsSync(target)).toBe(true);
    } finally {
      rmSync(symLock, { force: true });
      rmSync(target, { force: true });
    }
  });

  test('live createServer binds 101–103 byte socket paths inside a 98-byte ASCII or UTF-8 directory', async () => {
    const makeExactByteDir = (
      targetBytes: number,
      prefix: string,
      useUtf8: boolean,
    ): string => {
      const remaining = targetBytes - Buffer.byteLength(root) - 1 - Buffer.byteLength(prefix);
      if (remaining < 1) {
        throw new Error(
          `Test root "${root}" leaves too little room for ${targetBytes}-byte dir`,
        );
      }
      const filler = useUtf8
        ? `${'€'.repeat(Math.floor(remaining / 3))}${'x'.repeat(remaining % 3)}`
        : 'd'.repeat(remaining);
      const dir = join(root, `${prefix}${filler}`);
      expect(Buffer.byteLength(dir)).toBe(targetBytes);
      mkdirSync(dir, { mode: 0o700 });
      chmodSync(dir, 0o700);
      return dir;
    };

    const asciiDir98 = makeExactByteDir(98, 'l', false);
    const utf8Dir98 = makeExactByteDir(98, 'u', true);

    const cases = [
      { dir: asciiDir98, name: 's1', expectedBytes: 101 },
      { dir: asciiDir98, name: 'a.s', expectedBytes: 102 },
      { dir: asciiDir98, name: 'ab.s', expectedBytes: 103 },
      { dir: utf8Dir98, name: 'a.s', expectedBytes: 102 },
    ];

    const maxSunPathBytes = process.platform === 'darwin' ? 103 : 107;
    const stagedTarget = join(asciiDir98, 'st.s');
    expect(Buffer.byteLength(stagedTarget)).toBe(103);
    let observedStagingBytes = 0;
    const published = publishStagedUnixSocket(
      stagedTarget,
      (stagingPath) => {
        observedStagingBytes = Buffer.byteLength(stagingPath);
        return Bun.serve({ unix: stagingPath, fetch: () => new Response('ok') });
      },
      (srv) => {
        void srv.stop(true).catch(() => undefined);
      },
    );
    try {
      expect(observedStagingBytes).toBeLessThanOrEqual(maxSunPathBytes);
    } finally {
      await published.server.stop(true);
      rmSync(stagedTarget, { force: true });
    }

    for (const { dir, name, expectedBytes } of cases) {
      const path = join(dir, name);
      expect(Buffer.byteLength(path)).toBe(expectedBytes);
      const server = createServer({
        unix: { path, mode: 0o600 },
        services: [whoService(`long-${expectedBytes}`)],
      });
      try {
        expect(lstatSync(path).mode & 0o777).toBe(0o600);
        const response = await fetch('http://localhost/who', { unix: path });
        expect(response.status).toBe(200);
        expect(await response.json()).toEqual({ id: `long-${expectedBytes}` });
      } finally {
        await server.shutdown({ gracePeriodMs: 1_000 });
      }
      expect(existsSync(path)).toBe(false);
    }
  });
});
