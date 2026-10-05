import { describe, expect, test } from 'bun:test';
import {
  assertTrainCarriesItsCompanions,
  type PublishedTreeReader,
  packedRange,
} from './release-companions';
import { ReleaseTrainSchema } from './release-train';

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
});
