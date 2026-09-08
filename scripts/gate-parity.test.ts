import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { PROFILES, VERIFY_FLAGS, VERIFY_STEPS } from './verify';

const CI = readFileSync(join(import.meta.dir, '../.github/workflows/ci.yml'), 'utf8');
const PLAN = readFileSync(join(import.meta.dir, 'release-plan.ts'), 'utf8');
const PACKAGE = JSON.parse(readFileSync(join(import.meta.dir, '../package.json'), 'utf8')) as {
  scripts?: Record<string, string>;
};

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
    for (const step of VERIFY_STEPS) expect(PACKAGE.scripts?.[step]).toBeDefined();
    expect(PROFILES.fast.usesLaneEnvironment).toBe(false);
    expect(PROFILES.full.usesLaneEnvironment).toBe(true);
  });
});

describe('CI evidence parity', () => {
  test('the planner is the only release-target selector', () => {
    expect(CI).toContain('bun scripts/ci-plan.ts');
    expect(CI).toContain('needs.plan.outputs.portable');
    expect(CI).toContain('needs.plan.outputs.starter-modes');
  });

  test('portable runtime gates and isolated package gates remain represented', () => {
    for (const command of [
      'bun run test:agent-store-postgres',
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
    const section = CI.slice(CI.indexOf('\njobs:'));
    const jobs = [...section.matchAll(/^ {2}([a-z][a-z-]*):$/gm)].map(
      (match) => match[1] ?? '',
    );
    const evidence = jobs.filter(
      (job) => job !== 'plan' && job !== 'artifacts' && job !== 'result',
    );
    expect(evidence).toContain('portable-lanes');
    for (const block of ['artifacts', 'result']) {
      const needs =
        section.slice(section.indexOf(`  ${block}:`)).match(/needs:\s*\[([^\]]*)\]/)?.[1] ??
        '';
      const listed = needs.split(',').map((entry) => entry.trim());
      for (const job of evidence) expect(listed).toContain(job);
    }
  });

  test('a release commit is gated on its own branch before master sees it', () => {
    // The push trigger is what makes the branch run a PUSH run for the exact
    // SHA, which is the only kind `select-ci-run` accepts. Without it the
    // release branch produces no evidence and the local gate is the only gate.
    expect(CI).toContain("branches: [master, main, 'release/**']");
    expect(PLAN).toContain('ciAlreadyAnsweredFor');
  });

  test('real Darwin qualification is packed and deliberately narrow', () => {
    expect(CI).toContain('runner: macos-15');
    expect(CI).toContain('runner: macos-15-intel');
    expect(CI).toContain('bun --filter stitchkit build:native-contained-files');
    expect(CI).toContain('bun run contained-files-packed-lane');
  });

  test('the complete starter cross-product remains in scheduled/manual planning', () => {
    expect(CI).toContain("cron: '17 3 * * *'");
    expect(CI).toContain('fromJSON(needs.plan.outputs.starter-modes)');
  });
});
