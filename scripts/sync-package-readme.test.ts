import { expect, test } from 'bun:test';
import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { syncPackageReadme } from './sync-package-readme';

test('package README sync preserves identical input metadata and copies changed or missing bytes', async () => {
  const root = await mkdtemp(join(tmpdir(), 'readme-generation-'));
  try {
    await mkdir(join(root, 'packages/core'), { recursive: true });
    await writeFile(join(root, 'README.md'), 'source');
    const target = join(root, 'packages/core/README.md');
    await syncPackageReadme(root);
    expect(await readFile(target, 'utf8')).toBe('source');
    const before = await stat(target, { bigint: true });
    await syncPackageReadme(root);
    const after = await stat(target, { bigint: true });
    expect(after.ino).toBe(before.ino);
    expect(after.ctimeNs).toBe(before.ctimeNs);
    expect(after.mtimeNs).toBe(before.mtimeNs);
    await writeFile(join(root, 'README.md'), 'changed');
    await syncPackageReadme(root);
    expect(await readFile(target, 'utf8')).toBe('changed');
    await rm(target);
    await mkdir(target);
    await expect(syncPackageReadme(root)).rejects.toMatchObject({ code: 'EISDIR' });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
