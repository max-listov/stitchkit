import { afterEach, describe, expect, test } from 'bun:test';
import { chmodSync, mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { platform, tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  createDefaultProcessIdentityAdapter,
  parseProcNetUnixListeningSockets,
  verifySupervisedProcess,
} from '../src/entrypoints/service-host';
import { reapAfterEachTest, trackProcess } from './support/process-reaper';

reapAfterEachTest();

const BINDER = fileURLToPath(new URL('./fixtures/unix-socket-binder.ts', import.meta.url));

const children: Array<ReturnType<typeof Bun.spawn>> = [];
afterEach(() => {
  for (const child of children.splice(0)) child.kill('SIGKILL');
});

async function bind(cwd: string, names: string[], victim?: string) {
  const child = Bun.spawn({
    cmd: [process.execPath, BINDER],
    cwd,
    env: {
      ...process.env,
      STITCHKIT_TEST_NAMES: JSON.stringify(names),
      STITCHKIT_TEST_VICTIM: victim ?? '',
    },
    stdout: 'pipe',
    stderr: 'inherit',
  });
  trackProcess(child.pid);
  children.push(child);
  const reader = child.stdout.getReader();
  const first = await reader.read();
  reader.releaseLock();
  expect(new TextDecoder().decode(first.value)).toContain('ready');
  return child;
}

const verify = (pid: number, socketPath: string) =>
  verifySupervisedProcess({
    pid,
    socketPath,
    adapter: createDefaultProcessIdentityAdapter('/proc'),
  });

describe('service-host: a socket name another user writes cannot claim a socket', () => {
  test('a name that spells another socket node inside an ss line does not own that path', async () => {
    if (platform() !== 'linux') return;
    const dir = mkdtempSync(join(tmpdir(), 'stitchkit-forge-space-'));
    chmodSync(dir, 0o755);
    const attackerDir = join(dir, 'attacker');
    mkdirSync(attackerDir);
    const victimPath = join(dir, 'v.sock');
    try {
      const victim = await bind(dir, [victimPath]);
      const attacker = await bind(
        attackerDir,
        ['a.sock', 'b {inode} * 0 <-> {node} x'],
        victimPath,
      );
      expect((await verify(victim.pid, victimPath)).status).toBe('verified');
      expect(await verify(attacker.pid, victimPath)).toMatchObject({
        status: 'runtime-conflict',
        reason: 'socket-owned-by-other-process',
      });
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }, 30_000);

  test('a name that writes a /proc/net/unix line of its own makes the tables unreadable, not owned', async () => {
    if (platform() !== 'linux') return;
    const dir = mkdtempSync(join(tmpdir(), 'stitchkit-forge-newline-'));
    // A Unix socket name holds at most 107 bytes, and the forged line is most of them.
    const tag = `${process.pid.toString(36)}${Date.now().toString(36)}`;
    const abstract = `@skv${tag}`;
    try {
      const victim = await bind(dir, [abstract]);
      expect((await verify(victim.pid, abstract)).status).toBe('verified');
      const attacker = await bind(dir, [
        `@ska${tag}`,
        `z\n0000000000000000: 00000002 00000000 00010000 0001 01 {inode} ${abstract}`,
      ]);
      expect(await verify(attacker.pid, abstract)).toMatchObject({
        status: 'runtime-unavailable',
        reason: 'socket-unverifiable',
      });
      // While such a name is bound no socket is proven, the real owner's included.
      expect(await verify(victim.pid, abstract)).toMatchObject({
        status: 'runtime-unavailable',
        reason: 'socket-unverifiable',
      });
      attacker.kill('SIGKILL');
      await attacker.exited;
      expect((await verify(victim.pid, abstract)).status).toBe('verified');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }, 30_000);
});

describe('service-host: a name with any character but a line feed is a name, not a forgery', () => {
  test('a carriage return, U+2028, U+2029 or a trailing space in a socket name still verifies its owner', async () => {
    if (platform() !== 'linux') return;
    const dir = mkdtempSync(join(tmpdir(), 'stitchkit-names-'));
    const tag = `${process.pid.toString(36)}${Date.now().toString(36)}`;
    try {
      for (const name of [
        join(dir, 'a\rb.sock'),
        join(dir, 'a\u2028b.sock'),
        join(dir, 'a\u2029b.sock'),
        join(dir, 'trail.sock '),
        `@skt${tag} `,
        `@skr${tag}\r`,
      ]) {
        const owner = await bind(dir, [name]);
        expect(await verify(owner.pid, name), JSON.stringify(name)).toMatchObject({
          status: 'verified',
        });
        owner.kill('SIGKILL');
        await owner.exited;
      }
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }, 30_000);
});

describe('service-host: a socket table with a line that is not a record is refused whole', () => {
  test('parseProcNetUnixListeningSockets throws on a stray or empty line and reads a clean table', () => {
    const header = 'Num       RefCount Protocol Flags    Type St Inode Path';
    const record = '0000000000000001: 00000002 00000000 00010000 0001 01 20002 /run/a b.sock';
    expect(parseProcNetUnixListeningSockets(`${header}\n${record}\n`)).toEqual([
      {
        flagsHex: '00010000',
        typeHex: '0001',
        stateHex: '01',
        listening: true,
        inode: '20002',
        path: '/run/a b.sock',
      },
    ]);
    for (const stray of ['u_str LISTEN 0 128 x 5 * 0', '', 'tail of a name']) {
      expect(() =>
        parseProcNetUnixListeningSockets(`${header}\n${record}\n${stray}\n${record}`),
      ).toThrow('line 3 is not a socket record');
    }
  });
});
