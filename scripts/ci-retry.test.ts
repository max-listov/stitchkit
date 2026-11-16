import { describe, expect, test } from 'bun:test';
import {
  CI_AGGREGATE_JOB_NAMES,
  type CiJobTrace,
  type CiRun,
  decideCiRetry,
  namesRunnerLoss,
} from './ci-retry';

const [ARTIFACTS, RESULT] = CI_AGGREGATE_JOB_NAMES;
const scheduled: CiRun = {
  id: 1,
  event: 'schedule',
  conclusion: 'failure',
  run_attempt: 1,
  head_sha: '1393510c3910413205d78b610406762f0c6586a4',
};
const green = (name: string): CiJobTrace => ({
  name,
  conclusion: 'success',
  runnerLost: false,
});
const aggregatesRefused: CiJobTrace[] = [
  { name: ARTIFACTS, conclusion: 'failure', runnerLost: false },
  { name: RESULT, conclusion: 'failure', runnerLost: false },
];

// The two red nightly runs that opened this: 43859839238 (no runner ever acquired the job,
// cancelled) and 43586232060 (runner shut down mid-job, step exit 143).
const neverAcquired: CiJobTrace = {
  name: 'Packed contained files / arm64',
  conclusion: 'cancelled',
  runnerLost: true,
};
const shutDown: CiJobTrace = {
  name: 'Packed contained files / arm64',
  conclusion: 'failure',
  runnerLost: true,
};
const codeFailure: CiJobTrace = {
  name: 'Packed contained files / x64',
  conclusion: 'failure',
  runnerLost: false,
};

describe('which red run is repeated', () => {
  test('a scheduled run whose only unproven lane lost its runner is repeated, naming that lane', () => {
    for (const lost of [neverAcquired, shutDown]) {
      expect(
        decideCiRetry(scheduled, [
          green('Evidence plan'),
          green('Packed contained files / x64'),
          lost,
          ...aggregatesRefused,
        ]),
      ).toEqual({ retry: true, lost: ['Packed contained files / arm64'] });
    }
  });

  test('a code failure is never repeated, even beside a lost lane', () => {
    for (const jobs of [
      [codeFailure, ...aggregatesRefused],
      [neverAcquired, codeFailure, ...aggregatesRefused],
      [{ ...codeFailure, conclusion: 'timed_out' }, ...aggregatesRefused],
    ]) {
      const decision = decideCiRetry(scheduled, jobs);
      expect(decision.retry).toBe(false);
      if (!decision.retry) expect(decision.reason).toContain('Packed contained files / x64');
    }
  });

  test('an aggregate failing on its own, with every lane green, is not a provider loss', () => {
    expect(decideCiRetry(scheduled, [green('Evidence plan'), ...aggregatesRefused])).toEqual({
      retry: false,
      reason: 'no lane lost its runner; only an aggregate failed',
    });
  });

  test('push evidence, a second attempt and a non-failed run are left exactly as they are', () => {
    const jobs = [neverAcquired, ...aggregatesRefused];
    for (const [run, reason] of [
      [{ ...scheduled, event: 'push' }, 'a push run is exact evidence'],
      [{ ...scheduled, event: 'pull_request' }, 'a pull_request run is exact evidence'],
      [{ ...scheduled, run_attempt: 2 }, 'attempt 2 already is the one repetition'],
      [{ ...scheduled, conclusion: 'cancelled' }, 'run concluded cancelled'],
      [{ ...scheduled, conclusion: 'success' }, 'run concluded success'],
    ] as const) {
      const decision = decideCiRetry(run, jobs);
      expect(decision.retry).toBe(false);
      if (!decision.retry) expect(decision.reason).toContain(reason);
    }
  });
});

describe('what names a lost runner', () => {
  test("GitHub's own lines from the two red runs are recognised", () => {
    // Annotation of job 133273818753 (run 43859839238).
    expect(
      namesRunnerLoss(
        'The job was not acquired by Runner of type hosted even after multiple attempts',
      ),
    ).toBe(true);
    // Last log line of job 132421342960 (run 43586232060).
    expect(
      namesRunnerLoss(
        '2026-11-14T10:41:46.1150240Z ##[error]The runner has received a shutdown signal. This can happen when the runner service is stopped, or a manually started runner is canceled.',
      ),
    ).toBe(true);
    expect(
      namesRunnerLoss(
        'The hosted runner: GitHub Actions 1000012814 lost communication with the server.',
      ),
    ).toBe(true);
  });

  test('an exit code alone, a test failure or a timeout is not a provider loss', () => {
    for (const line of [
      '##[error]Process completed with exit code 143.',
      '##[error]Process completed with exit code 1.',
      '(fail) owner loss > reaps the group [61002.00ms]',
      'The job running on runner GitHub Actions 1000010300 has exceeded the maximum execution time of 15 minutes.',
    ]) {
      expect(namesRunnerLoss(line)).toBe(false);
    }
  });
});
