import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { PROFILES, VERIFY_FLAGS, VERIFY_STEPS } from './verify';

/**
 * The local gate and CI describe the same work in two files, and nothing held
 * them together.
 *
 * `AGENTS.md` claims CI is a superset of `verify`, and the whole local-gate
 * policy rests on that claim: an ordinary push runs only lint/check/test here
 * precisely because everything else is answered there. If a step were added to
 * `verify` and not to `ci.yml`, the claim would quietly become false and the
 * step would run nowhere that gates a release.
 *
 * So the list is data (`VERIFY_STEPS`) and this reads the workflow.
 */
const CI = readFileSync(join(import.meta.dir, '../.github/workflows/ci.yml'), 'utf8');
const PREPARE_STARTER = readFileSync(join(import.meta.dir, 'prepare-starter.ts'), 'utf8');
const ROOT_PACKAGE = JSON.parse(
  readFileSync(join(import.meta.dir, '../package.json'), 'utf8'),
) as { scripts?: Record<string, string> };

/** Every `bun run <script>` the core job executes, in order. */
function coreJobSteps(): string[] {
  const core = CI.slice(CI.indexOf('\n  core:'), CI.indexOf('\n  supervised:'));
  return [...core.matchAll(/^\s+- run: bun run ([\w:-]+)\s*$/gm)].map(
    (match) => match[1] ?? '',
  );
}

/** Every `bun run <script>` the supervised job executes. */
function supervisedJobSteps(): string[] {
  const supervised = CI.slice(CI.indexOf('\n  supervised:'), CI.indexOf('\n  starter:'));
  return [...supervised.matchAll(/^\s+- run: bun run ([\w:-]+)\s*$/gm)].map(
    (match) => match[1] ?? '',
  );
}

/** Which starter lane modes the matrix covers. */
function starterMatrixModes(): string[] {
  const matrix = /mode: \[([^\]]+)\]/.exec(CI);
  return (matrix?.[1] ?? '').split(',').map((mode) => mode.trim());
}

describe('the hook and the gate agree on what the gate accepts', () => {
  // Found the hard way: `pre-push` was changed to call `verify.ts --head` in the
  // same pass that added the `--head` profile, and one of the two edits did not
  // survive. Everything stayed green — the flag is only reached on a release
  // push — and the failure would have arrived at the worst possible moment, on
  // the one commit whose gate cannot be re-run cheaply.
  const plan = readFileSync(join(import.meta.dir, 'release-plan.ts'), 'utf8');

  test('every flag pre-push passes to verify.ts is one verify.ts accepts', () => {
    const accepted = new Set<string>(VERIFY_FLAGS);
    const invocations = [...plan.matchAll(/'bun',\s*'scripts\/verify\.ts'([^\]]*)\]/g)];
    expect(invocations.length).toBeGreaterThan(0);
    const passed = invocations.flatMap((call) =>
      [...(call[1] ?? '').matchAll(/'(--[\w-]+)'/g)].map((flag) => flag[1] ?? ''),
    );
    expect(passed.length).toBeGreaterThan(0);
    expect(passed.filter((flag) => !accepted.has(flag))).toEqual([]);
  });
});

describe('a clean workspace prepares public package dependencies before sibling checks', () => {
  test('root prepare builds Stitchkit before it prepares nested workspaces', () => {
    const prepare = ROOT_PACKAGE.scripts?.prepare ?? '';
    const coreBuild = prepare.indexOf('bun --filter stitchkit build');
    const nestedPrepare = prepare.indexOf('bun scripts/prepare-starter.ts');

    expect(coreBuild).toBeGreaterThanOrEqual(0);
    expect(nestedPrepare).toBeGreaterThan(coreBuild);
  });

  test('nested preparation installs both independently locked starter trees', () => {
    expect(PREPARE_STARTER).toContain("packages/create-stitchkit/template'");
    expect(PREPARE_STARTER).toContain("packages/create-stitchkit/templates/agent'");
    expect(PREPARE_STARTER.match(/\['bun', 'install', '--frozen-lockfile'\]/g)).toHaveLength(
      2,
    );
  });
});

describe('CI is a superset of the local gate, and that is checked', () => {
  // The two steps CI runs in a job of their own rather than in `core`, each for
  // its own reason: the starter work is sharded across a matrix, and the
  // supervised lane wants a machine to itself.
  const OWN_JOB = ['starter-lane', 'supervised-lane'];

  test('every verify step runs on CI — in the core job or in a job of its own', () => {
    const inCore = VERIFY_STEPS.filter((step) => !OWN_JOB.includes(step));
    expect(inCore.filter((step) => !coreJobSteps().includes(step))).toEqual([]);
  });

  test('the supervised lane runs on CI too, in its own job', () => {
    // This step is in `VERIFY_STEPS`, so the previous test would pass it by. It
    // was the one gate CI ran and `verify` did not, and the gap fell on the
    // release commit — the commit whose red run cannot be repaired in place.
    expect(supervisedJobSteps()).toContain('supervised-lane');
  });

  test('the starter lanes run as a matrix covering both modes', () => {
    // `verify` runs `target`; the release path adds `head`. CI has to carry
    // both, because with the local gate reduced it is the only place an
    // ordinary push sees either.
    expect(starterMatrixModes().sort()).toEqual(['head', 'target']);
  });

  test('only the profiles that touch the lane environment pay for measuring it', () => {
    // The fast profile reads files and nothing else, so a tree hash and a
    // runtime version say everything about it. Making it measure a database it
    // never opens would cost every ordinary push for no answer.
    expect(PROFILES.fast.usesLaneEnvironment).toBe(false);
    expect(PROFILES.full.usesLaneEnvironment).toBe(true);
    expect(PROFILES.head.usesLaneEnvironment).toBe(true);
  });

  test('CI runs nothing the local gate does not know about', () => {
    // The other direction, and there is now no exception. A step that runs only
    // on CI is a gap between "green here" and "green there", and this
    // repository has closed the last one it had — the supervised lane, which
    // needed a globally installed supervisor until the supervisor was pinned.
    // A new gap should be a decision, not a surprise.
    const known = new Set<string>(VERIFY_STEPS);
    const onCi = [...coreJobSteps(), ...supervisedJobSteps()];
    expect(onCi.filter((step) => !known.has(step))).toEqual([]);
  });
});
