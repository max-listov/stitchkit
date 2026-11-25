/**
 * The unix socket startup lock judges its owner by the exclusive lock's rule: a record of this
 * machine and of one process lifetime, never a bare PID — and releasing it never replaces the
 * outcome of the work it guarded.
 */
import { afterAll, beforeAll, describe, expect, spyOn, test } from 'bun:test';
import * as fs from 'node:fs';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { hostname, tmpdir } from 'node:os';
import { join } from 'node:path';
import { z } from 'zod';
import { defineContract } from '../src/entrypoints/contract';
import { createServer, implement } from '../src/entrypoints/server';
import { machineIdentity } from '../src/internal/process-identity';
import { type ProcessInstance, readProcessInstance } from '../src/internal/process-instance';
import { withUnixSocketLockSync } from '../src/internal/unix-socket-lock';
import { reapAfterEachTest, trackProcess } from './support/process-reaper';

reapAfterEachTest();

const pingContract = defineContract(
  { prefix: 'ping' },
  {
    get: {
      method: 'GET',
      path: '/',
      desc: 'Answer a ping',
      output: z.object({ ok: z.boolean() }),
    },
  },
);
const pingService = implement(pingContract, { get: () => ({ ok: true }) });

let root = '';
let counter = 0;

beforeAll(() => {
  root = mkdtempSync(join(tmpdir(), 'sklo-'));
});

afterAll(() => {
  rmSync(root, { recursive: true, force: true });
});

function nextSocket(): { sockPath: string; lockPath: string } {
  counter += 1;
  const name = `o${counter}.sock`;
  return { sockPath: join(root, name), lockPath: join(root, `.${name}.lock`) };
}

/** A live process that is not this one: its PID is reachable for the whole test. */
async function liveForeignProcess(): Promise<{ pid: number; stop(): Promise<void> }> {
  const child = Bun.spawn({
    cmd: [process.execPath, '-e', 'setInterval(() => undefined, 1_000)'],
    stdout: 'ignore',
    stderr: 'ignore',
  });
  trackProcess(child.pid);
  return {
    pid: child.pid,
    async stop() {
      child.kill('SIGKILL');
      await child.exited;
    },
  };
}

/** The owner record the exclusive lock writes, for an arbitrary PID and process lifetime. */
async function ownerRecord(pid: number, instance: ProcessInstance | null): Promise<string> {
  const machine = await machineIdentity(undefined);
  return `${JSON.stringify({
    pid,
    process: instance,
    host: hostname(),
    acquiredAt: new Date().toISOString(),
    ...(machine !== null && { machine }),
  })}\n`;
}

async function instanceOf(pid: number): Promise<ProcessInstance> {
  const instance = await readProcessInstance(pid);
  if (instance === null) throw new Error(`no process instance for ${pid}`);
  return instance;
}

async function ping(sockPath: string): Promise<unknown> {
  const response = await fetch('http://localhost/ping', { unix: sockPath });
  return response.json();
}

describe('a startup lock whose live PID belongs to another process lifetime', () => {
  test('createServer takes a lock whose PID was reused or whose boot is over', async () => {
    const foreign = await liveForeignProcess();
    try {
      const live = await instanceOf(foreign.pid);
      for (const recorded of [
        { ...live, startId: String(Number(live.startId) + 1) },
        { ...live, bootId: `${live.bootId}-before-reboot` },
      ]) {
        const { sockPath, lockPath } = nextSocket();
        writeFileSync(lockPath, await ownerRecord(foreign.pid, recorded), { mode: 0o600 });
        const server = createServer({ unix: sockPath, services: [pingService] });
        try {
          expect(existsSync(lockPath)).toBe(false);
          expect(await ping(sockPath)).toEqual({ ok: true });
        } finally {
          await server.shutdown({ gracePeriodMs: 1_000 });
        }
        expect(existsSync(sockPath)).toBe(false);
        expect(existsSync(lockPath)).toBe(false);
      }
    } finally {
      await foreign.stop();
    }
  }, 30_000);

  test('a lock held by a live process of the recorded lifetime is never taken', async () => {
    const foreign = await liveForeignProcess();
    try {
      const { sockPath, lockPath } = nextSocket();
      const record = await ownerRecord(foreign.pid, await instanceOf(foreign.pid));
      writeFileSync(lockPath, record, { mode: 0o600 });
      expect(() => withUnixSocketLockSync(sockPath, () => 'entered', 80)).toThrow(
        'timed out waiting for unix socket startup lock',
      );
      expect(readFileSync(lockPath, 'utf8')).toBe(record);
    } finally {
      await foreign.stop();
    }
  });

  test('a record from another machine is never taken, whatever its PID', async () => {
    const { sockPath, lockPath } = nextSocket();
    const record = `${JSON.stringify({
      pid: 2 ** 22 + 17,
      process: null,
      host: 'another-host',
      machine: 'another-machine',
      acquiredAt: new Date().toISOString(),
    })}\n`;
    writeFileSync(lockPath, record, { mode: 0o600 });
    expect(() => withUnixSocketLockSync(sockPath, () => 'entered', 80)).toThrow(
      'timed out waiting for unix socket startup lock',
    );
    expect(readFileSync(lockPath, 'utf8')).toBe(record);
  });
});

describe('a startup lock that names this very process', () => {
  test('is taken when no descriptor of it is open, and refused while one is', async () => {
    const { sockPath, lockPath } = nextSocket();
    const record = await ownerRecord(process.pid, await instanceOf(process.pid));
    writeFileSync(lockPath, record, { mode: 0o600 });
    const held = fs.openSync(lockPath, 'r');
    try {
      expect(() => withUnixSocketLockSync(sockPath, () => 'entered', 80)).toThrow(
        'timed out waiting for unix socket startup lock',
      );
      expect(readFileSync(lockPath, 'utf8')).toBe(record);
    } finally {
      fs.closeSync(held);
    }
    // A process image replaced in place keeps its PID and start time but not the descriptor.
    expect(withUnixSocketLockSync(sockPath, () => 'entered', 80)).toBe('entered');
    expect(existsSync(lockPath)).toBe(false);
  });
});

describe('a startup lock an older version left behind', () => {
  test('a bare PID is taken only once it is older than the ownerless grace', async () => {
    const foreign = await liveForeignProcess();
    try {
      const { sockPath, lockPath } = nextSocket();
      writeFileSync(lockPath, `${foreign.pid}\n`, { mode: 0o600 });
      expect(() => withUnixSocketLockSync(sockPath, () => 'entered', 80)).toThrow(
        'timed out waiting for unix socket startup lock',
      );
      expect(readFileSync(lockPath, 'utf8')).toBe(`${foreign.pid}\n`);
      // A bare PID proves nothing about a live process either: only its age decides.
      const longAgo = new Date(Date.now() - 31_000);
      fs.utimesSync(lockPath, longAgo, longAgo);
      expect(withUnixSocketLockSync(sockPath, () => 'entered', 80)).toBe('entered');
      expect(existsSync(lockPath)).toBe(false);
    } finally {
      await foreign.stop();
    }
  });
});

describe('a startup lock that cannot be removed after the guarded work', () => {
  test('createServer returns its listening server and logs the release failure', async () => {
    const { sockPath, lockPath } = nextSocket();
    const unlink = fs.unlinkSync;
    const failure = Object.assign(new Error('EIO: i/o error, unlink'), { code: 'EIO' });
    const unlinkSpy = spyOn(fs, 'unlinkSync').mockImplementation((path) => {
      if (path === lockPath) throw failure;
      unlink(path);
    });
    const logged: unknown[][] = [];
    const errorSpy = spyOn(console, 'error').mockImplementation((...line: unknown[]) => {
      logged.push(line);
    });
    let server: ReturnType<typeof createServer> | undefined;
    try {
      server = createServer({ unix: sockPath, services: [pingService] });
    } finally {
      unlinkSpy.mockRestore();
      errorSpy.mockRestore();
    }
    if (server === undefined) throw new Error('createServer returned no server');
    try {
      expect(await ping(sockPath)).toEqual({ ok: true });
      expect(logged).toHaveLength(1);
      const [message, cause] = logged[0] ?? [];
      expect(String(message)).toContain(lockPath);
      expect(cause).toBe(failure);
      // The lock it could not remove names this process with no descriptor open on it: the
      // owner rule judges it gone, so the shutdown takes it like any abandoned lock.
      expect(existsSync(lockPath)).toBe(true);
    } finally {
      await server.shutdown({ gracePeriodMs: 1_000 });
    }
    expect(existsSync(sockPath)).toBe(false);
    expect(existsSync(lockPath)).toBe(false);
  });

  test('the guarded work keeps its own error when the release fails too', () => {
    const { sockPath, lockPath } = nextSocket();
    const unlink = fs.unlinkSync;
    const unlinkSpy = spyOn(fs, 'unlinkSync').mockImplementation((path) => {
      if (path === lockPath)
        throw Object.assign(new Error('EBUSY: resource busy'), { code: 'EBUSY' });
      unlink(path);
    });
    const logged: unknown[][] = [];
    const errorSpy = spyOn(console, 'error').mockImplementation((...line: unknown[]) => {
      logged.push(line);
    });
    const own = new Error('the guarded work failed');
    try {
      expect(() =>
        withUnixSocketLockSync(sockPath, () => {
          throw own;
        }),
      ).toThrow(own);
      expect(logged).toHaveLength(1);
    } finally {
      unlinkSpy.mockRestore();
      errorSpy.mockRestore();
      rmSync(lockPath, { force: true });
    }
  });
});
