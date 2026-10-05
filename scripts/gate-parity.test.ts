import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { z } from 'zod';
import { PROFILES, VERIFY_FLAGS, VERIFY_STEPS } from './verify-profiles';

const CI = readFileSync(join(import.meta.dir, '../.github/workflows/ci.yml'), 'utf8');
const PLAN = readFileSync(join(import.meta.dir, 'release-plan.ts'), 'utf8');
const PACKAGE = JSON.parse(readFileSync(join(import.meta.dir, '../package.json'), 'utf8')) as {
  scripts?: Record<string, string>;
};

const StepSchema = z.looseObject({
  run: z.string().optional(),
  env: z.record(z.string(), z.string()).optional(),
  if: z.union([z.string(), z.boolean()]).optional(),
  'continue-on-error': z.union([z.string(), z.boolean()]).optional(),
});
const JobSchema = z.looseObject({
  if: z.union([z.string(), z.boolean()]).optional(),
  needs: z.union([z.string(), z.array(z.string())]).optional(),
  'continue-on-error': z.union([z.string(), z.boolean()]).optional(),
  steps: z.array(StepSchema),
  strategy: z.object({ matrix: z.record(z.string(), z.unknown()) }).optional(),
});
const WorkflowSchema = z.looseObject({ jobs: z.record(z.string(), JobSchema) });

/** Conditions and dependency edges carry coverage; command text alone does not. */
function workflowCoverageProblems(source: string): string[] {
  const { jobs } = WorkflowSchema.parse(Bun.YAML.parse(source));
  const problems: string[] = [];
  const selectors: Record<string, string> = {
    portable: 'portable',
    'portable-lanes': 'portable',
    tui: 'tui',
    'starter-package': 'starter',
    'darwin-contained-files': 'darwin',
    supervised: 'supervised',
    starter: 'starter',
  };
  for (const [name, selector] of Object.entries(selectors)) {
    const job = jobs[name];
    if (job?.if !== `needs.plan.outputs.${selector} == 'true'`)
      problems.push(`${name}: selector`);
    if (job?.needs !== 'plan') problems.push(`${name}: planning dependency`);
  }
  for (const [name, job] of Object.entries(jobs)) {
    if (job['continue-on-error'] !== undefined && job['continue-on-error'] !== false)
      problems.push(`${name}: continue-on-error`);
    for (const step of job.steps) {
      if (step.run !== undefined && step.if !== undefined)
        problems.push(`${name}: skipped command`);
      if (step['continue-on-error'] !== undefined && step['continue-on-error'] !== false)
        problems.push(`${name}: continued failure`);
    }
  }
  for (const name of ['plan', 'repository']) {
    if (!jobs[name] || jobs[name].if !== undefined) problems.push(`${name}: mandatory job`);
  }
  for (const phase of ['artifacts', 'result']) {
    const job = jobs[phase];
    const raw = job?.needs;
    const needs = typeof raw === 'string' ? [raw] : (raw ?? []);
    for (const name of [
      'plan',
      'repository',
      ...Object.keys(selectors),
      'universal-native-build',
      'universal-native-run',
      ...(phase === 'result' ? ['artifacts'] : []),
    ]) {
      if (!needs.includes(name)) problems.push(`${phase}: missing ${name}`);
    }
    const command = `bun scripts/ci-evidence.ts ${phase === 'artifacts' ? 'assembly' : 'result'}`;
    const guard = job?.steps.find((step) => step.run === command);
    if (!guard || guard.if !== undefined) problems.push(`${phase}: missing evidence guard`);
    // biome-ignore lint/suspicious/noTemplateCurlyInString: GitHub Actions expression is literal YAML evidence.
    if (guard?.env?.CI_NEEDS !== '${{ toJSON(needs) }}')
      problems.push(`${phase}: missing named results`);
    if (phase === 'artifacts') {
      const guardIndex = job?.steps.indexOf(guard ?? { run: command }) ?? -1;
      const packIndex =
        job?.steps.findIndex((step) => step.run === 'bun scripts/pack-release-train.ts') ?? -1;
      if (guardIndex < 0 || packIndex <= guardIndex)
        problems.push('artifacts: assembly before proof');
    }
  }
  const starter = jobs.starter?.strategy?.matrix;
  if (
    // biome-ignore lint/suspicious/noTemplateCurlyInString: GitHub Actions expression is literal YAML evidence.
    starter?.mode !== '${{ fromJSON(needs.plan.outputs.starter-modes) }}' ||
    JSON.stringify(starter?.variant) !== JSON.stringify(['blank', 'repository']) ||
    JSON.stringify(starter?.browser) !== JSON.stringify(['chromium', 'webkit'])
  )
    problems.push('starter: incomplete matrix');
  const darwin = jobs['darwin-contained-files']?.strategy?.matrix;
  if (!Array.isArray(darwin?.include) || darwin.include.length !== 2)
    problems.push('darwin: incomplete matrix');
  for (const [name, dependency] of [
    ['universal-native-build', 'darwin-contained-files'],
    ['universal-native-run', 'universal-native-build'],
  ]) {
    if (!name || !dependency) throw new Error('Invalid universal evidence edge');
    const job = jobs[name];
    if (job?.if !== "needs.plan.outputs.darwin == 'true'") problems.push(`${name}: selector`);
    if (JSON.stringify(job?.needs) !== JSON.stringify(['plan', dependency]))
      problems.push(`${name}: shared dependency`);
  }
  if (
    JSON.stringify(jobs['universal-native-run']?.strategy?.matrix) !== JSON.stringify(darwin)
  )
    problems.push('universal: incomplete native matrix');
  if (jobs.result?.if !== 'always()') problems.push('result: must always check');
  if (jobs.artifacts?.if !== "always() && needs.plan.outputs.artifacts == 'true'")
    problems.push('artifacts: selection');
  return problems;
}

describe('local gate vocabulary', () => {
  test('pre-push passes only accepted verify flags', () => {
    const accepted = new Set<string>(VERIFY_FLAGS);
    const passed = [...PLAN.matchAll(/'bun',\s*'scripts\/verify\.ts'([^\]]*)\]/g)].flatMap(
      (call) => [...(call[1] ?? '').matchAll(/'(--[\w-]+)'/g)].map((flag) => flag[1] ?? ''),
    );
    expect(passed.length).toBeGreaterThan(0);
    expect(passed.filter((flag) => !accepted.has(flag))).toEqual([]);
  });

  test('the frozen-lockfile install CI performs first is a local step in both profiles', () => {
    // Every CI runner starts with this install; a manifest edited without its
    // lockfile once passed every local step and reddened a release's first run.
    const ciInstall = 'bun install --frozen-lockfile --ignore-scripts';
    expect(CI).toContain(ciInstall);
    expect(PACKAGE.scripts?.lockfile).toBe(ciInstall);
    expect(PROFILES.fast.steps[0]).toBe('lockfile');
    expect(VERIFY_STEPS[0]).toBe('lockfile');
  });

  test('full local verification retains every portable evidence lane', () => {
    for (const step of [...VERIFY_STEPS, ...PROFILES.candidate.steps])
      expect(PACKAGE.scripts?.[step]).toBeDefined();
    expect(PROFILES.candidate.steps).toEqual([
      'lockfile',
      'lint',
      'check',
      'test:release-metadata',
    ]);
    expect(PROFILES.fast.steps).toContain('test');
  });
});

describe('CI evidence parity', () => {
  test('selected jobs cannot be disabled or their failures ignored while retaining command text', () => {
    expect(workflowCoverageProblems(CI)).toEqual([]);
    expect(
      workflowCoverageProblems(
        CI.replace("if: needs.plan.outputs.portable == 'true'", 'if: false'),
      ),
    ).toContain('portable: selector');
    expect(workflowCoverageProblems(CI.replace('needs: plan', 'needs: []'))).toContain(
      'portable: planning dependency',
    );
    expect(
      workflowCoverageProblems(
        CI.replace(
          '    name: Framework portable surface',
          '    continue-on-error: true\n    name: Framework portable surface',
        ),
      ),
    ).toContain('portable: continue-on-error');
    const withoutTui = CI.replace(
      '        portable-lanes,\n        tui,',
      '        portable-lanes,',
    );
    expect(workflowCoverageProblems(withoutTui)).toContain('artifacts: missing tui');
    expect(
      workflowCoverageProblems(
        CI.replace(
          'run: bun scripts/ci-evidence.ts assembly',
          'if: false\n        run: bun scripts/ci-evidence.ts assembly',
        ),
      ),
    ).toContain('artifacts: missing evidence guard');
  });
  test('missing named results and matrix cells are refused', () => {
    expect(
      workflowCoverageProblems(
        // biome-ignore lint/suspicious/noTemplateCurlyInString: GitHub Actions expression is literal YAML evidence.
        CI.replace('CI_NEEDS: ${{ toJSON(needs) }}', 'CI_NEEDS: missing'),
      ),
    ).toContain('artifacts: missing named results');
    expect(
      workflowCoverageProblems(
        CI.replace('browser: [chromium, webkit]', 'browser: [chromium]'),
      ),
    ).toContain('starter: incomplete matrix');
  });
  test('the planner is the only release-target selector', () => {
    expect(CI).toContain('bun scripts/ci-plan.ts');
    expect(CI).toContain('needs.plan.outputs.portable');
    expect(CI).toContain('needs.plan.outputs.starter-modes');
  });

  test('portable runtime gates and isolated package gates remain represented', () => {
    for (const command of [
      'bun run test:postgres-stores',
      'bun run smoke:next-ssr',
      'bun run smoke:node',
      'bun run consumer-lane',
      'bun run tui-packed-lane',
      'bun run supervised-lane',
    ]) {
      expect(CI).toContain(command);
    }
  });

  test('every evidence job is required by the assembly jobs', () => {
    // A lane split out of another one is evidence nobody waits for until it is
    // in `needs`: the release artifact would assemble while it was still
    // running, and a red one would arrive after publication.
    // From the `jobs:` section only — `push:` and `schedule:` sit at the same
    // indentation under `on:`, and counting them as jobs is a test that fails
    // for a reason having nothing to do with what it checks.
    const { jobs } = WorkflowSchema.parse(Bun.YAML.parse(CI));
    const evidence = Object.keys(jobs).filter(
      (job) => !['plan', 'artifacts', 'result'].includes(job),
    );
    expect(evidence).toContain('portable-lanes');
    for (const block of ['artifacts', 'result']) {
      const raw = jobs[block]?.needs;
      const listed = typeof raw === 'string' ? [raw] : (raw ?? []);
      for (const job of evidence) expect(listed).toContain(job);
    }
  });

  test('a release commit is gated on its own branch before master sees it', () => {
    // The push trigger is what makes the branch run a PUSH run for the exact
    // SHA, which is the only kind `select-ci-run` accepts. Without it the
    // release branch produces no evidence and the local gate is the only gate.
    expect(CI).toContain("branches: [master, main, 'release/**']");
    expect(PLAN).toContain('ciAlreadyAnsweredFor');
    expect(CI).toContain('bun --filter stitchkit test');
    expect(CI).toContain('bun test scripts');
  });

  test('real Darwin qualification is packed and deliberately narrow', () => {
    expect(CI).toContain('runner: macos-15');
    expect(CI).toContain('runner: macos-15-intel');
    expect(CI).toContain('bun --filter stitchkit build:native-contained-files');
    expect(CI).toContain('bun run contained-files-packed-lane');
  });

  test('universal execution depends on one shared archive and both native architectures', () => {
    expect(
      workflowCoverageProblems(
        CI.replace('needs: [plan, universal-native-build]', 'needs: [plan]'),
      ),
    ).toContain('universal-native-run: shared dependency');
    expect(
      workflowCoverageProblems(CI.replace('        universal-native-run,\n', '')),
    ).toContain('artifacts: missing universal-native-run');
    const { jobs } = WorkflowSchema.parse(Bun.YAML.parse(CI));
    const consumer = jobs['universal-native-run'];
    expect(consumer?.steps.some((step) => step.run?.includes('universal-native-run.ts'))).toBe(
      true,
    );
    expect(
      consumer?.steps.some((step) => step.run?.includes('universal-native-build.ts')),
    ).toBe(false);
    expect(CI).toContain('name: universal-native');
  });

  test('Linux UID refusal has an explicit privileged installed-package proof', () => {
    const { jobs } = WorkflowSchema.parse(Bun.YAML.parse(CI));
    const proof = jobs.portable?.steps.find((step) => step.run?.includes('--native-uid-only'));
    expect(proof?.run).toContain('sudo env');
    expect(proof?.if).toBeUndefined();
    expect(proof?.['continue-on-error']).toBeUndefined();
    expect(CI).toContain('working-directory: packages/core');
  });

  test('the complete starter cross-product remains in scheduled/manual planning', () => {
    expect(CI).toContain("cron: '17 3 * * *'");
    expect(CI).toContain('fromJSON(needs.plan.outputs.starter-modes)');
  });
});
