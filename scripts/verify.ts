import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { type CgroupMemoryBudget, cgroupMemoryBudget } from './gate-cgroup-memory';
import { watchWorktreeInputs, worktreeInputGeneration } from './gate-input-generation';
import {
  findGreenGate,
  type GreenGateRecord,
  gateMemoPath,
  greenGateKey,
  headCommit,
  laneEnvironmentFingerprint,
  laneEnvironmentIsReusable,
  readGreenGates,
  toolchainFingerprint,
  worktreeTreeHash,
} from './gate-memo';
import { invalidateGreenEvidence, saveGreenEvidence } from './verify-evidence';
import {
  FAST_STEPS,
  PROFILES,
  releaseProfile,
  VERIFY_FLAGS,
  type VerifyProfile,
} from './verify-profiles';

const root = join(import.meta.dir, '..');

async function runStep(step: string): Promise<void> {
  const started = performance.now();
  const child = Bun.spawn(['bun', 'run', step], {
    cwd: root,
    stdout: 'inherit',
    stderr: 'inherit',
  });
  const code = await child.exited;
  process.stderr.write(
    `[gate] ${step}: ${((performance.now() - started) / 1000).toFixed(3)}s, exit ${code}\n`,
  );
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
 * like a measurement — the scheduler uses one lane and says so.
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
  const field = (name: string): number | undefined => {
    const match = text?.match(new RegExp(`^${name}:\\s+(\\d+) kB$`, 'm'));
    return match?.[1] === undefined ? undefined : Number(match[1]) / 1024 / 1024;
  };
  const available = field('MemAvailable');
  if (available === undefined) return undefined;
  // `MemAvailable` counts what the kernel could hand over *including* what it
  // would evict — and evicting needs somewhere to put it. With swap spent there
  // is nowhere, so the same number is paid for in thrashing instead of pages,
  // and lanes sized against it are killed rather than slowed.
  //
  // Measured here on 2026-09-15 during the 0.90.0 release: `9.2 GiB available`
  // with `SwapFree` at 110 MiB of 16 GiB chose two heavy lanes, and three runs
  // in a row were killed. `MemFree` in that same minute was 0.4 GiB.
  //
  // So when swap is effectively gone, the honest figure is what is free right
  // now, not what could be freed. No swap configured at all is NOT that case —
  // a host without swap never promised eviction into it, and its `MemAvailable`
  // is the ordinary answer.
  const swapTotal = field('SwapTotal');
  const swapFree = field('SwapFree');
  if (swapTotal === undefined || swapFree === undefined || swapTotal === 0) return available;
  if (swapFree / swapTotal > SWAP_EXHAUSTED_FRACTION) return available;
  return Math.min(available, field('MemFree') ?? available);
}

/**
 * Below this much of swap left, `MemAvailable` is a promise the host cannot keep.
 *
 * Five percent rather than zero because the last pages go fast and the gate
 * takes minutes: a run that starts at exactly zero free swap and one that starts
 * at two percent end the same way.
 */
export const SWAP_EXHAUSTED_FRACTION = 0.05;

/** Host headroom cannot authorize memory that the execution cgroup denies. */
export function availableGateMemoryGib(
  host = availableMemoryGib(),
  cgroup: CgroupMemoryBudget = cgroupMemoryBudget(),
): number | undefined {
  if (cgroup.kind === 'unavailable') return undefined;
  if (cgroup.kind !== 'bounded') return host;
  return host === undefined ? cgroup.availableGib : Math.min(host, cgroup.availableGib);
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
  measure: () => number | undefined = availableGateMemoryGib,
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
      concurrency: 1,
      because: 'available memory could not be read, using one heavy lane',
    };
  }
  const affordable = Math.floor(available / HEAVY_LANE_MEMORY_GIB);
  const concurrency = Math.min(MAX_HEAVY_CONCURRENCY, Math.max(1, affordable));
  return {
    concurrency,
    because: `${available.toFixed(1)} GiB affordable, ${HEAVY_LANE_MEMORY_GIB} GiB per heavy lane`,
  };
}

/**
 * Sample available memory until the returned reader is called, then answer with
 * the lowest value seen. `undefined` where the host cannot be measured at all,
 * which is not the same fact as "there was plenty" and must not print like it.
 */
export function startMemoryFloor(
  measure: () => number | undefined = availableGateMemoryGib,
  everyMs = 2_000,
): () => number | undefined {
  let floor = measure();
  if (floor === undefined) return () => undefined;
  const timer = setInterval(() => {
    const sample = measure();
    if (sample !== undefined && (floor === undefined || sample < floor)) floor = sample;
  }, everyMs);
  timer.unref?.();
  return () => {
    clearInterval(timer);
    return floor;
  };
}

/** The number alone, for callers that do not print the reason. */
export function heavyConcurrency(
  raw = Bun.env.VERIFY_HEAVY_CONCURRENCY,
  measure: () => number | undefined = availableGateMemoryGib,
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
  /**
   * The memory floor while the lanes ran, printed only when one fails.
   *
   * A lane dying to a signal looks identical whatever killed it, and the first
   * explanation anyone reaches for is memory. On 2026-09-08 a `supervised-lane`
   * build died to SIGTERM, the run was called an out-of-memory kill, and a
   * direct reproduction of the same two lanes side by side then passed with
   * 7.1 GiB still available — so the diagnosis was wrong and nothing in the
   * output could have said so. Recording the floor makes the next such death
   * answer that question instead of inviting a guess.
   */
  watchMemory: () => () => number | undefined = startMemoryFloor,
): Promise<void> {
  const memoryFloor = watchMemory();
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
          const floor = memoryFloor();
          report(
            floor === undefined
              ? '[gate] memory during the lanes was not measurable on this host\n'
              : `[gate] memory floor while the lanes ran: ${floor.toFixed(2)} GiB available\n`,
          );
          report('[gate] cancelling the other heavy lanes; their SIGTERM is a consequence\n');
          throw error;
        }
      }
    },
  );
  await Promise.all(workers);
}

async function greenRecordFor(
  profile: VerifyProfile,
  key: string,
  memo: string,
): Promise<{ gate: string; record: GreenGateRecord } | undefined> {
  const record = findGreenGate(await readGreenGates(profile.gate, memo), key);
  return record ? { gate: profile.gate, record } : undefined;
}

async function main(): Promise<void> {
  const args = Bun.argv.slice(2);
  const ifChanged = args.includes('--if-changed');
  const flags = new Set(args);
  const profile = flags.has('--release')
    ? await releaseProfile(root)
    : flags.has('--head')
      ? PROFILES.head
      : flags.has('--candidate')
        ? PROFILES.candidate
        : flags.has('--fast')
          ? PROFILES.fast
          : PROFILES.full;
  const known = new Set<string>(VERIFY_FLAGS);
  const unknown = args.filter((argument) => !known.has(argument));
  if (unknown.length > 0) {
    throw new Error(
      `Usage: verify.ts [--fast|--head|--release|--candidate] [--if-changed] (got ${unknown.join(' ')})`,
    );
  }
  // Checked, not resolved by precedence: two profiles asked for at once is a
  // caller that does not know which gate it wants, and quietly running one of
  // them tells nobody.
  const selectedProfiles = ['--fast', '--head', '--release', '--candidate'].filter((flag) =>
    flags.has(flag),
  );
  if (selectedProfiles.length > 1) {
    throw new Error(
      `verify.ts: ${selectedProfiles.join(' and ')} select different gates; pass one`,
    );
  }

  const memo = gateMemoPath();
  const runtimeToolchain = await toolchainFingerprint();
  const laneEnvironment = profile.usesLaneEnvironment
    ? await laneEnvironmentFingerprint()
    : undefined;
  const reusableEnvironment =
    laneEnvironment === undefined || laneEnvironmentIsReusable(laneEnvironment);
  const toolchain =
    laneEnvironment === undefined
      ? runtimeToolchain
      : `${runtimeToolchain} ${laneEnvironment}`;
  const guard = await watchWorktreeInputs(root);
  try {
    const before = await worktreeTreeHash(root);
    const generation = await worktreeInputGeneration(root);
    const key = greenGateKey({ tree: before, toolchain });

    if (ifChanged && reusableEnvironment) {
      const green = await greenRecordFor(profile, key, memo);
      if (green && !(await guard.finish())) {
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

    const after = await worktreeTreeHash(root);
    const changed =
      after !== before ||
      generation !== (await worktreeInputGeneration(root)) ||
      (await guard.finish());
    const record = {
      tree: before,
      toolchain,
      at: new Date().toISOString(),
      commit: await headCommit(root),
    };
    if (changed) {
      await invalidateGreenEvidence(profile, record, runtimeToolchain, memo);
      process.stderr.write(
        `[gate] ${profile.gate} completed, but its inputs changed during the run (${before.slice(0, 12)} to ${after.slice(0, 12)}); no reusable green memo was saved.\n`,
      );
      return;
    }
    if (!reusableEnvironment) {
      await invalidateGreenEvidence(profile, record, runtimeToolchain, memo);
      if (FAST_STEPS.every((step) => profile.steps.includes(step))) {
        await saveGreenEvidence(
          PROFILES.fast,
          { ...record, toolchain: runtimeToolchain },
          runtimeToolchain,
          memo,
        );
      }
      process.stderr.write(
        `[gate] ${profile.gate} completed; external inputs were not fully measurable, no heavy memo saved.\n`,
      );
      return;
    }
    await saveGreenEvidence(profile, record, runtimeToolchain, memo);
    process.stderr.write(`[gate] ${profile.gate} green for tree ${before.slice(0, 12)}.\n`);
  } finally {
    await guard.finish();
  }
}

if (import.meta.main) {
  await main();
}
