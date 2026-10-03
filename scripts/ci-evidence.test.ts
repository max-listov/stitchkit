import { describe, expect, test } from 'bun:test';
import { assertCiEvidence, expectedCiEvidence } from './ci-evidence';
import { type CiPlan, planCi } from './ci-plan';

function context(plan: CiPlan, phase: 'assembly' | 'result') {
  const jobs: Record<string, { result: string; outputs?: Record<string, string> }> = {};
  for (const [job, required] of Object.entries(expectedCiEvidence(plan, phase))) {
    jobs[job] = { result: required ? 'success' : 'skipped' };
  }
  jobs.plan = { result: 'success', outputs: { json: JSON.stringify(plan) } };
  return jobs;
}

describe('named CI evidence', () => {
  for (const target of ['core', 'tui', 'create-stitchkit'] satisfies Array<
    import('./release-train').ReleaseTarget
  >) {
    const plan = planCi({
      event: 'push',
      subject: 'release(train): package',
      changedPaths: ['release-train.json'],
      releaseTargets: [target],
    });
    test(`${target}: selected successes and unselected skips satisfy both boundaries`, () => {
      for (const phase of ['assembly', 'result'] satisfies Array<'assembly' | 'result'>) {
        expect(() => assertCiEvidence(context(plan, phase), phase)).not.toThrow();
        for (const [job, required] of Object.entries(expectedCiEvidence(plan, phase))) {
          if (!required) continue;
          for (const result of ['skipped', 'failure', 'cancelled', 'missing']) {
            const needs = context(plan, phase);
            if (result === 'missing') delete needs[job];
            else needs[job] = { ...needs[job], result };
            expect(() => assertCiEvidence(needs, phase)).toThrow();
          }
        }
      }
    });
  }

  test('result requires artifacts precisely when publication artifacts were selected', () => {
    const ordinary = planCi({ event: 'push', subject: 'fix: docs', changedPaths: [] });
    expect(() => assertCiEvidence(context(ordinary, 'result'), 'result')).not.toThrow();
    const needs = context(ordinary, 'result');
    needs.artifacts = { result: 'failure' };
    expect(() => assertCiEvidence(needs, 'result')).toThrow('artifacts');
  });

  test('missing, malformed and contradictory plan outputs are refused', () => {
    const plan = planCi({ event: 'schedule', subject: '', changedPaths: [] });
    for (const json of ['{', 'null', JSON.stringify({ ...plan, portable: false })]) {
      const needs = context(plan, 'assembly');
      needs.plan = { result: 'success', outputs: { json } };
      expect(() => assertCiEvidence(needs, 'assembly')).toThrow();
    }
    const needs = context(plan, 'assembly');
    needs.plan = { result: 'success' };
    expect(() => assertCiEvidence(needs, 'assembly')).toThrow('JSON is missing');
  });
});
