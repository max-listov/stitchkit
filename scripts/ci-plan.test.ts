import { describe, expect, test } from 'bun:test';
import { planCi } from './ci-plan';

describe('package-aware CI planning', () => {
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
