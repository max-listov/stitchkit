import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { withExclusiveLock } from 'stitchkit/files';
import { verifyExclusiveLockBoundaries } from './exclusive-lock-boundaries.mjs';

const root = await mkdtemp(path.join(tmpdir(), 'stitchkit-packed-lock-'));
const lockPath = path.join(root, 'owner.lock');
const options = { machineIdentity: 'packed-process-identity', timeoutMs: 0 };
try {
  const owner = await withExclusiveLock(
    lockPath,
    async (lock) => {
      assert.equal(lock.owner.process?.platform, process.platform);
      assert.ok(lock.owner.process?.bootId);
      assert.match(lock.owner.process?.startId ?? '', /^\d+$/);
      assert.equal(
        JSON.parse(await readFile(lockPath, 'utf8')).process.bootId,
        lock.owner.process.bootId,
      );
      await assert.rejects(
        withExclusiveLock(lockPath, () => undefined, options),
        /gave up/,
      );
      return lock.owner;
    },
    options,
  );
  for (const processIdentity of [
    { ...owner.process, bootId: 'previous-boot' },
    { ...owner.process, startId: `${owner.process.startId}0` },
  ]) {
    await writeFile(lockPath, JSON.stringify({ ...owner, process: processIdentity }));
    assert.equal(await withExclusiveLock(lockPath, (lock) => lock.reclaimed, options), true);
  }
  await writeFile(lockPath, JSON.stringify({ ...owner, process: null }));
  await assert.rejects(
    withExclusiveLock(lockPath, () => undefined, options),
    /gave up/,
  );
  verifyExclusiveLockBoundaries();
  console.log('packed exclusive lock process identity: ok');
} finally {
  await rm(root, { recursive: true, force: true });
}
