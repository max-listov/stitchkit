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

/**
 * The whole repository gate, in order, as one list.
 *
 * It used to be a `&&` chain inside `package.json`. Moving it here costs
 * nothing and buys two things the chain could not have: the gate can say which
 * step it is on, and it can decide — once, on evidence — whether this exact
 * tree has already been through it.
 */
export const VERIFY_STEPS = [
  'lint',
  'check',
  'test',
  'test:agent-store-postgres',
  'build',
  'smoke:next-ssr',
  'smoke:node',
  'consumer-lane',
  'tui-packed-lane',
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
export const FAST_STEPS = ['lint', 'check', 'test'] as const;

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
export const VERIFY_FLAGS = ['--if-changed', '--fast', '--head'] as const;

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
  const profile = flags.has('--head')
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
  if (flags.has('--fast') && flags.has('--head')) {
    throw new Error('verify.ts: --fast and --head select different gates; pass one');
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

  for (const step of profile.steps) {
    process.stderr.write(`[gate] ${step}\n`);
    await runStep(step);
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
