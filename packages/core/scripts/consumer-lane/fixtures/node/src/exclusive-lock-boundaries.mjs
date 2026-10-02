import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { link, lstat, mkdir, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { withExclusiveLock } from 'stitchkit/files';

async function controls(root) {
  try {
    const lock = join(root, 'abort');
    const controller = new AbortController();
    const cause = new Error('queued acquisition cancelled');
    let calls = 0;
    const pending = withExclusiveLock(
      lock,
      () => {
        calls++;
      },
      { signal: controller.signal },
    );
    controller.abort(cause);
    await assert.rejects(
      pending,
      (error) => error.code === 'LOCK_ABORTED' && error.cause === cause,
    );
    assert.equal(calls, 0);
    await withExclusiveLock(lock, () => {
      calls++;
    });
    assert.equal(calls, 1);
    await assert.rejects(
      withExclusiveLock(
        lock,
        () => {
          calls++;
        },
        { signal: controller.signal },
      ),
      (error) => error.code === 'LOCK_ABORTED' && error.cause === cause,
    );
    assert.equal(calls, 1);

    for (const guard of [false, true]) {
      for (const kind of ['fifo', 'directory', 'symlink', 'hardlink', 'oversize']) {
        const main = join(root, `${guard ? 'guard' : 'lock'}-${kind}`);
        const leaf = guard ? `${main}.reclaim` : main;
        if (guard) await writeFile(main, '');
        const target = `${leaf}-target`;
        if (kind === 'fifo') execFileSync('mkfifo', [leaf]);
        if (kind === 'directory') await mkdir(leaf);
        if (kind === 'symlink') {
          await writeFile(target, 'unowned');
          await symlink(target, leaf);
        }
        if (kind === 'hardlink') {
          await writeFile(target, 'unowned');
          await link(target, leaf);
        }
        if (kind === 'oversize') await writeFile(leaf, 'x'.repeat(16_385));
        const before = await lstat(leaf);
        let callbacks = 0;
        await assert.rejects(
          withExclusiveLock(
            main,
            () => {
              callbacks++;
            },
            { timeoutMs: 30, ownerlessGraceMs: 0 },
          ),
          (error) => error.code === 'LOCK_TIMEOUT' && error.cause !== undefined,
        );
        assert.equal(callbacks, 0);
        const after = await lstat(leaf);
        assert.equal(after.ino, before.ino);
        assert.equal(after.dev, before.dev);
        if (guard) assert.ok(await lstat(main));
      }
    }
  } finally {
    await rm(root, { recursive: true, force: true });
  }
  console.log('packed exclusive lock unsafe boundaries: ok');
}

export function verifyExclusiveLockBoundaries() {
  // The parent owns the watchdog even if a regressed FIFO open wedges the worker.
  const root = mkdtempSync(join(tmpdir(), 'packed-lock-boundary-'));
  try {
    const result = execFileSync(
      process.execPath,
      [fileURLToPath(import.meta.url), 'worker', root],
      {
        encoding: 'utf8',
        timeout: 10_000,
        killSignal: 'SIGKILL',
        stdio: ['ignore', 'pipe', 'pipe'],
      },
    );
    assert.ok(result.split(/\r?\n/).includes('packed exclusive lock unsafe boundaries: ok'));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

if (process.argv[2] === 'worker') {
  assert.ok(process.argv[3]);
  await controls(process.argv[3]);
}
