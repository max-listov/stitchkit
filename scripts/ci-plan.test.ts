import { describe, expect, test } from 'bun:test';
import { CiPlanSchema, changedCiPaths, planCi } from './ci-plan';
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
        changedPaths: ['release-train.json'],
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

  test('release evidence covers package edits outside its publication train', () => {
    const core = planCi({
      event: 'push',
      subject: 'release(train): terminal package',
      changedPaths: ['packages/core/src/process/launch.ts'],
      releaseTargets: ['tui'],
    });
    expect(core).toMatchObject({ portable: true, darwin: true, tui: true });
    expect(core.targets).toEqual(['tui', 'core']);
    const tui = planCi({
      event: 'push',
      subject: 'release(core): framework',
      changedPaths: ['packages/tui/src/index.ts'],
    });
    expect(tui).toMatchObject({ portable: true, tui: true });
  });

  test.each([
    'scripts/verify.ts',
    '.github/workflows/ci.yml',
    '.githooks/pre-push',
    'package.json',
    'bun.lock',
  ])('shared input %s selects all evidence without widening publication', (path) => {
    const targets = ['tui'] satisfies import('./release-train').ReleaseTarget[];
    const plan = planCi({
      event: 'push',
      subject: 'release(train): terminal package',
      changedPaths: [path],
      releaseTargets: targets,
    });
    expect(plan.targets).toEqual(['core', 'tui', 'create-stitchkit']);
    expect(plan.starterModes).toEqual(['target', 'head']);
    expect(targets).toEqual(['tui']);
  });

  test('combined core and starter evidence proves both starter contracts', () => {
    const plan = planCi({
      event: 'push',
      subject: 'release(train): framework',
      changedPaths: ['packages/create-stitchkit/template/project.json'],
      releaseTargets: ['core'],
    });
    expect(plan.starterModes).toEqual(['target', 'head']);
  });

  test('push range includes a fix before the final release commit; a new branch uses all paths', async () => {
    const before = '1'.repeat(40);
    const head = '3'.repeat(40);
    const calls: string[][] = [];
    const read = async (args: string[]) => {
      calls.push(args);
      return args[0] === 'diff' && args[4] === before
        ? 'packages/core/src/process/launch.ts\0release-train.json\0'
        : 'packages/core/src/process/launch.ts\0packages/tui/src/index.ts\0';
    };
    const plan = planCi({
      event: 'push',
      subject: 'release(train): terminal package',
      changedPaths: await changedCiPaths(head, before, read),
      releaseTargets: ['tui'],
    });
    expect(plan.portable).toBe(true);
    expect(calls).toEqual([['diff', '--no-renames', '--name-only', '-z', before, head]]);
    expect(await changedCiPaths(head, '0'.repeat(40), read)).toHaveLength(2);
    expect(calls.at(-1)).toEqual(['ls-tree', '-r', '--name-only', '-z', head]);
  });

  test('a corrupted or internally contradictory evidence plan is refused', () => {
    const plan = planCi({ event: 'schedule', subject: '', changedPaths: [] });
    for (const field of ['portable', 'tui', 'starter', 'supervised', 'darwin']) {
      expect(CiPlanSchema.safeParse({ ...plan, [field]: false }).success).toBe(false);
    }
    for (const corrupt of [
      { ...plan, starterModes: ['head'] },
      { ...plan, targets: ['core', 'core'] },
      { ...plan, schemaVersion: 2 },
    ]) {
      expect(CiPlanSchema.safeParse(corrupt).success).toBe(false);
    }
  });
});
