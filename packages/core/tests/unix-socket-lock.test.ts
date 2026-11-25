import { afterAll, beforeAll, describe, expect, spyOn, test } from 'bun:test';
import {
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import { hostname, tmpdir } from 'node:os';
import { join } from 'node:path';
import { OWNER_RECORD_BYTES } from '../src/internal/exclusive-lock-read';
import { machineIdentitySync } from '../src/internal/process-identity';
import {
  type ProcessInstance,
  readProcessInstanceSync,
} from '../src/internal/process-instance';
import {
  MAX_RECLAIM_DEPTH,
  tryReclaimDeadLock,
  withUnixSocketLockSync,
} from '../src/internal/unix-socket-lock';
import { reapAfterEachTest, trackProcess } from './support/process-reaper';

reapAfterEachTest();

let root = '';
let counter = 0;

function instanceOf(pid: number): ProcessInstance {
  const instance = readProcessInstanceSync(pid);
  if (instance === null) throw new Error(`no process instance for ${pid}`);
  return instance;
}

/** The owner record the lock writes, naming `pid` with the recorded process lifetime. */
function ownerRecord(pid: number, instance: ProcessInstance): string {
  const machine = machineIdentitySync(undefined);
  return `${JSON.stringify({
    pid,
    process: instance,
    host: hostname(),
    acquiredAt: new Date().toISOString(),
    ...(machine !== null && { machine }),
  })}\n`;
}

/** A record of an exited process of this boot: its PID no longer answers. */
function deadRecord(pid: number): string {
  return ownerRecord(pid, { ...instanceOf(process.pid), startId: '1' });
}

/**
 * A record of a live process that is not this one, with its own lifetime. The process lives until
 * the reaper ends it after the test.
 */
function liveRecord(): string {
  const child = Bun.spawn({
    cmd: [process.execPath, '-e', 'setInterval(() => undefined, 1_000)'],
    stdout: 'ignore',
    stderr: 'ignore',
  });
  trackProcess(child.pid);
  return ownerRecord(child.pid, instanceOf(child.pid));
}

function recordedPid(path: string): number {
  return JSON.parse(readFileSync(path, 'utf8')).pid;
}

beforeAll(() => {
  root = mkdtempSync(join(tmpdir(), 'skl-'));
});

afterAll(() => {
  rmSync(root, { recursive: true, force: true });
});

function nextLockCase(name: string): {
  sockPath: string;
  lockPath: string;
  guardPath: string;
} {
  counter += 1;
  const sockName = `${name}-${counter}.sock`;
  const sockPath = join(root, sockName);
  const lockPath = join(root, `.${sockName}.lock`);
  const guardPath = `${lockPath}.reclaim`;
  return { sockPath, lockPath, guardPath };
}

async function allocateDeadPid(): Promise<number> {
  const child = Bun.spawn({ cmd: [process.execPath, '-e', 'process.exit(0)'] });
  trackProcess(child.pid);
  await child.exited;
  return child.pid;
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

describe('unix socket startup lock and atomic reclaim guard', () => {
  test('publishes lock and .reclaim guard with exact 0o600 permissions even under umask(0o777)', async () => {
    const deadPid = await allocateDeadPid();
    const { sockPath, lockPath, guardPath } = nextLockCase('umask-777');
    writeFileSync(lockPath, deadRecord(deadPid), { mode: 0o600 });

    const realKill = process.kill.bind(process);
    let observedGuardMode = -1;
    const killSpy = spyOn(process, 'kill').mockImplementation((pid, signal) => {
      if (pid === deadPid && signal === 0 && existsSync(guardPath)) {
        observedGuardMode = lstatSync(guardPath).mode & 0o777;
      }
      return realKill(pid, signal);
    });

    const savedUmask = process.umask(0o777);
    let observedLockMode = -1;
    try {
      withUnixSocketLockSync(
        sockPath,
        () => {
          observedLockMode = lstatSync(lockPath).mode & 0o777;
        },
        500,
      );
    } finally {
      process.umask(savedUmask);
      killSpy.mockRestore();
    }

    expect(observedGuardMode).toBe(0o600);
    expect(observedLockMode).toBe(0o600);
    expect(existsSync(lockPath)).toBe(false);
    expect(existsSync(guardPath)).toBe(false);
  });

  test('refuses to unlink a dead lock while a live .reclaim guard is held', async () => {
    const deadPid = await allocateDeadPid();
    const { sockPath, lockPath, guardPath } = nextLockCase('live-guard');
    writeFileSync(lockPath, deadRecord(deadPid), { mode: 0o600 });
    writeFileSync(guardPath, liveRecord(), { mode: 0o600 });
    const originalLock = lstatSync(lockPath);
    const originalGuard = lstatSync(guardPath);

    try {
      expect(() => withUnixSocketLockSync(sockPath, () => 'entered', 60)).toThrow(
        'timed out waiting for unix socket startup lock',
      );
      const afterLock = lstatSync(lockPath);
      expect(afterLock.dev).toBe(originalLock.dev);
      expect(afterLock.ino).toBe(originalLock.ino);
      const afterGuard = lstatSync(guardPath);
      expect(afterGuard.dev).toBe(originalGuard.dev);
      expect(afterGuard.ino).toBe(originalGuard.ino);
    } finally {
      rmSync(lockPath, { force: true });
      rmSync(guardPath, { force: true });
    }
  });

  test('never follows, reads, or unlinks a symlink at .reclaim or lockPath', async () => {
    const deadPid = await allocateDeadPid();
    const { sockPath, lockPath, guardPath } = nextLockCase('sym-guard');
    const target = join(root, `sym-guard-target-${counter}.txt`);
    writeFileSync(target, deadRecord(deadPid), { mode: 0o600 });
    writeFileSync(lockPath, deadRecord(deadPid), { mode: 0o600 });
    symlinkSync(target, guardPath);
    const originalLock = lstatSync(lockPath);

    try {
      expect(() => withUnixSocketLockSync(sockPath, () => 'entered', 60)).toThrow(
        'timed out waiting for unix socket startup lock',
      );
      expect(lstatSync(guardPath).isSymbolicLink()).toBe(true);
      expect(existsSync(target)).toBe(true);
      expect(lstatSync(lockPath).ino).toBe(originalLock.ino);
    } finally {
      rmSync(guardPath, { force: true });
      rmSync(lockPath, { force: true });
      rmSync(target, { force: true });
    }
  });

  test('recovers from a dead .reclaim guard (and nested dead guard) and leaves no guard behind', async () => {
    const deadPid = await allocateDeadPid();
    const { sockPath, lockPath, guardPath } = nextLockCase('dead-guard');
    const nestedGuardPath = `${guardPath}.reclaim`;
    writeFileSync(lockPath, deadRecord(deadPid), { mode: 0o600 });
    writeFileSync(guardPath, deadRecord(deadPid), { mode: 0o600 });
    writeFileSync(nestedGuardPath, deadRecord(deadPid), { mode: 0o600 });

    const result = withUnixSocketLockSync(
      sockPath,
      () => {
        expect(recordedPid(lockPath)).toBe(process.pid);
        expect(existsSync(guardPath)).toBe(false);
        expect(existsSync(nestedGuardPath)).toBe(false);
        return 'recovered';
      },
      1_000,
    );

    expect(result).toBe('recovered');
    expect(existsSync(lockPath)).toBe(false);
    expect(existsSync(guardPath)).toBe(false);
    expect(existsSync(nestedGuardPath)).toBe(false);
  });

  test('EPERM from process.kill and deterministic lock replacement during reclaim preserve the live lock', async () => {
    const deadPid = await allocateDeadPid();

    // Case 1: EPERM from process.kill means the PID belongs to another live user — never reclaim.
    const epermCase = nextLockCase('eperm-kill');
    writeFileSync(epermCase.lockPath, deadRecord(deadPid), { mode: 0o600 });
    const epermIno = lstatSync(epermCase.lockPath).ino;
    const realKill = process.kill.bind(process);
    const epermSpy = spyOn(process, 'kill').mockImplementation((pid, signal) => {
      if (pid === deadPid && signal === 0) {
        const error = Object.assign(new Error('Operation not permitted'), { code: 'EPERM' });
        throw error;
      }
      return realKill(pid, signal);
    });
    try {
      expect(() => withUnixSocketLockSync(epermCase.sockPath, () => 'entered', 60)).toThrow(
        'timed out waiting for unix socket startup lock',
      );
      expect(lstatSync(epermCase.lockPath).ino).toBe(epermIno);
    } finally {
      epermSpy.mockRestore();
      rmSync(epermCase.lockPath, { force: true });
    }

    // Case 2: Lock replaced with a live holder between pre-check and guard re-read is never unlinked.
    const replaceCase = nextLockCase('replace-race');
    const replacement = liveRecord();
    writeFileSync(replaceCase.lockPath, deadRecord(deadPid), { mode: 0o600 });
    let replacedIno = -1;
    let swapped = false;
    const replaceSpy = spyOn(process, 'kill').mockImplementation((pid, signal) => {
      if (pid === deadPid && signal === 0 && !swapped) {
        swapped = true;
        unlinkSync(replaceCase.lockPath);
        writeFileSync(replaceCase.lockPath, replacement, { mode: 0o600 });
        replacedIno = lstatSync(replaceCase.lockPath).ino;
      }
      return realKill(pid, signal);
    });
    try {
      expect(() => withUnixSocketLockSync(replaceCase.sockPath, () => 'entered', 60)).toThrow(
        'timed out waiting for unix socket startup lock',
      );
      expect(swapped).toBe(true);
      expect(existsSync(replaceCase.lockPath)).toBe(true);
      expect(lstatSync(replaceCase.lockPath).ino).toBe(replacedIno);
      expect(readFileSync(replaceCase.lockPath, 'utf8')).toBe(replacement);
    } finally {
      replaceSpy.mockRestore();
      rmSync(replaceCase.lockPath, { force: true });
      rmSync(replaceCase.guardPath, { force: true });
    }

    // Case 3: Non-regular file (directory) at lockPath is never unlinked and times out cleanly.
    const dirCase = nextLockCase('dir-lock');
    mkdirSync(dirCase.lockPath, { mode: 0o700 });
    try {
      expect(() => withUnixSocketLockSync(dirCase.sockPath, () => 'entered', 60)).toThrow(
        'timed out waiting for unix socket startup lock',
      );
      expect(lstatSync(dirCase.lockPath).isDirectory()).toBe(true);
    } finally {
      rmSync(dirCase.lockPath, { recursive: true, force: true });
    }
  });

  test('concurrent processes racing a dead startup lock maintain strict mutual exclusion', async () => {
    const deadPid = await allocateDeadPid();
    const { sockPath, lockPath, guardPath } = nextLockCase('multi-race');
    const activeSentinel = join(root, `active-${counter}.flag`);
    const logPath = join(root, `order-${counter}.log`);
    const unixSocketModule = join(import.meta.dir, '../src/internal/unix-socket-lock.ts');
    writeFileSync(lockPath, deadRecord(deadPid), { mode: 0o600 });

    const workerScript = [
      `import { appendFileSync, closeSync, lstatSync, openSync, readFileSync, unlinkSync } from 'node:fs';`,
      `import { withUnixSocketLockSync } from ${JSON.stringify(unixSocketModule)};`,
      'const sockPath = Bun.env.SOCK_PATH ?? "";',
      'const lockPath = Bun.env.LOCK_PATH ?? "";',
      'const activePath = Bun.env.ACTIVE_PATH ?? "";',
      'const logPath = Bun.env.LOG_PATH ?? "";',
      'const id = Bun.env.WORKER_ID ?? "";',
      'const sleepBuf = new Int32Array(new SharedArrayBuffer(4));',
      'process.stdout.write("ready\\n");',
      'for await (const _chunk of Bun.stdin.stream()) { break; }',
      'withUnixSocketLockSync(sockPath, () => {',
      '  const fd = openSync(activePath, "wx", 0o600);',
      '  closeSync(fd);',
      '  try {',
      '    const before = lstatSync(lockPath);',
      '    if (JSON.parse(readFileSync(lockPath, "utf8")).pid !== process.pid) {',
      '      throw new Error("lock pid mismatch on entry");',
      '    }',
      '    Atomics.wait(sleepBuf, 0, 0, 35);',
      '    const after = lstatSync(lockPath);',
      '    if (after.dev !== before.dev || after.ino !== before.ino) {',
      '      throw new Error("live lock inode was replaced while held");',
      '    }',
      '    appendFileSync(logPath, id + "\\n");',
      '  } finally {',
      '    unlinkSync(activePath);',
      '  }',
      '}, 5_000);',
    ].join('\n');

    const workers = Array.from({ length: 4 }, (_, index) => {
      const child = Bun.spawn({
        cmd: [process.execPath, '-e', workerScript],
        env: {
          ...process.env,
          SOCK_PATH: sockPath,
          LOCK_PATH: lockPath,
          ACTIVE_PATH: activeSentinel,
          LOG_PATH: logPath,
          WORKER_ID: `w${index}`,
        },
        stdin: 'pipe',
        stdout: 'pipe',
        stderr: 'pipe',
      });
      trackProcess(child.pid);
      return child;
    });

    const readers = workers.map((child) => createLineReader(child.stdout));
    try {
      expect(await Promise.all(readers.map((read) => read()))).toEqual([
        'ready',
        'ready',
        'ready',
        'ready',
      ]);
      for (const child of workers) child.stdin.write('go\n');
      await Promise.all(workers.map((child) => child.stdin.flush()));

      const exits = await Promise.all(workers.map((child) => child.exited));
      const stderrs = await Promise.all(
        workers.map((child) => new Response(child.stderr).text()),
      );
      expect(stderrs).toEqual(['', '', '', '']);
      expect(exits).toEqual([0, 0, 0, 0]);
      const completed = readFileSync(logPath, 'utf8').trim().split('\n').sort();
      expect(completed).toEqual(['w0', 'w1', 'w2', 'w3']);
      expect(existsSync(lockPath)).toBe(false);
      expect(existsSync(guardPath)).toBe(false);
      expect(existsSync(activeSentinel)).toBe(false);
    } finally {
      for (const child of workers) child.stdin.end();
      rmSync(activeSentinel, { force: true });
      rmSync(logPath, { force: true });
    }
  }, 15_000);

  test('pinned fd prevents inode reuse during under-guard replacement and O_NOFOLLOW blocks swapped symlinks', async () => {
    const deadPid = await allocateDeadPid();
    const realKill = process.kill.bind(process);

    // Case 1: Lock replaced during the SECOND process.kill (under guard, while entry.fd is open).
    // Pinning entry.fd prevents the kernel from reusing the dead inode number for the new live lock.
    const pinCase = nextLockCase('pin-fd');
    const replacement = liveRecord();
    writeFileSync(pinCase.lockPath, deadRecord(deadPid), { mode: 0o600 });
    let killCalls = 0;
    let liveIno = -1;
    const pinSpy = spyOn(process, 'kill').mockImplementation((pid, signal) => {
      if (pid === deadPid && signal === 0) {
        killCalls += 1;
        if (killCalls === 2) {
          unlinkSync(pinCase.lockPath);
          writeFileSync(pinCase.lockPath, replacement, { mode: 0o600 });
          liveIno = lstatSync(pinCase.lockPath).ino;
        }
      }
      return realKill(pid, signal);
    });
    try {
      expect(tryReclaimDeadLock(pinCase.lockPath)).toBe(false);
      expect(killCalls).toBe(2);
      expect(existsSync(pinCase.lockPath)).toBe(true);
      expect(lstatSync(pinCase.lockPath).ino).toBe(liveIno);
      expect(readFileSync(pinCase.lockPath, 'utf8')).toBe(replacement);
      expect(existsSync(pinCase.guardPath)).toBe(false);
    } finally {
      pinSpy.mockRestore();
      rmSync(pinCase.lockPath, { force: true });
      rmSync(pinCase.guardPath, { force: true });
    }

    // Case 2: Symlink swapped in at lockPath between pre-check and under-guard O_NOFOLLOW re-read.
    const symSwapCase = nextLockCase('sym-swap');
    const symTarget = join(root, `sym-swap-target-${counter}.txt`);
    writeFileSync(symTarget, deadRecord(deadPid), { mode: 0o600 });
    writeFileSync(symSwapCase.lockPath, deadRecord(deadPid), { mode: 0o600 });
    let swappedToSymlink = false;
    const symSpy = spyOn(process, 'kill').mockImplementation((pid, signal) => {
      if (pid === deadPid && signal === 0 && !swappedToSymlink) {
        swappedToSymlink = true;
        unlinkSync(symSwapCase.lockPath);
        symlinkSync(symTarget, symSwapCase.lockPath);
      }
      return realKill(pid, signal);
    });
    try {
      expect(tryReclaimDeadLock(symSwapCase.lockPath)).toBe(false);
      expect(swappedToSymlink).toBe(true);
      expect(lstatSync(symSwapCase.lockPath).isSymbolicLink()).toBe(true);
      expect(existsSync(symTarget)).toBe(true);
      expect(existsSync(symSwapCase.guardPath)).toBe(false);
    } finally {
      symSpy.mockRestore();
      rmSync(symSwapCase.lockPath, { force: true });
      rmSync(symSwapCase.guardPath, { force: true });
      rmSync(symTarget, { force: true });
    }
  });

  test('bounds nested .reclaim recovery at MAX_RECLAIM_DEPTH and refuses FIFO/oversized/malformed locks', async () => {
    const deadPid = await allocateDeadPid();

    // Chain of MAX_RECLAIM_DEPTH dead .reclaim guards exceeds the recursion ceiling and refuses cleanly.
    const depthCase = nextLockCase('d');
    const chainPaths: string[] = [depthCase.lockPath];
    let current = depthCase.lockPath;
    for (let level = 0; level < MAX_RECLAIM_DEPTH; level += 1) {
      current = `${current}.reclaim`;
      chainPaths.push(current);
    }
    for (const filePath of chainPaths) {
      writeFileSync(filePath, deadRecord(deadPid), { mode: 0o600 });
    }
    const rootLockIno = lstatSync(depthCase.lockPath).ino;
    try {
      expect(tryReclaimDeadLock(depthCase.lockPath)).toBe(false);
      expect(lstatSync(depthCase.lockPath).ino).toBe(rootLockIno);
    } finally {
      for (const filePath of chainPaths.reverse()) rmSync(filePath, { force: true });
    }

    // Oversized or ownerless regular lock files younger than the ownerless grace are never unlinked.
    const malformedCase = nextLockCase('malformed');
    writeFileSync(malformedCase.lockPath, 'not-a-pid\n', { mode: 0o600 });
    const malformedIno = lstatSync(malformedCase.lockPath).ino;
    try {
      expect(tryReclaimDeadLock(malformedCase.lockPath)).toBe(false);
      expect(lstatSync(malformedCase.lockPath).ino).toBe(malformedIno);
    } finally {
      rmSync(malformedCase.lockPath, { force: true });
    }

    const oversizedCase = nextLockCase('oversized');
    writeFileSync(oversizedCase.lockPath, `${'9'.repeat(OWNER_RECORD_BYTES)}\n`, {
      mode: 0o600,
    });
    const oversizedIno = lstatSync(oversizedCase.lockPath).ino;
    try {
      expect(tryReclaimDeadLock(oversizedCase.lockPath)).toBe(false);
      expect(lstatSync(oversizedCase.lockPath).ino).toBe(oversizedIno);
    } finally {
      rmSync(oversizedCase.lockPath, { force: true });
    }

    // A FIFO at lockPath opens with O_NONBLOCK without hanging, fails isFile(), and is never unlinked.
    const fifoCase = nextLockCase('fifo');
    const mkfifo = Bun.spawnSync({ cmd: ['mkfifo', fifoCase.lockPath] });
    if (mkfifo.exitCode === 0) {
      try {
        expect(tryReclaimDeadLock(fifoCase.lockPath)).toBe(false);
        expect(lstatSync(fifoCase.lockPath).isFIFO()).toBe(true);
      } finally {
        rmSync(fifoCase.lockPath, { force: true });
      }
    }
  });
});
