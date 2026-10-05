import { afterEach, expect, test } from 'bun:test';
import { execFileSync } from 'node:child_process';
import {
  appendFileSync,
  existsSync,
  linkSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { open } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ExclusiveLockError, withExclusiveLock } from '../src/entrypoints/files';
import { LockRecordError, readLockRecord } from '../src/internal/exclusive-lock-read';

const roots: string[] = [];
function fixture() {
  const root = mkdtempSync(join(tmpdir(), 'stitchkit-lock-boundary-'));
  roots.push(root);
  return join(root, 'owner.lock');
}
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

test('abort during first acquisition never calls work and releases the acquired lock', async () => {
  const path = fixture();
  const controller = new AbortController();
  const cause = new Error('caller cancelled');
  let calls = 0;
  const pending = withExclusiveLock(
    path,
    () => {
      calls++;
    },
    { signal: controller.signal },
  );
  controller.abort(cause);
  const error = await pending.catch((error: unknown) => error);
  expect(error).toBeInstanceOf(ExclusiveLockError);
  if (!(error instanceof ExclusiveLockError)) throw error;
  expect(error.code).toBe('LOCK_ABORTED');
  expect(error.cause).toBe(cause);
  expect(calls).toBe(0);
  expect(existsSync(path)).toBe(false);
  await withExclusiveLock(path, () => {
    calls++;
  });
  expect(calls).toBe(1);
});

test('pre-abort does not create a lock; abort inside work preserves its result', async () => {
  const path = fixture();
  const before = new AbortController();
  before.abort('before');
  await expect(
    withExclusiveLock(
      path,
      () => {
        throw new Error('unexpected callback');
      },
      { signal: before.signal },
    ),
  ).rejects.toThrow(ExclusiveLockError);
  expect(existsSync(path)).toBe(false);
  const during = new AbortController();
  expect(
    await withExclusiveLock(
      path,
      () => {
        during.abort();
        return 17;
      },
      { signal: during.signal },
    ),
  ).toBe(17);
});

for (const kind of ['fifo', 'directory', 'symlink', 'hardlink', 'oversize', 'device']) {
  test(`unsafe ${kind} owner record is refused without unlink or callback`, async () => {
    const path = fixture();
    if (kind === 'fifo') execFileSync('mkfifo', [path]);
    if (kind === 'directory') mkdirSync(path);
    if (kind === 'symlink') symlinkSync('/dev/null', path);
    if (kind === 'hardlink') {
      writeFileSync(`${path}.peer`, '');
      linkSync(`${path}.peer`, path);
    }
    if (kind === 'oversize') writeFileSync(path, 'x'.repeat(16385));
    // Device checks use its real descriptor directly: a symlink must be refused before open.
    if (kind === 'device') {
      await expect(readLockRecord('/dev/null')).rejects.toThrow(LockRecordError);
      return;
    }
    let calls = 0;
    const started = performance.now();
    const error = await withExclusiveLock(
      path,
      () => {
        calls++;
      },
      { timeoutMs: 30, ownerlessGraceMs: 0 },
    ).catch((error: unknown) => error);
    expect(error).toBeInstanceOf(ExclusiveLockError);
    if (!(error instanceof ExclusiveLockError)) throw error;
    expect(error.code).toBe('LOCK_TIMEOUT');
    expect(error.cause).toBeDefined();
    expect(calls).toBe(0);
    expect(performance.now() - started).toBeLessThan(1000);
    expect(existsSync(path)).toBe(true);
  });
}

for (const kind of ['fifo', 'directory', 'symlink', 'hardlink', 'oversize']) {
  test(`unsafe ${kind} reclaim guard never removes the ownerless lock`, async () => {
    const path = fixture();
    writeFileSync(path, '');
    const guard = `${path}.reclaim`;
    if (kind === 'fifo') execFileSync('mkfifo', [guard]);
    if (kind === 'directory') mkdirSync(guard);
    if (kind === 'symlink') symlinkSync('/dev/null', guard);
    if (kind === 'hardlink') {
      writeFileSync(`${guard}.peer`, '');
      linkSync(`${guard}.peer`, guard);
    }
    if (kind === 'oversize') writeFileSync(guard, 'x'.repeat(16385));
    let calls = 0;
    await expect(
      withExclusiveLock(
        path,
        () => {
          calls++;
        },
        { timeoutMs: 30, ownerlessGraceMs: 0 },
      ),
    ).rejects.toThrow(ExclusiveLockError);
    expect(calls).toBe(0);
    expect(existsSync(path)).toBe(true);
    expect(existsSync(guard)).toBe(true);
  });
}

for (const growth of [1, 16385]) {
  test(`descriptor growth of ${growth} bytes is refused and the descriptor is closed`, async () => {
    const path = fixture();
    writeFileSync(path, '');
    let closed = false;
    const pending = readLockRecord(path, {
      openDescriptor: async (target, flags) => {
        const handle = await open(target, flags);
        let changed = false;
        return {
          stat: () => handle.stat(),
          read: async (buffer, offset, length) => {
            if (!changed) {
              changed = true;
              appendFileSync(path, 'x'.repeat(growth));
            }
            return handle.read(buffer, offset, length);
          },
          close: async () => {
            closed = true;
            await handle.close();
          },
        };
      },
    });
    const error = await pending.catch((error: unknown) => error);
    expect(error).toBeInstanceOf(LockRecordError);
    if (!(error instanceof LockRecordError)) throw error;
    expect(error.code).toBe(growth > 16384 ? 'LOCK_RECORD_TOO_LARGE' : 'LOCK_RECORD_CHANGED');
    expect(closed).toBe(true);
  });
}

test.skipIf(process.platform !== 'linux')(
  'repeated refused FIFO reads retain no file descriptors',
  async () => {
    const path = fixture();
    execFileSync('mkfifo', [path]);
    const count = readdirSync('/proc/self/fd').length;
    for (let i = 0; i < 50; i++)
      await expect(readLockRecord(path)).rejects.toThrow(LockRecordError);
    expect(readdirSync('/proc/self/fd').length).toBe(count);
  },
);

test('abort after descriptor stat refuses before byte read and closes the descriptor', async () => {
  const path = fixture();
  writeFileSync(path, '{}');
  const controller = new AbortController();
  const cause = new Error('cancel descriptor read');
  let reads = 0;
  let closed = false;
  const result = readLockRecord(path, {
    openDescriptor: async (target, flags) => {
      const handle = await open(target, flags);
      return {
        stat: async () => {
          const info = await handle.stat();
          controller.abort(cause);
          return info;
        },
        read: async (buffer, offset, length) => {
          reads++;
          return handle.read(buffer, offset, length);
        },
        close: async () => {
          closed = true;
          await handle.close();
        },
      };
    },
    signal: controller.signal,
  });
  expect(await result.catch((error: unknown) => error)).toBe(cause);
  expect(reads).toBe(0);
  expect(closed).toBe(true);
});
