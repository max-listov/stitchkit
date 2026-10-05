import { afterEach, expect, spyOn, test } from 'bun:test';
import { access, mkdir, readdir, rm, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import * as assets from '../src/tools/cli/publication-assets';
import { publicationFixture } from './cli-publication.fixture';

const roots: string[] = [];
afterEach(async () => {
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true });
});
async function fixture() {
  const f = await publicationFixture();
  roots.push(f.root);
  return f;
}

test('a publisher killed mid-build leaves staging that the next publication removes under its lock', async () => {
  const f = await fixture();
  const ready = join(f.root, 'ready');
  const child = Bun.spawn(
    [
      process.execPath,
      join(dirname(import.meta.path), 'cli-publication-child.ts'),
      f.storageRoot,
      ready,
    ],
    { stdout: 'pipe', stderr: 'pipe' },
  );
  try {
    // The child announces itself by creating `ready` once its build is running.
    for (let attempt = 0; attempt < 1_000; attempt += 1) {
      try {
        await access(ready);
        break;
      } catch {
        await Bun.sleep(5);
      }
    }
    await access(ready);
    child.kill('SIGKILL');
    await child.exited;
    const orphans = (await readdir(f.storageRoot)).filter((name) =>
      name.startsWith('.publish-'),
    );
    expect(orphans).toHaveLength(1);
    // A second dead build, so the leftovers alone would fill the entry cap below.
    await mkdir(join(f.storageRoot, '.publish-AbC123', 'nested'), { recursive: true });
    await writeFile(
      join(f.storageRoot, '.publish-AbC123', 'nested', 'app-linux-x64.gz'),
      'half',
    );
    const limits = { maxDirectoryEntries: 4, lockTimeoutMs: 100 };
    const result = await f.publish({ limits, targets: [{ platform: 'linux', arch: 'x64' }] });
    expect(result.outcome).toBe('published');
    expect(
      (await readdir(f.storageRoot)).filter((name) => name.startsWith('.publish-')),
    ).toEqual([]);
  } finally {
    child.kill('SIGKILL');
  }
});

test('staging that is not a publisher directory is left alone', async () => {
  const f = await fixture();
  await f.publish();
  await writeFile(join(f.storageRoot, '.publish-notes'), 'mine');
  await mkdir(join(f.storageRoot, '.publish-too-long-to-be-ours'));
  await f.publish({ version: '1.1.0' });
  expect(
    (await readdir(f.storageRoot)).filter((name) => name.startsWith('.publish-')).sort(),
  ).toEqual(['.publish-notes', '.publish-too-long-to-be-ours']);
});

test('a publication decompresses each stored version once and the new version once', async () => {
  const f = await fixture();
  const decode = spyOn(assets, 'decodeCliAsset');
  try {
    const targets = f.options.targets.length;
    const decodes = async (version: string) => {
      decode.mockClear();
      await f.publish({ version });
      return decode.mock.calls.length;
    };
    expect(await decodes('1.0.0')).toBe(targets);
    // One stored version and one new one.
    expect(await decodes('1.1.0')).toBe(2 * targets);
    // Two stored versions and one new one; retention removes the oldest without proving it again.
    expect(await decodes('1.2.0')).toBe(3 * targets);
    expect(
      await readdir(f.storageRoot).then((names) => names.filter((n) => /^\d/.test(n)).sort()),
    ).toEqual(['1.1.0', '1.2.0']);
    // Publishing the current version again proves the stored versions once and builds nothing.
    expect(await decodes('1.2.0')).toBe(2 * targets);
  } finally {
    decode.mockRestore();
  }
});
