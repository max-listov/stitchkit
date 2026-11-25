import { z } from 'zod';
import { runNativeCommand } from '../packages/core/src/process/command';

/**
 * What GitHub itself writes when a hosted runner never took a job or was taken away mid-job.
 * The exit code is not one of them: the shutdown signal ends the step with 143, which a test
 * that sends SIGTERM can produce as well — only GitHub's own line names the provider.
 */
export const RUNNER_LOSS_MARKERS = [
  // A job no runner ever acquired: an annotation, no log, an empty `runner_name`.
  'The job was not acquired by Runner',
  // A runner shut down under a running job: the last `##[error]` line of the job log.
  'The runner has received a shutdown signal',
  // A hosted runner that stopped answering mid-job.
  'lost communication with the server',
] as const;

/**
 * The aggregates whose failure is a consequence: they refuse a lost lane through
 * `scripts/ci-evidence.ts`, so they fail with it and are re-run with it.
 */
export const CI_AGGREGATE_JOB_NAMES = [
  'Exact release artifacts',
  'Required evidence complete',
] as const;

const RunSchema = z.object({
  id: z.number().int().positive(),
  event: z.string(),
  conclusion: z.string().nullable(),
  run_attempt: z.number().int().positive(),
  head_sha: z.string(),
});
export type CiRun = z.infer<typeof RunSchema>;

const JobSchema = z.object({
  id: z.number().int().positive(),
  name: z.string(),
  conclusion: z.string().nullable(),
});
const JobsSchema = z.array(JobSchema);
export type CiJob = z.infer<typeof JobSchema>;

export interface CiJobTrace {
  readonly name: string;
  readonly conclusion: string | null;
  /** GitHub wrote one of `RUNNER_LOSS_MARKERS` for this job. */
  readonly runnerLost: boolean;
}

export type CiRetryDecision =
  | { readonly retry: true; readonly lost: readonly string[] }
  | { readonly retry: false; readonly reason: string };

const PROVEN = new Set(['success', 'skipped', 'neutral']);

/** A conclusion that is not a proof of the job: failure, cancellation, timeout, missing. */
export function isUnprovenJob(job: Pick<CiJob, 'conclusion'>): boolean {
  return job.conclusion === null || !PROVEN.has(job.conclusion);
}

export function isAggregateJob(name: string): boolean {
  return CI_AGGREGATE_JOB_NAMES.some((aggregate) => aggregate === name);
}

export function namesRunnerLoss(text: string): boolean {
  return RUNNER_LOSS_MARKERS.some((marker) => text.includes(marker));
}

/** The runs a lost runner may repeat: the nightly run and the push run a release reads. */
const RETRIED_EVENTS: ReadonlySet<string> = new Set(['schedule', 'push']);

/**
 * One retry, of a scheduled or push run, and only when every unproven lane lost its runner.
 * A push run is the exact-SHA release evidence; a lost runner proved nothing about its code, and
 * the repeat runs the same SHA and plan, so the evidence a release reads is still that code's.
 * A code failure, a pull request and a second attempt are never repeated. → ADR 0302
 */
export function decideCiRetry(run: CiRun, jobs: readonly CiJobTrace[]): CiRetryDecision {
  if (!RETRIED_EVENTS.has(run.event))
    return {
      retry: false,
      reason: `a ${run.event} run is not repeated`,
    };
  if (run.run_attempt !== 1)
    return {
      retry: false,
      reason: `attempt ${run.run_attempt} already is the one repetition`,
    };
  if (run.conclusion !== 'failure')
    return {
      retry: false,
      reason: `run concluded ${run.conclusion ?? 'pending'}, not failure`,
    };
  const unproven = jobs.filter(isUnprovenJob);
  const code = unproven.filter((job) => !job.runnerLost && !isAggregateJob(job.name));
  if (code.length > 0)
    return {
      retry: false,
      reason: `failed in code, not in the provider: ${code.map((job) => `${job.name} (${job.conclusion ?? 'missing'})`).join(', ')}`,
    };
  const lost = unproven.filter((job) => job.runnerLost).map((job) => job.name);
  if (lost.length === 0)
    return { retry: false, reason: 'no lane lost its runner; only an aggregate failed' };
  return { retry: true, lost };
}

async function gh(args: readonly string[], maxOutputBytes: number): Promise<string> {
  const result = await runNativeCommand({
    executable: 'gh',
    args: [...args],
    cwd: process.cwd(),
    envPolicy: 'ambient',
    timeoutMs: 60_000,
    capture: true,
    maxOutputBytes,
  });
  if (result.exitCode !== 0)
    throw new Error(
      `gh ${args[1] ?? ''} refused: ${new TextDecoder().decode(result.stderr).trim()}`,
    );
  return new TextDecoder().decode(result.stdout);
}

/** Annotations first (the never-acquired job has no log), then the job log. */
async function runnerLost(repo: string, job: CiJob): Promise<boolean> {
  const annotations = await gh(
    ['api', `repos/${repo}/check-runs/${job.id}/annotations`, '--jq', '.[].message'],
    1024 * 1024,
  );
  if (namesRunnerLoss(annotations)) return true;
  const log = await gh(
    ['api', '--allow-escape-sequences', `repos/${repo}/actions/jobs/${job.id}/logs`],
    64 * 1024 * 1024,
  ).catch((error: unknown) => {
    // A job that never started has no log; its absence is not a loss marker.
    console.log(
      `[ci-retry] no log for ${job.name}: ${error instanceof Error ? error.message : error}`,
    );
    return '';
  });
  return namesRunnerLoss(log);
}

export async function traceCiRun(
  repo: string,
  runId: number,
): Promise<{ run: CiRun; jobs: CiJobTrace[] }> {
  const run = RunSchema.parse(
    JSON.parse(await gh(['api', `repos/${repo}/actions/runs/${runId}`], 1024 * 1024)),
  );
  // `--paginate --jq` prints one compact job per line across every page (`--slurp` refuses `--jq`).
  const listed = await gh(
    [
      'api',
      '--paginate',
      `repos/${repo}/actions/runs/${runId}/attempts/${run.run_attempt}/jobs?per_page=100`,
      '--jq',
      '.jobs[] | {id, name, conclusion}',
    ],
    8 * 1024 * 1024,
  );
  const jobs = JobsSchema.parse(
    listed
      .split('\n')
      .filter((line) => line.trim() !== '')
      .map((line) => JSON.parse(line)),
  );
  const traces: CiJobTrace[] = [];
  for (const job of jobs) {
    const lost =
      isUnprovenJob(job) && !isAggregateJob(job.name) && (await runnerLost(repo, job));
    traces.push({ name: job.name, conclusion: job.conclusion, runnerLost: lost });
  }
  return { run, jobs: traces };
}

if (import.meta.main) {
  const repo = z
    .string()
    .regex(/^[^/\s]+\/[^/\s]+$/)
    .parse(Bun.env.GH_REPO);
  const runId = z.coerce.number().int().positive().parse(Bun.env.CI_RUN_ID);
  const dryRun = Bun.argv.includes('--dry-run');
  const { run, jobs } = await traceCiRun(repo, runId);
  const decision = decideCiRetry(run, jobs);
  if (!decision.retry) {
    console.log(
      `[ci-retry] run ${run.id} at ${run.head_sha} stays as it is: ${decision.reason}`,
    );
  } else {
    console.log(
      `[ci-retry] run ${run.id} at ${run.head_sha} lost its runner in: ${decision.lost.join(', ')}; repeating its failed jobs once`,
    );
    if (!dryRun)
      await gh(
        ['api', '--method', 'POST', `repos/${repo}/actions/runs/${run.id}/rerun-failed-jobs`],
        64 * 1024,
      );
  }
}
