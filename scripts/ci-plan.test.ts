import { describe, expect, test } from 'bun:test';
import { planCi } from './ci-plan';
import type { ReleaseTarget } from './release-train';

const packageReleases: [string, ReleaseTarget][] = [
  ['core', 'core'],
  ['starter', 'create-stitchkit'],
  ['tui', 'tui'],
];

describe('package-aware CI planning', () => {
  test.each(packageReleases)(
    'a release(%s) creates publication artifacts for its package',
    (scope, target) => {
      const plan = planCi({
        event: 'push',
        subject: `release(${scope}): publish package in 0.98.2`,
        changedPaths: ['release-train.json', 'bun.lock'],
      });
      expect(plan.targets).toEqual([target]);
      expect(plan.artifacts).toBe(true);
    },
  );

  test('an ordinary fix never creates publication artifacts', () => {
    expect(
      planCi({ event: 'push', subject: 'fix: repair core', changedPaths: ['bun.lock'] })
        .artifacts,
    ).toBe(false);
  });

  test('a TUI-only release runs no unrelated heavy lane', () => {
    expect(
      planCi({
        event: 'push',
        subject: 'release(train): publish terminal package',
        changedPaths: ['release-train.json'],
        releaseTargets: ['tui'],
      }),
    ).toMatchObject({
      targets: ['tui'],
      portable: false,
      tui: true,
      starter: false,
      supervised: false,
      darwin: false,
      artifacts: true,
      starterModes: [],
    });
  });

  test('a starter release proves the published target only', () => {
    const plan = planCi({
      event: 'push',
      subject: 'release(train): publish starter',
      changedPaths: ['release-train.json'],
      releaseTargets: ['create-stitchkit'],
    });
    expect(plan.starterModes).toEqual(['target']);
    expect(plan.supervised).toBe(true);
    expect(plan.darwin).toBe(false);
  });

  test('a core release starts portable work and proves packed HEAD plus Darwin', () => {
    const plan = planCi({
      event: 'push',
      subject: 'release(train): publish framework',
      changedPaths: ['release-train.json'],
      releaseTargets: ['core'],
    });
    expect(plan).toMatchObject({ portable: true, darwin: true, starterModes: ['head'] });
  });

  test('nightly keeps the exhaustive package and starter-mode matrix', () => {
    const plan = planCi({ event: 'schedule', subject: 'anything', changedPaths: [] });
    expect(plan.targets).toEqual(['core', 'tui', 'create-stitchkit']);
    expect(plan.starterModes).toEqual(['target', 'head']);
    expect(plan.artifacts).toBe(false);
  });
});
