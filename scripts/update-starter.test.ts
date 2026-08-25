import { afterAll, describe, expect, test } from 'bun:test';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  assertCatalogIsTheOnlyStitchkitRange,
  restoreCatalogReferences,
} from './starter-manifest';
import { lockedResolutions, rangeLike, resolutionChanges } from './update-starter';

const created: string[] = [];
afterAll(async () => {
  for (const path of created) await rm(path, { recursive: true, force: true });
});

async function tree(files: Record<string, unknown>): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'update-starter-'));
  created.push(root);
  for (const [relative, contents] of Object.entries(files)) {
    const path = join(root, relative);
    await mkdir(join(path, '..'), { recursive: true });
    await writeFile(path, `${JSON.stringify(contents, null, 2)}\n`);
  }
  return root;
}

describe('an update reports what it moved', () => {
  test('resolutions are read out of the lockfile, scoped names included', () => {
    const resolved = lockedResolutions(`{
  "packages": {
    "stitchkit": ["stitchkit@0.60.1", "", {}, "sha512-a"],
    "@app/db": ["@app/db@workspace:packages/db"],
    "@playwright/test": ["@playwright/test@1.62.1", "", {}, "sha512-b"],
  }
}`);
    expect(resolved.get('stitchkit')).toBe('0.60.1');
    expect(resolved.get('@playwright/test')).toBe('1.62.1');
  });

  test('the change list covers additions and removals, not just bumps', () => {
    const before = new Map([
      ['stitchkit', '0.60.0'],
      ['gone', '1.0.0'],
      ['same', '2.0.0'],
    ]);
    const after = new Map([
      ['stitchkit', '0.60.1'],
      ['same', '2.0.0'],
      ['new', '3.0.0'],
    ]);
    expect(resolutionChanges(before, after)).toEqual([
      { name: 'gone', from: '1.0.0', to: null },
      { name: 'new', from: null, to: '3.0.0' },
      { name: 'stitchkit', from: '0.60.0', to: '0.60.1' },
    ]);
  });

  test('a caret target stays a caret target', () => {
    expect(rangeLike('^0.60.0', '0.61.0')).toBe('^0.61.0');
    expect(rangeLike('~0.60.0', '0.61.0')).toBe('~0.61.0');
    expect(rangeLike('0.60.0', '0.61.0')).toBe('0.61.0');
  });
});

describe('a dissolved catalog reference is put back where it dissolved', () => {
  test('every plain section in every manifest', async () => {
    // The observed damage: `bun update --latest` rewrote `"catalog:"` into a
    // literal range in all six manifests at once.
    const root = await tree({
      'package.json': {
        catalog: { stitchkit: '^0.60.1' },
        devDependencies: { stitchkit: '^0.60.1', zod: '^4.4.3' },
      },
      'packages/backend/package.json': { dependencies: { stitchkit: '^0.60.1' } },
      'packages/shared/package.json': { peerDependencies: { stitchkit: '^0.60.1' } },
    });

    await expect(assertCatalogIsTheOnlyStitchkitRange(root)).rejects.toThrow(/names the/);
    const restored = await restoreCatalogReferences(root);

    expect(restored).toHaveLength(3);
    expect(restored.every((entry) => entry.was === '^0.60.1')).toBe(true);
    await expect(assertCatalogIsTheOnlyStitchkitRange(root)).resolves.toBeUndefined();

    const manifest: unknown = JSON.parse(await readFile(join(root, 'package.json'), 'utf8'));
    const catalog = Reflect.get(manifest as object, 'catalog');
    // The catalog block itself is the one place allowed to hold the number, and
    // restoring references must not touch it.
    expect(Reflect.get(catalog as object, 'stitchkit')).toBe('^0.60.1');
  });

  test('every restorable section, including the one the first pass missed', async () => {
    const root = await tree({
      'package.json': {
        catalog: { stitchkit: '^0.60.1' },
        optionalDependencies: { stitchkit: '^0.60.1' },
      },
    });
    const restored = await restoreCatalogReferences(root);
    expect(restored).toEqual([
      { manifest: 'package.json', section: 'optionalDependencies', was: '^0.60.1' },
    ]);
  });

  test('a manifest it cannot parse stops it before it writes anything', async () => {
    // The command's promise is that the invariant is checked AT the command.
    // Aborting halfway used to leave the range bumped, the lockfile rewritten
    // and the references still dissolved — a half-applied repair, which is the
    // opposite of that promise.
    const root = await tree({
      'package.json': {
        catalog: { stitchkit: '^0.60.1' },
        devDependencies: { stitchkit: '^0.60.1' },
      },
    });
    await mkdir(join(root, 'packages', 'broken'), { recursive: true });
    await writeFile(join(root, 'packages', 'broken', 'package.json'), '{ not json');

    await expect(restoreCatalogReferences(root)).rejects.toThrow();
    // The root manifest is untouched: nothing was written before the failure.
    const manifest: unknown = JSON.parse(await readFile(join(root, 'package.json'), 'utf8'));
    const dev = Reflect.get(manifest as object, 'devDependencies');
    expect(Reflect.get(dev as object, 'stitchkit')).toBe('^0.60.1');
  });

  test('an already-correct tree is left alone', async () => {
    const root = await tree({
      'package.json': {
        catalog: { stitchkit: '^0.60.1' },
        devDependencies: { stitchkit: 'catalog:' },
      },
    });
    expect(await restoreCatalogReferences(root)).toEqual([]);
  });

  test('a nested override is surfaced, not silently rewritten', async () => {
    // A nested `overrides` pin is not a dissolved reference — it is a second
    // opinion about the range. Rewriting it would hide a decision; the gate
    // refuses it by name instead.
    const root = await tree({
      'package.json': {
        catalog: { stitchkit: '^0.60.1' },
        devDependencies: { stitchkit: 'catalog:' },
        overrides: { 'some-package': { stitchkit: '0.58.0' } },
      },
    });
    expect(await restoreCatalogReferences(root)).toEqual([]);
    await expect(assertCatalogIsTheOnlyStitchkitRange(root)).rejects.toThrow(/"0\.58\.0"/);
  });
});
