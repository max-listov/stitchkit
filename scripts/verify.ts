import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  findGreenGate,
  type GreenGateRecord,
  gateMemoPath,
  greenGateKey,
  headCommit,
  laneEnvironmentFingerprint,
  readGreenGates,
  toolchainFingerprint,
  worktreeTreeHash,
  writeGreenGate,
} from './gate-memo';
import { readReleaseTrain } from './release-train';

/**
 * The whole repository gate, in order, as one list.
 *
 * It used to be a `&&` chain inside `package.json`. Moving it here costs
 * nothing and buys two things the chain could not have: the gate can say which
 * step it is on, and it can decide — once, on evidence — whether this exact
 * tree has already been through it.
 */
export const VERIFY_STEPS = [
  // The one CI step every runner performs before anything else, and the one
  // this gate did not: a manifest edited without its lockfile passed every
  // local step and turned the first CI run of a release red at `bun install`.
  'lockfile',
  'lint',
  'check',
  'test',
  'test:agent-store-postgres',
  'build',
  'smoke:next-ssr',
  'smoke:node',
  'consumer-lane',
  'tui-packed-lane',
  'agent-template-lane',
  'starter-lane',
  // The supervised lane used to be the one gate CI ran and `verify` did not,
  // because it needed `pm2` on PATH. The supervisor is a pinned devDependency
  // now, so there is no prerequisite left to trade away — and the gap it left
  // fell on the release commit, the one commit whose red CI run cannot be
  // repaired in place. The agent-store lane sat in that same gap until it made
  // a release run red; this is the second and last member of that list.
  'supervised-lane',
] as const;

/**
 * What an ordinary push runs locally — the part that is genuinely faster to
 * learn here than from CI.
 *
 * Everything past `test` in the full gate is work whose nature is parallel:
 * four packed starter runs (the target mode, two scaffold variants, two
 * browsers), two smokes, a consumer lane and the Postgres agent-store lane. CI
 * shards the same work — plus the four HEAD-mode runs this profile does not
 * carry — across ten runners and answers in about two and a half minutes; one
 * developer machine walks it in single file and takes several times longer to
 * reach the same answer. Duplicating that is not caution, it is a slower copy.
 * → `AGENTS.md`, "What runs where".
 */
export const FAST_STEPS = ['lockfile', 'lint', 'check', 'test'] as const;

/** The name each gate is remembered under. */
export const VERIFY_GATE = 'verify';
export const FAST_GATE = 'verify:fast';

export interface VerifyProfile {
  gate: string;
  steps: readonly string[];
  /**
   * Whether this profile's steps talk to anything outside the tree. The fast
   * profile reads only files, so a tree hash and a runtime version say
   * everything about it; the heavy ones drive a PostgreSQL server and real
   * browsers, and neither is visible in either.
   */
  usesLaneEnvironment: boolean;
  /**
   * Other gates whose green record also answers for this one. The full gate
   * runs every fast step, so a green `verify` is a green `verify:fast` — and a
   * memo that did not know it would re-run work it had just watched succeed.
   */
  satisfiedBy: readonly string[];
}

/**
 * The packed HEAD lane, which `verify` deliberately does not carry.
 *
 * It belongs to the release path only — `verify` runs the TARGET lane, against
 * the published framework — but it is the single most expensive thing a release
 * push does, so it needs a memo of its own or the saving stops exactly where it
 * would matter most.
 */
export const HEAD_STEPS = ['starter-head-lane'] as const;
export const HEAD_GATE = 'verify:head';

/** Every flag this script accepts — the list `pre-push` is held against. */
export const VERIFY_FLAGS = ['--if-changed', '--fast', '--head', '--release'] as const;

export const PROFILES: Record<'full' | 'fast' | 'head', VerifyProfile> = {
  full: { gate: VERIFY_GATE, steps: VERIFY_STEPS, satisfiedBy: [], usesLaneEnvironment: true },
  fast: {
    gate: FAST_GATE,
    steps: FAST_STEPS,
    satisfiedBy: [VERIFY_GATE],
    usesLaneEnvironment: false,
  },
  head: { gate: HEAD_GATE, steps: HEAD_STEPS, satisfiedBy: [], usesLaneEnvironment: true },
};

const root = join(import.meta.dir, '..');

async function runStep(step: string): Promise<void> {
  const child = Bun.spawn(['bun', 'run', step], {
    cwd: root,
    stdout: 'inherit',
    stderr: 'inherit',
  });
  const code = await child.exited;
  if (code !== 0) throw new Error(`verify: \`bun run ${step}\` exited with ${code}`);
}

/**
 * What one heavy lane holds, in gibibytes, measured rather than guessed.
 *
 * `MemAvailable` sampled every two seconds through each lane on a 22 GiB host:
 * `starter-head-lane` 3.24, `supervised-lane` 3.33, `consumer-lane` 0.82. The
 * two that build Next and drive three browsers are the ones that matter, and
 * they agree; 3.5 is the pair rounded up, not a number that felt about right.
 */
export const HEAVY_LANE_MEMORY_GIB = 3.5;

/** The default ceiling — see `runBounded`: a developer machine, not the CI fleet. */
export const MAX_HEAVY_CONCURRENCY = 2;

/**
 * Available memory in gibibytes, or `undefined` where it cannot be read.
 *
 * Three outcomes, not two. `/proc/meminfo` does not exist on macOS and may be
 * unreadable in a container, and "could not measure" must not arrive looking
 * like a measurement — it keeps the historical default and says so.
 */
export function availableMemoryGib(meminfo?: string): number | undefined {
  let text = meminfo;
  if (text === undefined) {
    try {
      text = readFileSync('/proc/meminfo', 'utf8');
    } catch {
      return undefined;
    }
  }
  const match = text.match(/^MemAvailable:\s+(\d+) kB$/m);
  if (!match?.[1]) return undefined;
  return Number(match[1]) / 1024 / 1024;
}

export interface HeavyConcurrencyChoice {
  readonly concurrency: number;
  /** Why this number — the line the gate prints, so the choice is never silent. */
  readonly because: string;
}

/**
 * How many heavy lanes may run at once.
 *
 * Refuses a value that is not a positive integer rather than falling back to the
 * default: a typo in an environment variable that silently means "two" is a
 * setting that looks applied and is not.
 *
 * With no variable set it asks the host instead of asserting `2`. Two of these
 * lanes want ~7 GiB between them, and on a host with less the pair does not run
 * slowly — it runs into timeouts, in different tests every time, three failures
 * and thirty passes where the same lane alone passes forty-two in a sixth of
 * the wall clock. A gate that reddens from load is worse than a slow one: it
 * teaches its readers to disbelieve red, and the release profile is the one run
 * whose red cannot be repaired in place.
 *
 * The comment this replaces already knew all of that and left the fix to a
 * human remembering to export a variable.
 */
export function chooseHeavyConcurrency(
  raw = Bun.env.VERIFY_HEAVY_CONCURRENCY,
  // A measurer, not a measurement. With a plain `available = availableMemoryGib()`
  // parameter, "could not read it" and "caller said nothing" are the same
  // `undefined` and the default fires for both — so the unmeasurable branch was
  // unreachable from a test, and would have been unreachable from any caller
  // that wanted to state it. The test asking for that branch is what found it.
  measure: () => number | undefined = availableMemoryGib,
): HeavyConcurrencyChoice {
  if (raw !== undefined && raw !== '') {
    const parsed = Number(raw);
    if (!Number.isInteger(parsed) || parsed < 1) {
      throw new Error(`VERIFY_HEAVY_CONCURRENCY must be a positive integer, got "${raw}".`);
    }
    return { concurrency: parsed, because: `VERIFY_HEAVY_CONCURRENCY=${raw}` };
  }
  const available = measure();
  if (available === undefined) {
    return {
      concurrency: MAX_HEAVY_CONCURRENCY,
      because: 'available memory could not be read, keeping the default',
    };
  }
  const affordable = Math.floor(available / HEAVY_LANE_MEMORY_GIB);
  const concurrency = Math.min(MAX_HEAVY_CONCURRENCY, Math.max(1, affordable));
  return {
    concurrency,
    because: `${available.toFixed(1)} GiB available, ${HEAVY_LANE_MEMORY_GIB} GiB per heavy lane`,
  };
}

/** The number alone, for callers that do not print the reason. */
export function heavyConcurrency(
  raw = Bun.env.VERIFY_HEAVY_CONCURRENCY,
  measure: () => number | undefined = availableMemoryGib,
): number {
  return chooseHeavyConcurrency(raw, measure).concurrency;
}

/**
 * Run independent heavy lanes without turning a developer machine into the CI fleet.
 *
 * A lane that throws says so *here*, by name, before anything else reacts.
 * `Promise.all` rejects with the first failure and the surviving workers keep
 * running until their own step ends, so a lane failing takes its siblings' child
 * processes down with it — and in a backgrounded run all the reader sees is a
 * cluster of `terminated by signal SIGTERM` lines and a harness reporting the
 * job as killed. Three release runs were read as external interference before a
 * foreground one printed the real cause. The failure is the same either way; the
 * only thing missing was the sentence naming it.
 */
export async function runBounded(
  steps: readonly string[],
  concurrency: number,
  execute: (step: string) => Promise<void> = runStep,
  report: (line: string) => void = (line) => process.stderr.write(line),
): Promise<void> {
  const queue = [...steps];
  const workers = Array.from(
    { length: Math.min(Math.max(1, concurrency), queue.length) },
    async () => {
      while (queue.length > 0) {
        const step = queue.shift();
        if (!step) continue;
        try {
          await execute(step);
        } catch (error) {
          report(
            `[gate] ${step} FAILED: ${error instanceof Error ? error.message : String(error)}\n`,
          );
          report('[gate] cancelling the other heavy lanes; their SIGTERM is a consequence\n');
          throw error;
        }
      }
    },
  );
  await Promise.all(workers);
}

async function releaseProfile(): Promise<VerifyProfile> {
  const train = await readReleaseTrain(root);
  const targets = new Set(train.releases.map((release) => release.target));
  const lanes: string[] = [];
  if (targets.has('core')) {
    lanes.push(
      'test:agent-store-postgres',
      'smoke:next-ssr',
      'smoke:node',
      'consumer-lane',
      'starter-head-lane',
      'supervised-lane',
    );
  }
  if (targets.has('tui')) lanes.push('tui-packed-lane');
  if (targets.has('create-stitchkit'))
    lanes.push('agent-template-lane', 'starter-lane', 'supervised-lane');
  const uniqueLanes = [...new Set(lanes)];
  const targetKey = train.releases
    .map((release) => release.target)
    .sort()
    .join('+');
  return {
    gate: `verify:release:${targetKey}`,
    steps: ['lint', 'check', 'test', 'build', ...uniqueLanes],
    satisfiedBy: [],
    usesLaneEnvironment: uniqueLanes.length > 0,
  };
}

async function greenRecordFor(
  profile: VerifyProfile,
  key: string,
  memo: string,
): Promise<{ gate: string; record: GreenGateRecord } | undefined> {
  for (const gate of [profile.gate, ...profile.satisfiedBy]) {
    const record = findGreenGate(await readGreenGates(gate, memo), key);
    if (record) return { gate, record };
  }
  return undefined;
}

async function main(): Promise<void> {
  const args = Bun.argv.slice(2);
  const ifChanged = args.includes('--if-changed');
  const flags = new Set(args);
  const profile = flags.has('--release')
    ? await releaseProfile()
    : flags.has('--head')
      ? PROFILES.head
      : flags.has('--fast')
        ? PROFILES.fast
        : PROFILES.full;
  const known = new Set<string>(VERIFY_FLAGS);
  const unknown = args.filter((argument) => !known.has(argument));
  if (unknown.length > 0) {
    throw new Error(
      `Usage: verify.ts [--fast|--head] [--if-changed] (got ${unknown.join(' ')})`,
    );
  }
  // Checked, not resolved by precedence: two profiles asked for at once is a
  // caller that does not know which gate it wants, and quietly running one of
  // them tells nobody.
  const selectedProfiles = ['--fast', '--head', '--release'].filter((flag) => flags.has(flag));
  if (selectedProfiles.length > 1) {
    throw new Error(
      `verify.ts: ${selectedProfiles.join(' and ')} select different gates; pass one`,
    );
  }

  const memo = gateMemoPath();
  const toolchain = profile.usesLaneEnvironment
    ? `${await toolchainFingerprint()} ${await laneEnvironmentFingerprint()}`
    : await toolchainFingerprint();
  const before = await worktreeTreeHash(root);
  const key = greenGateKey({ tree: before, toolchain });

  if (ifChanged) {
    const green = await greenRecordFor(profile, key, memo);
    if (green) {
      // Named, never silent. A gate that skips without saying so is
      // indistinguishable from a gate that is not there, and the whole value of
      // the memo is that a reader can check the claim.
      process.stderr.write(
        `[gate] skipping ${profile.steps.join(', ')}: this exact working tree ${before.slice(0, 12)} passed \`${green.gate}\` at ${green.record.at} on ${green.record.toolchain} (HEAD was ${green.record.commit}). Any edit to any file runs it again.\n`,
      );
      return;
    }
  }

  const buildIndex = profile.steps.indexOf('build');
  const sequential =
    buildIndex === -1 ? profile.steps : profile.steps.slice(0, buildIndex + 1);
  const heavy = buildIndex === -1 ? [] : profile.steps.slice(buildIndex + 1);
  for (const step of sequential) {
    process.stderr.write(`[gate] ${step}\n`);
    await runStep(step);
  }
  // Measured, not asserted. The heavy lanes build Next twice, drive real
  // browsers and run a supervisor; two of them at once on a host that cannot
  // hold both get timeouts rather than results. `VERIFY_HEAVY_CONCURRENCY`
  // still wins — the host is asked only when nobody has answered.
  if (heavy.length > 0) {
    const choice = chooseHeavyConcurrency();
    process.stderr.write(
      `[gate] heavy lanes: ${choice.concurrency} at a time (${choice.because})\n`,
    );
    await runBounded(heavy, choice.concurrency, async (step) => {
      process.stderr.write(`[gate] ${step}\n`);
      await runStep(step);
    });
  }

  // The record is of the tree the run STARTED from — the input it actually
  // checked. If a step regenerated a committed artifact the tree has moved on,
  // and the memo deliberately will not answer for where it moved to.
  await writeGreenGate(
    profile.gate,
    { tree: before, toolchain, at: new Date().toISOString(), commit: await headCommit(root) },
    memo,
  );
  const after = await worktreeTreeHash(root);
  if (after !== before) {
    process.stderr.write(
      `[gate] ${profile.gate} green, and the run itself changed the tree (${before.slice(0, 12)} to ${after.slice(0, 12)}) — commit or revert what it produced; the memo answers only for the tree the run started from.\n`,
    );
    return;
  }
  process.stderr.write(`[gate] ${profile.gate} green for tree ${before.slice(0, 12)}.\n`);
}

if (import.meta.main) {
  await main();
}
