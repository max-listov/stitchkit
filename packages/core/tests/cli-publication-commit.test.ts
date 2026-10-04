import { expect, spyOn, test } from 'bun:test';
import { readFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import * as atomic from '../src/internal/atomic-file';
import { AtomicFilePublicationError } from '../src/internal/atomic-publication';
import { publicationFixture } from './cli-publication.fixture';

test('post-pointer commit failure preserves published flag and exact cause without rollback', async () => {
  const f = await publicationFixture();
  const original = atomic.writeFileAtomic;
  const cause = new Error('injected directory sync fault after real pointer publication');
  const fault = new AtomicFilePublicationError('directory-sync', cause);
  let inject = false;
  const writer = spyOn(atomic, 'writeFileAtomic').mockImplementation(
    async (path, bytes, options) => {
      await original(path, bytes, options);
      if (inject && path === join(f.storageRoot, 'manifest.json')) throw fault;
    },
  );
  try {
    await f.publish();
    inject = true;
    await expect(f.publish({ version: '1.1.0' })).rejects.toBe(fault);
    expect(fault.published).toBe(true);
    expect(fault.cause).toBe(cause);
    const pointer = await f.manifest();
    expect(JSON.parse(pointer).version).toBe('1.1.0');
    expect(await readFile(join(f.storageRoot, '1.1.0', 'manifest.json'), 'utf8')).toBe(
      pointer,
    );
    writer.mockRestore();
    f.builds.length = 0;
    expect((await f.publish({ version: '1.1.0' })).outcome).toBe('existing');
    expect(f.builds).toEqual([]);
    expect(await f.manifest()).toBe(pointer);
  } finally {
    writer.mockRestore();
    await rm(f.root, { recursive: true });
  }
});
