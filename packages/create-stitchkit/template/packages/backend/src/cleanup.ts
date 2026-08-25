import { CLEANUP_BUDGET_MS } from '@app/config/shutdown';

export interface CleanupStep {
  name: string;
  close: () => Promise<unknown>;
}

export interface CleanupFailure {
  name: string;
  cause: unknown;
}

export interface CleanupResult {
  /** Steps that did not finish inside the budget, in order. */
  unfinished: string[];
  /** Steps that finished by throwing, with what they threw. */
  failed: CleanupFailure[];
  durationMs: number;
}

/** How one step ended: in time, in time but throwing, or not in time. */
type StepOutcome =
  | { kind: 'finished' }
  | { kind: 'threw'; cause: unknown }
  | { kind: 'expired' };

/**
 * Close what the role owns, and stop waiting when the budget is spent.
 *
 * Waiting forever is not the safe option it looks like: the supervisor's kill
 * timeout is derived from this budget, so a close that hangs past it turns an
 * orderly shutdown into a SIGKILL — which is the one ending that runs no
 * cleanup at all. Better to leave one connection to the operating system and
 * exit, saying which.
 *
 * The steps run in order and share one deadline, because they are one budget:
 * a slow first close must not hand the second one a full budget of its own.
 *
 * The two ways a step can end are kept apart. Running out of time and throwing
 * are different facts about a shutdown — one says a resource is still held, the
 * other says closing it is broken — and collapsing them (this used to discard
 * the rejection entirely) turned a failed shutdown into a clean exit with the
 * reason gone.
 *
 * The clock is `performance.now()` and cannot be replaced. It used to be
 * `Date.now()` behind an injectable parameter, and both halves of that were
 * wrong for a deadline: a wall clock stepped backwards widens the very upper
 * bound a supervisor's kill timeout was derived from, and an injected clock
 * that does not advance hands every step a full budget — a shutdown budget that
 * a test could switch off. Nothing needs to fake it: the regression that
 * matters runs a real process.
 */
export async function closeWithinBudget(
  steps: readonly CleanupStep[],
  budgetMs: number = CLEANUP_BUDGET_MS,
): Promise<CleanupResult> {
  const now = (): number => performance.now();
  const startedAt = now();
  const unfinished: string[] = [];
  const failed: CleanupFailure[] = [];
  const finished = (): StepOutcome => ({ kind: 'finished' });
  const threw = (cause: unknown): StepOutcome => ({ kind: 'threw', cause });
  for (const step of steps) {
    const remaining = budgetMs - (now() - startedAt);
    if (remaining <= 0) {
      unfinished.push(step.name);
      continue;
    }
    let timer: ReturnType<typeof setTimeout> | undefined;
    const outcome = await Promise.race<StepOutcome>([
      step.close().then(finished, threw),
      new Promise<StepOutcome>((resolve) => {
        timer = setTimeout(() => resolve({ kind: 'expired' }), remaining);
      }),
    ]);
    if (timer !== undefined) clearTimeout(timer);
    if (outcome.kind === 'expired') unfinished.push(step.name);
    else if (outcome.kind === 'threw') failed.push({ name: step.name, cause: outcome.cause });
  }
  return { unfinished, failed, durationMs: Math.round(now() - startedAt) };
}

/**
 * Turn a bounded cleanup into an ending: say what happened, and make sure it
 * actually ends.
 *
 * `process.exitCode` only decides the code the process reports *when it exits*.
 * A step that ran out of time may still be holding a handle — that is what
 * running out of time usually means — and a process holding one waits for the
 * event loop to drain, which is precisely the wait the supervisor answers with
 * SIGKILL. So an unfinished step is not a note to log on the way out; it is the
 * reason to leave now.
 *
 * `exit` is a parameter so this decision can be exercised without ending the
 * test runner — but the regression that matters runs a real process
 * (`scripts/shutdown-budget.fixture.ts`), because "the promise resolved" was
 * never the property in question.
 */
export function concludeShutdown(
  result: CleanupResult,
  drainWasClean: boolean,
  exit: (code: number) => void = (code) => process.exit(code),
): void {
  for (const failure of result.failed) {
    console.error(`Shutdown could not close ${failure.name}:`, failure.cause);
  }
  if (result.unfinished.length > 0) {
    console.error(
      `Shutdown left ${result.unfinished.join(' and ')} unclosed after ${result.durationMs}ms — the cleanup budget is spent, exiting anyway.`,
    );
  }
  const cleanupCompleted = result.unfinished.length === 0 && result.failed.length === 0;
  const code = drainWasClean && cleanupCompleted ? 0 : 1;
  process.exitCode = code;
  // A cleanup that did not complete does not get to wait. Either a step ran out
  // of time — so something is still held — or closing it threw, which says the
  // same thing with less certainty about what. A shutdown that completed exits
  // on its own, and letting it do so keeps the ordinary path ordinary.
  // Last on purpose: nothing after this line runs.
  if (!cleanupCompleted) exit(code);
}
