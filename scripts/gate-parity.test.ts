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
