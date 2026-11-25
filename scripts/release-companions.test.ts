import { afterAll, describe, expect, test } from 'bun:test';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  assertTrainCarriesItsCompanions,
  missingCompanions,
  type PublishedTreeReader,
  packedRange,
  readFromReleaseTags,
  trainRequirements,
} from './release-companions';
import { ReleaseTrainSchema } from './release-train';

const created: string[] = [];
afterAll(async () => {
  for (const path of created) await rm(path, { recursive: true, force: true });
});

const manifest = (fields: Record<string, unknown>) => JSON.stringify(fields);

/** The working tree: core about to be released, tui still at its last published version. */
const tree = (coreVersion: string) => (path: string) => {
  const files: Record<string, string> = {
    'packages/core/package.json': manifest({ version: coreVersion }),
    'packages/tui/package.json': manifest({ version: '0.1.4' }),
    'packages/create-stitchkit/package.json': manifest({ version: '0.6.9' }),
  };
  const contents = files[path];
  return contents === undefined
    ? Promise.reject(new Error(`no ${path}`))
    : Promise.resolve(contents);
};

/** Tags as `stitchkit-tui-v0.1.4` holds them: tui declared core as `workspace:^` when core was 0.94.0. */
const published =
  (field: 'dependencies' | 'peerDependencies' | 'devDependencies'): PublishedTreeReader =>
  (tag, path) => {
    if (tag !== 'stitchkit-tui-v0.1.4') return Promise.resolve(undefined);
    if (path === 'packages/tui/package.json')
      return Promise.resolve(
        manifest({ version: '0.1.4', [field]: { stitchkit: 'workspace:^' } }),
      );
    if (path === 'packages/core/package.json')
      return Promise.resolve(manifest({ version: '0.94.0' }));
    return Promise.resolve(undefined);
  };

const train = (releases: { target: string; version: string }[]) =>
  ReleaseTrainSchema.parse({ schemaVersion: 1, releases });

describe('a train carries the siblings whose published range would refuse it', () => {
  test('core outside the range tui froze is refused, naming both packages and the range', async () => {
    await expect(
      assertTrainCarriesItsCompanions(
        train([{ target: 'core', version: '0.105.0' }]),
        tree('0.105.0'),
        published('dependencies'),
      ),
    ).rejects.toThrow(/stitchkit 0\.105\.0.*stitchkit-tui@0\.1\.4 accepts only "\^0\.94\.0"/);
  });

  test('a peer dependency freezes its range the same way', async () => {
    await expect(
      assertTrainCarriesItsCompanions(
        train([{ target: 'core', version: '0.95.0' }]),
        tree('0.95.0'),
        published('peerDependencies'),
      ),
    ).rejects.toThrow('stitchkit-tui');
  });

  test('a missing companion names the release that requires it, wherever that stands in the train', async () => {
    // The starter comes first in this train; tui is needed because of core, and its changelog
    // has to say so, not name whatever was listed first.
    const missing = await missingCompanions(
      train([
        { target: 'create-stitchkit', version: '0.6.10' },
        { target: 'core', version: '0.105.0' },
      ]),
      tree('0.105.0'),
      published('dependencies'),
    );
    expect(missing.map(({ companion, requiredBy }) => ({ companion, requiredBy }))).toEqual([
      { companion: 'tui', requiredBy: { target: 'core', version: '0.105.0' } },
    ]);
  });

  test('the same train with tui in it is accepted: tui is repacked from the workspace', async () => {
    await expect(
      assertTrainCarriesItsCompanions(
        train([
          { target: 'core', version: '0.105.0' },
          { target: 'tui', version: '0.2.0' },
        ]),
        tree('0.105.0'),
        published('dependencies'),
      ),
    ).resolves.toBeUndefined();
  });

  test('a release inside the published range, a dev-only dependency and an unpublished sibling pass', async () => {
    const core = (version: string) => train([{ target: 'core', version }]);
    await expect(
      assertTrainCarriesItsCompanions(
        core('0.94.3'),
        tree('0.94.3'),
        published('dependencies'),
      ),
    ).resolves.toBeUndefined();
    await expect(
      assertTrainCarriesItsCompanions(
        core('0.105.0'),
        tree('0.105.0'),
        published('devDependencies'),
      ),
    ).resolves.toBeUndefined();
    await expect(
      assertTrainCarriesItsCompanions(core('0.105.0'), tree('0.105.0'), () =>
        Promise.resolve(undefined),
      ),
    ).resolves.toBeUndefined();
  });

  test('the packed range follows the workspace spec', () => {
    expect(packedRange('workspace:^', '0.94.0')).toBe('^0.94.0');
    expect(packedRange('workspace:~', '0.94.0')).toBe('~0.94.0');
    expect(packedRange('workspace:*', '0.94.0')).toBe('0.94.0');
    expect(packedRange('workspace:>=0.90.0', '0.94.0')).toBe('>=0.90.0');
  });

  test('a repository with no release tags for a companion prefix refuses instead of silently returning empty', async () => {
    const root = await mkdtemp(join(tmpdir(), 'release-companions-notags-'));
    created.push(root);
    await writeFile(join(root, 'README.md'), 'tagless clone\n');
    for (const args of [
      ['init', '-q'],
      ['config', 'user.email', 'gate@example.invalid'],
      ['config', 'user.name', 'gate'],
      ['add', '.'],
      ['commit', '-qm', 'init'],
      // Only a core tag exists; no `stitchkit-tui-v*` tags were fetched.
      ['tag', 'v0.104.0'],
    ]) {
      expect(Bun.spawnSync(['git', '-C', root, ...args]).exitCode).toBe(0);
    }
    await expect(
      missingCompanions(
        train([{ target: 'core', version: '0.105.0' }]),
        tree('0.105.0'),
        readFromReleaseTags(root),
      ),
    ).rejects.toThrow(
      /No local release tags matching "stitchkit-tui-v\*"[\s\S]*git fetch origin --tags/,
    );
  });
});

describe('a train publishes whole', () => {
  const both = ReleaseTrainSchema.parse({
    schemaVersion: 1,
    releases: [
      { target: 'core', version: '0.127.0' },
      { target: 'tui', version: '0.5.0' },
    ],
  });

  test("a package waits for the siblings of its train it publishes a range for, at the train's version", () => {
    const tui = manifest({ version: '0.5.0', peerDependencies: { stitchkit: 'workspace:^' } });
    expect(trainRequirements(both, 'tui', tui)).toEqual([
      { packageName: 'stitchkit', version: '0.127.0' },
    ]);
    expect(
      trainRequirements(both, 'tui', manifest({ dependencies: { stitchkit: 'workspace:*' } })),
    ).toEqual([{ packageName: 'stitchkit', version: '0.127.0' }]);
  });

  test('nothing to wait for: the framework, a dev-only range, a sibling outside the train', () => {
    expect(trainRequirements(both, 'core', manifest({ version: '0.127.0' }))).toEqual([]);
    expect(
      trainRequirements(
        both,
        'tui',
        manifest({ devDependencies: { stitchkit: 'workspace:^' } }),
      ),
    ).toEqual([]);
    const alone = ReleaseTrainSchema.parse({
      schemaVersion: 1,
      releases: [{ target: 'tui', version: '0.5.1' }],
    });
    expect(
      trainRequirements(
        alone,
        'tui',
        manifest({ peerDependencies: { stitchkit: 'workspace:^' } }),
      ),
    ).toEqual([]);
  });
});
