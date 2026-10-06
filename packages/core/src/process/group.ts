import { raceAbort } from '../internal/abort-race';
import { assertPositiveSafeInteger } from '../internal/positive-integer';
import { MAX_TIMER_MS, sleep } from '../internal/timers';
import { NativeCommandError, type ParsedNativeCommandStopPolicy } from './contract';

/** Chain native-sized timers; internal callers retain their declared safe-integer deadline. */
export function createCommandDeadline(timeoutMs: number, reason: unknown) {
  assertPositiveSafeInteger('Command deadline', timeoutMs, RangeError);
  const controller = new AbortController();
  const deadline = performance.now() + timeoutMs;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const schedule = () => {
    const remaining = deadline - performance.now();
    if (remaining <= 0) controller.abort(reason);
    else timer = setTimeout(schedule, Math.min(remaining, MAX_TIMER_MS));
  };
  schedule();
  return {
    signal: controller.signal,
    cancel() {
      if (timer !== undefined) clearTimeout(timer);
    },
  };
}

function deniedOnDarwin(error: unknown): boolean {
  return (
    process.platform === 'darwin' &&
    error instanceof Error &&
    'code' in error &&
    error.code === 'EPERM'
  );
}

function isErrno(error: unknown, code: string): boolean {
  return error instanceof Error && 'code' in error && error.code === code;
}

/** Send `signal` to the group. `false` is `ESRCH`: the kernel found no member to receive it. */
export function signalGroup(pid: number | undefined, signal: NodeJS.Signals): boolean {
  if (pid === undefined) return false;
  try {
    process.kill(-pid, signal);
    return true;
  } catch (error) {
    if (isErrno(error, 'ESRCH')) return false;
    throw error;
  }
}
function exists(pid: number | undefined): boolean {
  if (pid === undefined) return false;
  try {
    process.kill(-pid, 0);
    return true;
  } catch (error) {
    if (isErrno(error, 'ESRCH')) return false;
    // Darwin filters zombies out of killpg and can report EPERM until they
    // are reaped. It is still an existing/unknown group, never proof of death.
    if (deniedOnDarwin(error)) return true;
    throw error;
  }
}

/** Resolves `true` when a signal was delivered and `false` when the group was already gone. */
async function signalUntilSettled(
  pid: number | undefined,
  signal: NodeJS.Signals,
  deadline: number,
): Promise<boolean> {
  for (;;) {
    try {
      return signalGroup(pid, signal);
    } catch (error) {
      // Do not suppress permission failures. Success requires an actual
      // delivered signal or ESRCH; a persistent refusal keeps its own cause.
      if (!deniedOnDarwin(error) || performance.now() >= deadline) throw error;
      await new Promise((resolve) =>
        setTimeout(resolve, Math.min(10, deadline - performance.now())),
      );
    }
  }
}

/** One stop of a command's group: the policy, the bound for retries and whether to skip the grace. */
export interface CommandGroupStop {
  readonly pid: number | undefined;
  readonly policy: ParsedNativeCommandStopPolicy;
  readonly cleanupTimeoutMs: number;
  /** KILL at once, as `policy.killOn` does when it is aborted. */
  readonly force: boolean;
}

/**
 * Stop the group `pid` leads: the policy's signal to every member, a grace for it to leave,
 * then KILL.
 *
 * `ESRCH` means the kernel found no member, and the numeric group id may already
 * belong to an unrelated group, so no further signal follows an observed absence.
 * A group still visible after the grace (including members holding a pipe after
 * the leader exited, or Darwin zombies awaiting the reaper) is killed. The probe
 * backs off to 250 ms, so a grace of an hour costs a few thousand probes, not millions.
 * Resolves `true` when the group still had a member to receive the first signal.
 */
export async function stopCommandGroup(stop: CommandGroupStop): Promise<boolean> {
  const { pid, policy } = stop;
  const deadline = performance.now() + policy.graceMs + stop.cleanupTimeoutMs;
  if (stop.force || policy.killOn?.aborted)
    return signalUntilSettled(pid, 'SIGKILL', deadline);
  if (!(await signalUntilSettled(pid, policy.signal, deadline))) return false;
  const until = performance.now() + policy.graceMs;
  let interval = 10;
  let present = exists(pid);
  while (present && !policy.killOn?.aborted && performance.now() < until) {
    // An abort ends the wait early; the loop condition then sees it.
    await sleep(Math.min(interval, until - performance.now()), policy.killOn).catch(
      () => undefined,
    );
    interval = Math.min(interval * 2, 250);
    present = exists(pid);
  }
  if (present) await signalUntilSettled(pid, 'SIGKILL', deadline);
  return true;
}

/** The leader of a stop with `target: 'leader'`: its exit state and the promise of its exit. */
export interface CommandLeader {
  readonly pid?: number;
  readonly exitCode: number | null;
  readonly signalCode: string | null;
}

/**
 * Stop a command cooperatively: the policy's signal to the leader alone, a grace for the
 * leader to exit, then KILL to whatever is left of the group.
 *
 * The leader's exit ends the grace at once: the rest of the group are processes the leader
 * left behind, and nothing in them was asked to cooperate. A leader that has already
 * exited is not signalled again, because its pid may be reused once it was reaped.
 * Resolves `true` when the leader or a member of its group received a signal.
 */
export async function stopCommandLeader(
  stop: CommandGroupStop & { leader: CommandLeader; leaderExit: Promise<unknown> },
): Promise<boolean> {
  const { pid, policy, leader } = stop;
  const deadline = performance.now() + policy.graceMs + stop.cleanupTimeoutMs;
  const running = () => leader.exitCode === null && leader.signalCode === null;
  let signalled = false;
  if (!stop.force && !policy.killOn?.aborted && pid !== undefined && running()) {
    try {
      process.kill(pid, policy.signal);
      signalled = true;
    } catch (error) {
      if (!isErrno(error, 'ESRCH')) throw error;
    }
    const grace = new AbortController();
    const end = () => grace.abort();
    policy.killOn?.addEventListener('abort', end, { once: true });
    void stop.leaderExit.then(end, end);
    // Ended early by the leader's exit or `killOn`; either way KILL follows.
    await sleep(policy.graceMs, grace.signal).catch(() => undefined);
    policy.killOn?.removeEventListener('abort', end);
    grace.abort();
  }
  return (await signalUntilSettled(pid, 'SIGKILL', deadline)) || signalled;
}

export function commandCleanupError(cause: unknown): NativeCommandError {
  return new NativeCommandError('COMMAND_CLEANUP', 'Command cleanup did not complete', {
    cause,
  });
}

export function waitForCommandClose<T>(closed: Promise<T>, timeoutMs: number): Promise<T> {
  const deadline = createCommandDeadline(
    timeoutMs,
    new DOMException('Command settlement timed out', 'TimeoutError'),
  );
  return raceAbort(closed, deadline.signal).finally(() => deadline.cancel());
}
