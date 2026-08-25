import { afterAll, describe, expect, test } from 'bun:test';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  assertCatalogIsTheOnlyStitchkitRange,
  pinnedStitchkitRanges,
} from './starter-manifest';

describe('only the catalog names the Stitchkit range', () => {
  test('a catalog block is not itself a pin', () => {
    expect(pinnedStitchkitRanges({ catalog: { stitchkit: '^0.60.0' } })).toEqual([]);
  });

  test('every dependency section is read', () => {
    expect(
      pinnedStitchkitRanges({
        dependencies: { stitchkit: 'catalog:' },
        devDependencies: { stitchkit: '^0.60.0' },
        peerDependencies: { stitchkit: '>=0.60' },
        optionalDependencies: { stitchkit: '^0.59.0' },
        overrides: { stitchkit: '0.58.0' },
      }),
    ).toEqual(['catalog:', '^0.60.0', '>=0.60', '^0.59.0', '0.58.0']);
  });

  test('a nested override is a pin too', () => {
    // `overrides` nests. A range hidden one level down pins Stitchkit for a
    // dependency's subtree and was invisible to a scan that read only the
    // section's own keys — a second number, free to disagree with the catalog.
    expect(
      pinnedStitchkitRanges({
        overrides: { 'some-package': { stitchkit: '0.58.0' } },
        resolutions: { a: { b: { stitchkit: '0.57.0' } } },
      }),
    ).toEqual(['0.58.0', '0.57.0']);
  });

  test('a package merely NAMED stitchkit under an override is not a range', () => {
    // The control: the key is what carries the range, not the value.
    expect(pinnedStitchkitRanges({ overrides: { stitchkit: { foo: '1.0.0' } } })).toEqual([]);
  });

  // A test about cleanup that leaves directories behind is not one to copy.
  const created: string[] = [];
  afterAll(async () => {
    for (const path of created) await rm(path, { recursive: true, force: true });
  });

  async function tree(manifests: Record<string, unknown>): Promise<string> {
    const root = await mkdtemp(join(tmpdir(), 'starter-manifest-'));
    created.push(root);
    for (const [relative, manifest] of Object.entries(manifests)) {
      const path = join(root, relative);
      await mkdir(join(path, '..'), { recursive: true });
      await writeFile(path, `${JSON.stringify(manifest, null, 2)}\n`);
    }
    return root;
  }

  test('a tree where every manifest defers to the catalog passes', async () => {
    const root = await tree({
      'package.json': {
        catalog: { stitchkit: '^0.60.0' },
        devDependencies: { stitchkit: 'catalog:' },
      },
      'packages/backend/package.json': { dependencies: { stitchkit: 'catalog:' } },
      'packages/config/package.json': { dependencies: { stitchkit: 'catalog:' } },
    });
    await expect(assertCatalogIsTheOnlyStitchkitRange(root)).resolves.toBeUndefined();
  });

  test('a manifest the old hand-written list never named is still caught', async () => {
    // `packages/config` gained the dependency in one release and the check that
    // existed named three manifests out of six — so this exact file was the one
    // a `bun update --latest` dissolved without anything noticing.
    const root = await tree({
      'package.json': {
        catalog: { stitchkit: '^0.60.0' },
        devDependencies: { stitchkit: 'catalog:' },
      },
      'packages/config/package.json': { dependencies: { stitchkit: '^0.60.0' } },
    });
    await expect(assertCatalogIsTheOnlyStitchkitRange(root)).rejects.toThrow(
      /packages\/config\/package\.json names the Stitchkit range directly as "\^0\.60\.0"/,
    );
  });

  test('the root manifest is checked too, catalog block and all', async () => {
    const root = await tree({
      'package.json': {
        catalog: { stitchkit: '^0.60.0' },
        devDependencies: { stitchkit: '^0.60.0' },
      },
    });
    await expect(assertCatalogIsTheOnlyStitchkitRange(root)).rejects.toThrow(
      /package\.json names/,
    );
  });
});
