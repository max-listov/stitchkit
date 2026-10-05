import { describe, expect, test } from 'bun:test';
import { assertCiEvidence } from './ci-evidence';
import { answeredPlan, CiPlanSchema, changedCiPaths, planCi, planPush } from './ci-plan';
import type { CiRunSummary } from './release-ci';
import type { ReleaseTarget } from './release-train';

const ALL: ReleaseTarget[] = ['core', 'tui', 'create-stitchkit'];
const HEAD = 'a'.repeat(40);

/** What a release commit really changes: manifest, changelog, lockfile workspace version, train. */
const releaseDiff = {
  core: ['CHANGELOG.md', 'packages/core/package.json', 'release-train.json', 'bun.lock'],
  starter: [
    'packages/create-stitchkit/CHANGELOG.md',
    'packages/create-stitchkit/package.json',
    'release-train.json',
    'bun.lock',
  ],
  tui: [
    'packages/tui/CHANGELOG.md',
    'packages/tui/package.json',
    'release-train.json',
    'bun.lock',
  ],
};

describe('package-aware CI planning', () => {
  test('fix commits stacked on an untagged release commit select the publication artifacts', () => {
    const stacked = planCi({
      event: 'push',
      subject: 'fix(core): repair a red candidate',
      changedPaths: ['packages/core/tests/a.test.ts'],
      stackedOnRelease: true,
    });
    expect(stacked.artifacts).toBe(true);
    expect(stacked.targets).toEqual(ALL);
    const ordinary = planCi({
      event: 'push',
      subject: 'fix(core): repair a red candidate',
      changedPaths: ['packages/core/tests/a.test.ts'],
    });
    expect(ordinary.artifacts).toBe(false);
  });

  test('a recorded deferred starter review drops the head lane and nothing else', () => {
    const plan = planCi({
      event: 'push',
      subject: 'release(train): publish core in 0.105.0',
      changedPaths: releaseDiff.core,
      starterHead: 'skip',
    });
    expect(plan.starterModes).toEqual(['target']);
    expect(plan).toMatchObject({
      portable: true,
      starter: true,
      supervised: true,
      darwin: true,
    });
    const withoutReview = planCi({
      event: 'push',
      subject: 'release(train): publish core in 0.105.0',
      changedPaths: releaseDiff.core,
    });
    expect(withoutReview.starterModes).toEqual(['target', 'head']);
  });

  test('a plan may omit the head mode but never the target mode or add an unselected one', () => {
    const full = planCi({ event: 'schedule', subject: '', changedPaths: [] });
    expect(CiPlanSchema.safeParse({ ...full, starterModes: ['target'] }).success).toBe(true);
    expect(CiPlanSchema.safeParse({ ...full, starterModes: ['head'] }).success).toBe(false);
    expect(CiPlanSchema.safeParse({ ...full, starterModes: [] }).success).toBe(false);
    const none = answeredPlan();
    expect(CiPlanSchema.safeParse({ ...none, starterModes: ['head'] }).success).toBe(false);
  });

  test.each(Object.entries(releaseDiff))(
    'a release commit of the %s package selects every package and builds publication artifacts',
    (scope, changedPaths) => {
      const plan = planCi({
        event: 'push',
        subject: `release(train): publish ${scope} in 0.98.2`,
        changedPaths,
      });
      expect(plan.targets).toEqual(ALL);
      expect(plan.starterModes).toEqual(['target', 'head']);
      expect(plan.artifacts).toBe(true);
    },
  );

  test('a release commit selects every package whatever paths it changed', () => {
    for (const changedPaths of [[], ['release-train.json'], ['packages/tui/src/index.ts']]) {
      const plan = planCi({
        event: 'push',
        subject: 'release(train): publish terminal package in 0.1.2',
        changedPaths,
      });
      expect(plan.targets).toEqual(ALL);
      expect(plan.artifacts).toBe(true);
    }
  });

  test('an ordinary fix never creates publication artifacts', () => {
    expect(
      planCi({ event: 'push', subject: 'fix: repair core', changedPaths: ['bun.lock'] })
        .artifacts,
    ).toBe(false);
  });

  test('a dependency bump that touches only the lockfile selects every package', () => {
    const plan = planCi({
      event: 'push',
      subject: 'chore: update dependencies',
      changedPaths: ['bun.lock'],
    });
    expect(plan.targets).toEqual(ALL);
    expect(plan.starterModes).toEqual(['target', 'head']);
  });

  test.each([
    'scripts/verify.ts',
    '.github/workflows/ci.yml',
    '.githooks/pre-push',
    'package.json',
    'bun.lock',
  ])('shared input %s selects all evidence on an ordinary push', (path) => {
    const plan = planCi({
      event: 'push',
      subject: 'fix: shared tooling',
      changedPaths: [path],
    });
    expect(plan.targets).toEqual(ALL);
  });

  const narrowed: Array<[string, ReleaseTarget[]]> = [
    ['packages/core/src/process/launch.ts', ['core']],
    ['packages/tui/src/index.ts', ['tui']],
    ['packages/create-stitchkit/template/project.json', ['create-stitchkit']],
    ['docs/guide/upgrading.md', []],
  ];
  test.each(narrowed)('an ordinary push of %s selects only %j', (path, targets) => {
    const plan = planCi({ event: 'push', subject: 'fix: one package', changedPaths: [path] });
    expect(plan.targets).toEqual(targets);
  });

  test('a core change starts portable work and proves packed HEAD plus Darwin', () => {
    const plan = planCi({
      event: 'push',
      subject: 'fix: core',
      changedPaths: ['packages/core/src/index.ts'],
    });
    expect(plan).toMatchObject({ portable: true, darwin: true, starterModes: ['head'] });
  });

  test('a TUI-only change runs no unrelated heavy lane', () => {
    expect(
      planCi({
        event: 'push',
        subject: 'fix: tui',
        changedPaths: ['packages/tui/src/index.ts'],
      }),
    ).toMatchObject({
      targets: ['tui'],
      portable: false,
      tui: true,
      starter: false,
      supervised: false,
      darwin: false,
      artifacts: false,
      starterModes: [],
    });
  });

  test('a starter-only change proves the published target only', () => {
    const plan = planCi({
      event: 'push',
      subject: 'fix: starter',
      changedPaths: ['packages/create-stitchkit/template/project.json'],
    });
    expect(plan.starterModes).toEqual(['target']);
    expect(plan.supervised).toBe(true);
    expect(plan.darwin).toBe(false);
  });

  test.each(['schedule', 'workflow_dispatch'] as const)(
    '%s keeps the exhaustive package and starter-mode matrix',
    (event) => {
      const plan = planCi({ event, subject: 'anything', changedPaths: [] });
      expect(plan.targets).toEqual(ALL);
      expect(plan.starterModes).toEqual(['target', 'head']);
      expect(plan.artifacts).toBe(false);
    },
  );

  test('push range includes a fix before the final commit; a new branch uses all paths', async () => {
    const before = '1'.repeat(40);
    const head = '3'.repeat(40);
    const calls: string[][] = [];
    const read = async (args: string[]) => {
      calls.push(args);
      return 'packages/core/src/process/launch.ts\0packages/tui/src/index.ts\0';
    };
    const plan = planCi({
      event: 'push',
      subject: 'fix: two packages',
      changedPaths: await changedCiPaths(head, before, read),
    });
    expect(plan.targets).toEqual(['core', 'tui']);
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

describe('one full run per SHA', () => {
  const run = (id: number, conclusion: string | null, event = 'push'): CiRunSummary => ({
    id,
    head_sha: HEAD,
    event,
    conclusion,
  });
  const input = (event: 'push' | 'pull_request' | 'schedule' | 'workflow_dispatch') => ({
    event,
    head: HEAD,
    subject: async () => 'release(train): publish framework in 0.9.0',
    paths: async () => ['bun.lock'],
  });
  const quiet = () => undefined;

  test('a SHA whose push run already succeeded selects no evidence and no artifacts', async () => {
    const asked: string[] = [];
    const plan = await planPush(
      input('push'),
      async (sha) => {
        asked.push(sha);
        return [run(8, 'success')];
      },
      quiet,
    );
    expect(plan).toEqual(answeredPlan());
    expect(plan.targets).toEqual([]);
    expect(plan.artifacts).toBe(false);
    expect(asked).toEqual([HEAD]);
  });

  test.each([
    ['no run exists', [] as CiRunSummary[]],
    ['the earlier run failed', [run(8, 'failure')]],
    ['the earlier run is still running', [run(8, null)]],
    ['only a pull-request run succeeded', [run(8, 'success', 'pull_request')]],
  ])('%s: the commit is planned from its change', async (_name, runs) => {
    const plan = await planPush(input('push'), async () => runs, quiet);
    expect(plan.targets).toEqual(ALL);
    expect(plan.artifacts).toBe(true);
  });

  test('an unreachable GitHub query plans in full instead of skipping evidence', async () => {
    const lines: string[] = [];
    const plan = await planPush(
      input('push'),
      async () => {
        throw new Error('HTTP 502');
      },
      (line) => lines.push(line),
    );
    expect(plan.artifacts).toBe(true);
    expect(lines.join('\n')).toContain('HTTP 502');
  });

  test.each(['pull_request', 'schedule', 'workflow_dispatch'] as const)(
    '%s never asks for an earlier run',
    async (event) => {
      const plan = await planPush(
        input(event),
        async () => {
          throw new Error('must not ask');
        },
        quiet,
      );
      expect(plan.targets).toEqual(ALL);
    },
  );

  test('the no-op plan satisfies the evidence contract of both assembly and result', () => {
    const plan = answeredPlan();
    const needs = {
      plan: { result: 'success', outputs: { json: JSON.stringify(plan) } },
      repository: { result: 'success' },
      portable: { result: 'skipped' },
      'portable-lanes': { result: 'skipped' },
      tui: { result: 'skipped' },
      'starter-package': { result: 'skipped' },
      'darwin-contained-files': { result: 'skipped' },
      'universal-native-build': { result: 'skipped' },
      'universal-native-run': { result: 'skipped' },
      supervised: { result: 'skipped' },
      starter: { result: 'skipped' },
      artifacts: { result: 'skipped' },
    };
    expect(() => assertCiEvidence(needs, 'assembly')).not.toThrow();
    expect(() => assertCiEvidence(needs, 'result')).not.toThrow();
    expect(() =>
      assertCiEvidence({ ...needs, repository: { result: 'skipped' } }, 'result'),
    ).toThrow('repository');
  });
});
