import { mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runNativeCommand } from '../packages/core/src/process/command';
import {
  type CanaryDecision,
  CONSUMER_CANARY_GATE,
  type ConsumerProfile,
  canaryFacts,
  consumerProfilePath,
  decideCanary,
  readConsumerProfile,
} from './consumer-canary-policy';
import {
  findGreenGate,
  gateMemoPath,
  greenGateKey,
  headCommit,
  readGreenGates,
  toolchainFingerprint,
  worktreeTreeHash,
  writeGreenGate,
} from './gate-memo';
import { git } from './local-git';
import { askReleaseCi, type CiRunSummary, selectSuccessfulCiRun } from './release-ci';
import { readReleaseTrain } from './release-train';

/**
 * Try the release candidate against the consumers the owner controls, before it is tagged.
 *
 * The framework's own lanes cannot contain a scenario only a consumer has: a stub that starts a
 * helper with `nohup … &` passed every lane here and failed 46 of a consumer's tests the day a
 * process default changed. The consumer is the only place that scenario exists, so the candidate
 * is handed to it first. The candidate is the tarball CI built for the release commit, the very
 * file that is published; the consumer is a scratch clone of its committed HEAD with `stitchkit`
 * overridden to that tarball; its own tests decide. → ADR 0250.
 */

export interface ConsumerOutcome {
  name: string;
  ok: boolean;
  /** Failing tests the candidate introduced: the consumer is green without it. */
  failedTests: string[];
  /** Failing tests the consumer already fails on its own pinned version; they do not decide. */
  preexisting: string[];
  /** Why the consumer did not pass when no test names it: install failure, timeout, bad exit. */
  detail: string;
  seconds: number;
}

interface CommandResult {
  exitCode: number | undefined;
  text: string;
}

const MAX_OUTPUT_BYTES = 64 * 1024 * 1024;
const FAILED_TEST = /^\(fail\) (.+?)(?: \[[\d.]+m?s\])?$/gm;

/** Runs a command to its end and keeps its combined output; a timeout or a launch failure is a result. */
async function capture(
  command: readonly string[],
  cwd: string,
  timeoutMs: number,
): Promise<CommandResult> {
  const [executable, ...args] = command;
  if (executable === undefined) throw new Error('empty command');
  const chunks: Uint8Array[] = [];
  try {
    const result = await runNativeCommand({
      executable,
      args,
      cwd,
      envPolicy: 'ambient',
      timeoutMs,
      maxOutputBytes: MAX_OUTPUT_BYTES,
      onOutput: (bytes) => {
        chunks.push(bytes.slice());
      },
    });
    return { exitCode: result.exitCode ?? undefined, text: decode(chunks) };
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    return { exitCode: undefined, text: `${decode(chunks)}\n${reason}` };
  }
}

function decode(chunks: readonly Uint8Array[]): string {
  return new TextDecoder().decode(Buffer.concat(chunks));
}

/** Points every `stitchkit` in the clone, workspaces included, at the candidate tarball. */
export async function overrideFramework(clone: string, tarball: string): Promise<void> {
  const path = join(clone, 'package.json');
  const manifest: unknown = JSON.parse(await readFile(path, 'utf8'));
  if (typeof manifest !== 'object' || manifest === null)
    throw new Error(`${path} is not a package manifest`);
  const overrides = Reflect.get(manifest, 'overrides');
  const existing = typeof overrides === 'object' && overrides !== null ? overrides : {};
  await writeFile(
    path,
    `${JSON.stringify({ ...manifest, overrides: { ...existing, stitchkit: `file:${tarball}` } }, null, 2)}\n`,
  );
}

type Consumer = ConsumerProfile['consumers'][number];

interface CloneRun {
  /** Where it ended: a run that never reached the tests says nothing about the candidate. */
  stage: 'clone' | 'install' | 'test';
  ok: boolean;
  failedTests: string[];
  detail: string;
}

/** One scratch clone of the consumer's committed HEAD, with the candidate if there is one, tested. */
async function runInClone(
  consumer: Consumer,
  tarball: string | undefined,
  scratch: string,
): Promise<CloneRun> {
  const label = `${tarball === undefined ? 'baseline' : 'candidate'}-${consumer.name}`;
  const clone = join(scratch, label.replaceAll(/[^\w.-]/g, '_'));
  const refused = (
    stage: CloneRun['stage'],
    what: string,
    result: CommandResult,
  ): CloneRun => ({
    stage,
    ok: false,
    failedTests: [],
    detail: `${what} failed: ${result.text.trim().slice(-600)}`,
  });
  const cloned = await capture(
    ['git', 'clone', '--quiet', consumer.path, clone],
    scratch,
    300_000,
  );
  if (cloned.exitCode !== 0) return refused('clone', 'clone', cloned);
  if (tarball !== undefined) await overrideFramework(clone, tarball);
  const installed = await capture(consumer.install, clone, consumer.timeoutMs);
  if (installed.exitCode !== 0)
    return refused('install', `install \`${consumer.install.join(' ')}\``, installed);
  const tested = await capture(consumer.test, clone, consumer.timeoutMs);
  if (tested.exitCode === 0) return { stage: 'test', ok: true, failedTests: [], detail: '' };
  const failedTests = [...tested.text.matchAll(FAILED_TEST)].flatMap((match) =>
    match[1] === undefined ? [] : [match[1]],
  );
  return {
    stage: 'test',
    ok: false,
    failedTests,
    detail:
      failedTests.length > 0
        ? `${failedTests.length} failing test(s)`
        : `\`${consumer.test.join(' ')}\` ended without a test report (exit ${tested.exitCode ?? 'none'}): ${tested.text.trim().slice(-600)}`,
  };
}

/**
 * The candidate on one consumer. A failure is judged against the consumer's own pinned version: a
 * test that fails there too is not the candidate's, and only a test the candidate newly fails stops
 * the release.
 */
async function tryConsumer(
  consumer: Consumer,
  tarball: string,
  scratch: string,
): Promise<ConsumerOutcome> {
  const started = performance.now();
  const outcome = (rest: Omit<ConsumerOutcome, 'name' | 'seconds'>): ConsumerOutcome => ({
    name: consumer.name,
    seconds: Math.round((performance.now() - started) / 100) / 10,
    ...rest,
  });
  const candidate = await runInClone(consumer, tarball, scratch);
  if (candidate.ok) return outcome({ ok: true, failedTests: [], preexisting: [], detail: '' });
  if (candidate.stage !== 'test' || candidate.failedTests.length === 0)
    return outcome({
      ok: false,
      failedTests: candidate.failedTests,
      preexisting: [],
      detail: candidate.detail,
    });
  const baseline = await runInClone(consumer, undefined, scratch);
  const known = new Set(baseline.failedTests);
  const introduced = candidate.failedTests.filter((name) => !known.has(name));
  const preexisting = candidate.failedTests.filter((name) => known.has(name));
  if (introduced.length === 0)
    return outcome({
      ok: true,
      failedTests: [],
      preexisting,
      detail: `${preexisting.length} test(s) fail on the consumer's own version too`,
    });
  return outcome({
    ok: false,
    failedTests: introduced,
    preexisting,
    detail: `${introduced.length} failing test(s) the consumer does not fail on its own version`,
  });
}

/** Tries `tarball` on every consumer of the profile, one after another, in scratch copies. */
export async function tryCandidateOnConsumers(
  profile: ConsumerProfile,
  tarball: string,
  scratch: string,
): Promise<ConsumerOutcome[]> {
  const outcomes: ConsumerOutcome[] = [];
  for (const consumer of profile.consumers)
    outcomes.push(await tryConsumer(consumer, tarball, scratch));
  return outcomes;
}

export interface CandidateSource {
  tarball: string;
  /** Only the tarball CI built for the release commit may certify the tag: the others lack what ships. */
  certifies: boolean;
  describe: string;
}

export interface CiCandidateDeps {
  askCi(sha: string): Promise<readonly CiRunSummary[]>;
  /** Downloads the `release-packages` artifact of a CI run into a directory. */
  download(runId: number, destination: string): Promise<void>;
}

/**
 * The tarball CI built for HEAD: the file `release.yml` publishes, with the Darwin addons that only
 * CI's macOS runners produce. HEAD must be a clean checkout of a commit whose exact-SHA push run is
 * green, because the result is recorded for this tree and certifies exactly it.
 */
export async function ciCandidate(
  root: string,
  destination: string,
  deps: CiCandidateDeps,
): Promise<CandidateSource> {
  if ((await git(root, ['status', '--porcelain'])).trim() !== '')
    throw new Error(
      'The tree is not clean: the canary certifies the tree CI built. Commit the release metadata, push release/X.Y.Z and wait for its CI run first.',
    );
  const sha = (await git(root, ['rev-parse', 'HEAD'])).trim();
  const runId = selectSuccessfulCiRun(await deps.askCi(sha), sha);
  await deps.download(runId, destination);
  const core = (await readReleaseTrain(root)).releases.find(
    (release) => release.target === 'core',
  );
  const tarball = (await readdir(destination)).find(
    (name) => core !== undefined && name === `stitchkit-${core.version}.tgz`,
  );
  if (tarball === undefined)
    throw new Error(
      `CI run ${runId} holds no stitchkit tarball for this train's core release`,
    );
  return {
    tarball: join(destination, tarball),
    certifies: true,
    describe: `the tarball of CI run ${runId} for ${sha.slice(0, 12)}`,
  };
}

/** Packs packages/core exactly as the consumer lane does: not what ships, since CI adds the Darwin addons. */
async function localCandidate(root: string, destination: string): Promise<CandidateSource> {
  const packed = await capture(
    [
      'bun',
      join(root, 'scripts/package-build-lock.ts'),
      '--',
      'bun',
      'pm',
      'pack',
      '--destination',
      destination,
    ],
    join(root, 'packages/core'),
    900_000,
  );
  const name = /[\w.@-]+\.tgz/.exec(packed.text)?.[0];
  if (packed.exitCode !== 0 || name === undefined)
    throw new Error(`Packing the candidate failed: ${packed.text.trim().slice(-800)}`);
  return {
    tarball: join(destination, name),
    certifies: false,
    describe: 'a local pack of the working tree, without the Darwin addons CI adds',
  };
}

/** `gh run download` resolves the repository from its working directory, so it runs inside the checkout. */
export function releasePackagesDownload(
  root: string,
  runId: number,
  destination: string,
): { command: string[]; cwd: string } {
  return {
    command: [
      'gh',
      'run',
      'download',
      String(runId),
      '--name',
      'release-packages',
      '--dir',
      destination,
    ],
    cwd: root,
  };
}

function downloadReleasePackages(root: string) {
  return async (runId: number, destination: string): Promise<void> => {
    const { command, cwd } = releasePackagesDownload(root, runId, destination);
    const downloaded = await capture(command, cwd, 300_000);
    if (downloaded.exitCode !== 0)
      throw new Error(
        `Downloading the release-packages artifact of run ${runId} failed: ${downloaded.text.trim().slice(-600)}`,
      );
  };
}

export function describeOutcomes(outcomes: readonly ConsumerOutcome[]): string {
  return outcomes
    .map((outcome) => {
      const head = outcome.ok
        ? `  ok    ${outcome.name} (${outcome.seconds}s)${outcome.detail ? `: ${outcome.detail}` : ''}`
        : `  FAIL  ${outcome.name} (${outcome.seconds}s): ${outcome.detail}`;
      return [head, ...outcome.failedTests.map((name) => `          - ${name}`)].join('\n');
    })
    .join('\n');
}

export interface CanaryRelease {
  decision: CanaryDecision;
  /** The reason a release waived the canary, recorded in `release-train.json`. */
  waiver: string | undefined;
}

export async function canaryRelease(root: string): Promise<CanaryRelease> {
  const train = await readReleaseTrain(root);
  return {
    decision: decideCanary(await canaryFacts(root, train)),
    waiver: train.consumerCanaryWaiver,
  };
}

/** What a canary answers for: this working tree's content, tried by this toolchain. */
async function memoSubject(root: string): Promise<{ tree: string; toolchain: string }> {
  return { tree: await worktreeTreeHash(root), toolchain: await toolchainFingerprint() };
}

/**
 * The tag-time check: a release that needs the canary does not get its tags without a green record
 * for this exact tree, or a waiver whose reason is committed with the release.
 */
export async function requireConsumerCanary(root: string): Promise<void> {
  const { decision, waiver } = await canaryRelease(root);
  if (!decision.required) {
    process.stderr.write(`[canary] not required: ${decision.because}.\n`);
    return;
  }
  if (waiver !== undefined) {
    process.stderr.write(`[canary] required (${decision.because}), waived: ${waiver}\n`);
    return;
  }
  const record = findGreenGate(
    await readGreenGates(CONSUMER_CANARY_GATE, gateMemoPath()),
    greenGateKey(await memoSubject(root)),
  );
  if (record === undefined)
    throw new Error(
      `A consumer canary is required (${decision.because}) and none is recorded for this tree. Run \`bun run consumer-canary\` and fix what it reports, or record the reason in release-train.json as "consumerCanaryWaiver".`,
    );
  process.stderr.write(
    `[canary] required (${decision.because}); green at ${record.at} on ${record.commit}.\n`,
  );
}

export type CandidateChoice =
  | { kind: 'ci' }
  | { kind: 'local' }
  | { kind: 'tarball'; path: string };

export function parseCandidateChoice(args: readonly string[]): CandidateChoice {
  if (args.length === 0) return { kind: 'ci' };
  const [flag, value] = args;
  if (flag === '--local' && args.length === 1) return { kind: 'local' };
  if (flag === '--tarball' && value !== undefined && args.length === 2)
    return { kind: 'tarball', path: value };
  throw new Error('Usage: consumer-canary.ts [--local | --tarball <path>]');
}

export async function runConsumerCanary(
  root: string,
  choice: CandidateChoice = { kind: 'ci' },
): Promise<boolean> {
  const profile = await readConsumerProfile(consumerProfilePath());
  const scratch = await mkdtemp(join(tmpdir(), 'stitchkit-canary-'));
  try {
    const subject = await memoSubject(root);
    const candidate: CandidateSource =
      choice.kind === 'ci'
        ? await ciCandidate(root, scratch, {
            askCi: (sha) => askReleaseCi(root, sha),
            download: downloadReleasePackages(root),
          })
        : choice.kind === 'local'
          ? await localCandidate(root, scratch)
          : { tarball: choice.path, certifies: false, describe: `the tarball ${choice.path}` };
    process.stderr.write(`[canary] candidate: ${candidate.describe}\n`);
    const outcomes = await tryCandidateOnConsumers(profile, candidate.tarball, scratch);
    process.stdout.write(`${describeOutcomes(outcomes)}\n`);
    if (outcomes.some((outcome) => !outcome.ok)) return false;
    if (!candidate.certifies) {
      process.stderr.write(
        '[canary] green, but not recorded: only the tarball CI built for the release commit certifies a tag.\n',
      );
      return true;
    }
    // The tree is read before the run and again now: a tree edited meanwhile was not the candidate.
    if (greenGateKey(await memoSubject(root)) !== greenGateKey(subject))
      throw new Error(
        'The working tree changed while the canary ran; run it again on the final tree.',
      );
    await writeGreenGate(
      CONSUMER_CANARY_GATE,
      { ...subject, at: new Date().toISOString(), commit: await headCommit(root) },
      gateMemoPath(),
    );
    return true;
  } finally {
    await rm(scratch, { recursive: true, force: true });
  }
}

if (import.meta.main) {
  const root = join(import.meta.dir, '..');
  const args = Bun.argv.slice(2);
  if (args[0] === 'decide') {
    const { decision, waiver } = await canaryRelease(root);
    process.stdout.write(`${JSON.stringify({ ...decision, waiver: waiver ?? null })}\n`);
  } else {
    const choice = parseCandidateChoice(args);
    const { decision } = await canaryRelease(root);
    process.stderr.write(
      `[canary] ${decision.required ? 'required' : 'not required'}: ${decision.because}\n`,
    );
    process.exit((await runConsumerCanary(root, choice)) ? 0 : 1);
  }
}
