import { expect, test } from 'bun:test';
import { mkdtemp, readFile, rm, stat, utimes, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { withExclusiveLock } from '../src/entrypoints/files';
import { attemptExclusiveLock } from '../src/internal/exclusive-lock';

const depthLimit = 16;

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), 'lock-guard-depth-'));
  const owner = await withExclusiveLock(join(root, 'owner'), (held) => held.owner);
  if (!owner.process) throw new Error('Native process identity is required by this control');
  return {
    root,
    owner,
    stale: JSON.stringify({
      ...owner,
      process: { ...owner.process, bootId: 'previous-boot' },
    }),
  };
}

test('guard recovery admits the finite depth boundary and refuses its next descent without mutation', async () => {
  const { root, stale } = await fixture();
  try {
    for (const depth of [1, depthLimit - 1, depthLimit, depthLimit + 1]) {
      const path = join(root, `lock-${depth}`);
      const files = Array.from(
        { length: depth },
        (_, index) => path + '.reclaim'.repeat(index),
      );
      for (const file of files) await writeFile(file, stale);
      const before = await Promise.all(
        files.map(async (file) => ({
          bytes: await readFile(file, 'utf8'),
          ino: (await stat(file)).ino,
        })),
      );
      const attempt = await attemptExclusiveLock(path, { mode: 0o600, reclaim: true });
      if (depth <= depthLimit) {
        expect('held' in attempt).toBe(true);
        if (!('held' in attempt)) throw attempt.error;
        await attempt.held.release();
      } else {
        if ('held' in attempt) {
          await attempt.held.release();
        }
        expect('held' in attempt).toBe(false);
        if ('held' in attempt) throw new Error('Unbounded recovery admitted the next guard');
        expect(attempt.error).toMatchObject({ code: 'EEXIST', dest: path });
        expect(attempt.diagnosis?.cause).toBeInstanceOf(Error);
        expect(String(attempt.diagnosis?.cause)).toContain('reclaim guard recovery depth');
        expect(
          await Promise.all(
            files.map(async (file) => ({
              bytes: await readFile(file, 'utf8'),
              ino: (await stat(file)).ino,
            })),
          ),
        ).toEqual(before);
      }
    }
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('generated guard path refusal keeps its native cause while caller path IO remains native', async () => {
  const { root, stale } = await fixture();
  try {
    const path = join(root, 'x'.repeat(248));
    await writeFile(path, stale);
    let calls = 0;
    await expect(
      withExclusiveLock(
        path,
        () => {
          calls++;
        },
        { timeoutMs: 0 },
      ),
    ).rejects.toMatchObject({
      code: 'LOCK_TIMEOUT',
      cause: { code: 'ENAMETOOLONG', dest: `${path}.reclaim` },
    });
    expect(calls).toBe(0);
    expect(await readFile(path, 'utf8')).toBe(stale);
    await expect(
      withExclusiveLock(join(root, 'x'.repeat(256)), () => undefined, { timeoutMs: 0 }),
    ).rejects.toMatchObject({ code: 'ENAMETOOLONG' });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('live and unknown guard owners are protected and cancellation never invokes work', async () => {
  const { root, owner, stale } = await fixture();
  try {
    const path = join(root, 'lock');
    const guard = `${path}.reclaim`;
    for (const bytes of [JSON.stringify(owner), 'unknown']) {
      await writeFile(path, stale);
      await writeFile(guard, bytes);
      await utimes(guard, 1, 1);
      const ino = (await stat(guard)).ino;
      await expect(
        withExclusiveLock(
          path,
          () => {
            throw new Error('unsafe callback');
          },
          {
            timeoutMs: 0,
            ownerlessGraceMs: null,
          },
        ),
      ).rejects.toMatchObject({ code: 'LOCK_TIMEOUT' });
      expect(await readFile(guard, 'utf8')).toBe(bytes);
      expect((await stat(guard)).ino).toBe(ino);
    }
    const controller = new AbortController();
    const cause = new Error('cancelled');
    controller.abort(cause);
    await expect(
      withExclusiveLock(
        path,
        () => {
          throw new Error('aborted callback');
        },
        {
          signal: controller.signal,
        },
      ),
    ).rejects.toMatchObject({ code: 'LOCK_ABORTED', cause });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
