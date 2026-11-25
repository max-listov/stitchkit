import { describe, expect, test } from 'bun:test';
import { resolve } from 'node:path';
import { ReleaseTrainSchema } from './release-train';
import { assertTrainDoesNotOutrunTheStarter } from './release-validate';

const root = resolve(import.meta.dir, '..');

describe('a train cannot publish the framework its own starter must pin', () => {
  const starterTree = (range: string) => (relativePath: string) => {
    if (relativePath.endsWith('template/package.json')) {
      return Promise.resolve(JSON.stringify({ catalog: { stitchkit: range } }));
    }
    if (relativePath.endsWith('template/bun.lock')) {
      return Promise.resolve(
        '{ "packages": { "stitchkit": ["stitchkit@0.90.5", "", {}, "x"] } }',
      );
    }
    return Promise.reject(new Error(`no ${relativePath} in this tree`));
  };

  const train = (releases: { target: string; version: string }[]) =>
    ReleaseTrainSchema.parse({ schemaVersion: 1, releases });

  test('the exact 0.6.1 train is refused, and the refusal names both versions', async () => {
    await expect(
      assertTrainDoesNotOutrunTheStarter(
        root,
        train([
          { target: 'core', version: '0.90.6' },
          { target: 'create-stitchkit', version: '0.6.1' },
        ]),
        starterTree('^0.90.5'),
      ),
    ).rejects.toThrow(/publishes stitchkit 0\.90\.6 and create-stitchkit 0\.6\.1 together/);
  });

  test('a starter targeting an older minor rides along with a new one', async () => {
    // The narrow case the refusal must not swallow: the framework the train
    // publishes is outside the starter's range, so its lockfile owes it nothing.
    await expect(
      assertTrainDoesNotOutrunTheStarter(
        root,
        train([
          { target: 'core', version: '0.91.0' },
          { target: 'create-stitchkit', version: '0.6.2' },
        ]),
        starterTree('^0.90.5'),
      ),
    ).resolves.toBeUndefined();
  });

  test('a train without one of the two halves is not this question', async () => {
    for (const releases of [
      [{ target: 'core', version: '0.90.7' }],
      [{ target: 'create-stitchkit', version: '0.6.2' }],
      [
        { target: 'core', version: '0.90.7' },
        { target: 'tui', version: '0.1.3' },
      ],
    ]) {
      await expect(
        assertTrainDoesNotOutrunTheStarter(root, train(releases), starterTree('^0.90.5')),
      ).resolves.toBeUndefined();
    }
  });
});
