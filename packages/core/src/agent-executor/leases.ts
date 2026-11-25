import { z } from 'zod';
import { AppError } from '../contract/errors';
import { assertTimerMs } from '../internal/deadline';
import { assertPositiveSafeInteger } from '../internal/positive-integer';
import {
  EXECUTOR_ERRORS,
  type ThreadClaim,
  ThreadClaimSchema,
  type ThreadLease,
  ThreadReleaseSchema,
  ThreadRenewSchema,
  type TurnPhase,
  TurnPhaseSchema,
  type TurnReport,
  type TurnReportAck,
  TurnReportSchema,
} from './executor-contract';
import {
  type ExecutorResumableTurn,
  ExecutorResumableTurnSchema,
  type ExecutorResumeAck,
} from './hello';
import { canAdvanceTurnPhase } from './turn-phases';

/** The most turns a thread's receipts may be kept for: the ceiling of `retainedTurns`. */
export const MAX_RETAINED_TURNS = 1024;
/** How many of a thread's most recent turns keep their receipt, by default. */
const DEFAULT_RETAINED_TURNS = 64;

/**
 * The server's record of thread leases and turn receipts, as one value a
 * store updates atomically. Times are the server's monotonic clock in
 * milliseconds; nothing here reads a machine's wall clock. A thread keeps the
 * receipts of its `retainedTurns` most recent turns, in the order they were
 * first reported, and counts the ones it let go: the value is bounded by the
 * number of threads, never by the number of turns they ran.
 */
export const ExecutorLeaseStateSchema = z.strictObject({
  threads: z.record(
    z.string(),
    z.strictObject({
      executorId: z.string(),
      profileId: z.string(),
      instance: z.string(),
      fence: z.int().positive(),
      /** `null` once released. */
      expiresAtMs: z.number().nullable(),
      /** The turns whose receipts are kept, in the order they were first reported. */
      recentTurns: z.array(z.string()).max(MAX_RETAINED_TURNS),
      /**
       * The highest ordinal whose receipt was let go (0 — none): every kept turn is above it, and
       * a turn at or below it is one the server already took, never a new one.
       */
      forgottenThrough: z.int().nonnegative(),
    }),
  ),
  turns: z.record(
    z.string(),
    z.strictObject({
      threadId: z.string(),
      ordinal: z.int().positive(),
      fence: z.int().positive(),
      phase: TurnPhaseSchema,
      ackedSeq: z.int().nonnegative(),
    }),
  ),
});
/** Server-side thread lease and turn receipt state inferred from `ExecutorLeaseStateSchema`. */
export type ExecutorLeaseState = z.infer<typeof ExecutorLeaseStateSchema>;

export const EMPTY_EXECUTOR_LEASES: ExecutorLeaseState = { threads: {}, turns: {} };

/**
 * A lease or report refused by code: an `AppError` with status 409, so an
 * operation that returns the service's promise answers it on the wire as
 * `409 { error: { code } }` without a mapper of its own.
 */
export class ExecutorLeaseRefusal extends AppError<
  (typeof EXECUTOR_ERRORS)[keyof typeof EXECUTOR_ERRORS]
> {
  constructor(code: (typeof EXECUTOR_ERRORS)[keyof typeof EXECUTOR_ERRORS], message: string) {
    super(code, { message, status: 409 });
    this.name = 'ExecutorLeaseRefusal';
  }
}

/**
 * A lease TTL is a timer delay, not only an expiry instant: the executor renews on a timer at a
 * third of it and the grant's `ttlMs` (ThreadLeaseSchema) states the timer ceiling, so a server
 * that grants past it would answer with a lease its own contract refuses.
 */
function assertTtlMs(ttlMs: number): void {
  assertTimerMs('ttlMs', ttlMs, { absent: 'refused' });
}

/** A count of kept turns: a positive integer no larger than {@link MAX_RETAINED_TURNS}. */
function assertRetainedTurns(retainedTurns: number): void {
  assertPositiveSafeInteger('retainedTurns', retainedTurns, RangeError, { absent: 'refused' });
  if (retainedTurns > MAX_RETAINED_TURNS)
    throw new RangeError(
      `retainedTurns must be at most ${MAX_RETAINED_TURNS}, received ${retainedTurns}`,
    );
}

/**
 * Grant a thread. A thread is pinned to its first `executorId + profileId`:
 * another executor or profile is refused for good. Another instance of the
 * same pair gets it only once the holder released it or its lease ran out
 * on the server's clock — and then under a new fence, so everything the old
 * holder still sends is refused as stale.
 */
export function claimThread(
  state: ExecutorLeaseState,
  rawClaim: ThreadClaim,
  nowMs: number,
  ttlMs: number,
): { state: ExecutorLeaseState; lease: ThreadLease } {
  assertTtlMs(ttlMs);
  const claim = ThreadClaimSchema.parse(rawClaim);
  const held = state.threads[claim.threadId];
  if (held !== undefined) {
    if (held.executorId !== claim.executorId || held.profileId !== claim.profileId) {
      throw new ExecutorLeaseRefusal(
        EXECUTOR_ERRORS.threadLeased,
        `Thread ${claim.threadId} is pinned to another executor or profile`,
      );
    }
    const live = held.expiresAtMs !== null && held.expiresAtMs > nowMs;
    if (live && held.instance !== claim.instance) {
      throw new ExecutorLeaseRefusal(
        EXECUTOR_ERRORS.threadLeased,
        `Thread ${claim.threadId} is leased to another instance until it releases or expires`,
      );
    }
  }
  const fence =
    (held?.fence ?? 0) +
    (held?.instance === claim.instance && held.expiresAtMs !== null && held.expiresAtMs > nowMs
      ? 0
      : 1);
  const next = {
    executorId: claim.executorId,
    profileId: claim.profileId,
    instance: claim.instance,
    fence,
    expiresAtMs: nowMs + ttlMs,
    recentTurns: held?.recentTurns ?? [],
    forgottenThrough: held?.forgottenThrough ?? 0,
  };
  return {
    state: { ...state, threads: { ...state.threads, [claim.threadId]: next } },
    lease: { threadId: claim.threadId, fence, ttlMs },
  };
}

/** The thread's lease when it is live and held by this instance under this fence. */
function liveLease(
  state: ExecutorLeaseState,
  threadId: string,
  instance: string,
  fence: number,
  nowMs: number,
) {
  const held = state.threads[threadId];
  if (
    held === undefined ||
    held.fence !== fence ||
    held.instance !== instance ||
    held.expiresAtMs === null ||
    held.expiresAtMs <= nowMs
  )
    return undefined;
  return held;
}

function heldBy(
  state: ExecutorLeaseState,
  threadId: string,
  instance: string,
  fence: number,
  nowMs: number,
) {
  const held = liveLease(state, threadId, instance, fence, nowMs);
  if (held === undefined) {
    throw new ExecutorLeaseRefusal(
      EXECUTOR_ERRORS.fenceStale,
      `Fence ${fence} of thread ${threadId} is not the live lease`,
    );
  }
  return held;
}

export function renewThread(
  state: ExecutorLeaseState,
  raw: z.input<typeof ThreadRenewSchema>,
  nowMs: number,
  ttlMs: number,
): { state: ExecutorLeaseState; lease: ThreadLease } {
  assertTtlMs(ttlMs);
  const renew = ThreadRenewSchema.parse(raw);
  const held = heldBy(state, renew.threadId, renew.instance, renew.fence, nowMs);
  return {
    state: {
      ...state,
      threads: { ...state.threads, [renew.threadId]: { ...held, expiresAtMs: nowMs + ttlMs } },
    },
    lease: { threadId: renew.threadId, fence: renew.fence, ttlMs },
  };
}

export function releaseThread(
  state: ExecutorLeaseState,
  raw: z.input<typeof ThreadReleaseSchema>,
  nowMs: number,
): { state: ExecutorLeaseState; released: boolean } {
  const release = ThreadReleaseSchema.parse(raw);
  const held = liveLease(state, release.threadId, release.instance, release.fence, nowMs);
  if (held === undefined) return { state, released: false };
  return {
    state: {
      ...state,
      threads: { ...state.threads, [release.threadId]: { ...held, expiresAtMs: null } },
    },
    released: true,
  };
}

/**
 * Apply one report once. A report under a fence that is not the live lease is
 * refused; a report at or below the acknowledged `executorSeq` is a resend and
 * changes nothing; a phase that does not follow the turn's current one is
 * refused rather than written. A thread keeps its `retainedTurns` most recent
 * turns: a new turn lets the one with the lowest ordinal go and raises the
 * thread's mark to it. A report of a turn at or below the mark that holds no
 * receipt — a resend of a turn the server already took, its first report
 * included — is `not-retained`, never applied again.
 */
export function applyTurnReport(
  state: ExecutorLeaseState,
  rawReport: TurnReport,
  nowMs: number,
  retainedTurns: number = DEFAULT_RETAINED_TURNS,
): { state: ExecutorLeaseState; ack: TurnReportAck } {
  assertRetainedTurns(retainedTurns);
  const report = TurnReportSchema.parse(rawReport);
  const thread = heldBy(state, report.threadId, report.instance, report.fence, nowMs);
  const turn = state.turns[report.turnId];
  if (turn !== undefined && turn.threadId !== report.threadId) {
    throw new ExecutorLeaseRefusal(
      EXECUTOR_ERRORS.unknownTurn,
      `Turn ${report.turnId} belongs to another thread`,
    );
  }
  if (turn !== undefined && turn.ordinal !== report.turnOrdinal) {
    throw new ExecutorLeaseRefusal(
      EXECUTOR_ERRORS.unknownTurn,
      `Turn ${report.turnId} was offered as turn ${turn.ordinal}, not ${report.turnOrdinal}`,
    );
  }
  if (turn === undefined && report.turnOrdinal <= thread.forgottenThrough) {
    return { state, ack: { outcome: 'not-retained' } };
  }
  if (turn !== undefined && report.executorSeq <= turn.ackedSeq) {
    return { state, ack: { outcome: 'duplicate', ackedSeq: turn.ackedSeq } };
  }
  const from: TurnPhase = turn?.phase ?? 'leased';
  if (!canAdvanceTurnPhase(from, report.phase)) {
    throw new ExecutorLeaseRefusal(
      EXECUTOR_ERRORS.invalidPhase,
      `Turn ${report.turnId} cannot move from ${from} to ${report.phase}`,
    );
  }
  const turns = {
    ...state.turns,
    [report.turnId]: {
      threadId: report.threadId,
      ordinal: report.turnOrdinal,
      fence: report.fence,
      phase: report.phase,
      ackedSeq: report.executorSeq,
    },
  };
  let { recentTurns, forgottenThrough } = thread;
  if (turn === undefined) {
    recentTurns = [...recentTurns, report.turnId];
    while (recentTurns.length > retainedTurns) {
      // The turn the thread was offered first goes, so every kept turn stays above the mark.
      const oldest = lowestOrdinal(recentTurns, turns);
      forgottenThrough = Math.max(forgottenThrough, turns[oldest]?.ordinal ?? 0);
      delete turns[oldest];
      recentTurns = recentTurns.filter((turnId) => turnId !== oldest);
    }
  }
  return {
    state: {
      threads: {
        ...state.threads,
        [report.threadId]: { ...thread, recentTurns, forgottenThrough },
      },
      turns,
    },
    ack: { outcome: 'applied', ackedSeq: report.executorSeq },
  };
}

/** The kept turn the thread was offered first. */
function lowestOrdinal(
  recentTurns: readonly string[],
  turns: ExecutorLeaseState['turns'],
): string {
  let lowest = recentTurns[0] ?? '';
  for (const turnId of recentTurns)
    if ((turns[turnId]?.ordinal ?? 0) < (turns[lowest]?.ordinal ?? 0)) lowest = turnId;
  return lowest;
}

/**
 * What the server holds of each turn an executor resumes, for its hello: `acked` up to the
 * receipt's `ackedSeq` (0 for a turn it never saw), or `not-retained` for a turn at or below its
 * thread's mark — the executor resends nothing of it.
 */
export function resumeTurns(
  state: ExecutorLeaseState,
  rawResumable: readonly ExecutorResumableTurn[],
): ExecutorResumeAck[] {
  return rawResumable.map((raw) => {
    const resumable = ExecutorResumableTurnSchema.parse(raw);
    const turn = state.turns[resumable.turnId];
    if (turn !== undefined && turn.threadId === resumable.threadId)
      return { outcome: 'acked', turnId: resumable.turnId, ackedSeq: turn.ackedSeq };
    const forgottenThrough = state.threads[resumable.threadId]?.forgottenThrough ?? 0;
    if (resumable.turnOrdinal <= forgottenThrough)
      return { outcome: 'not-retained', turnId: resumable.turnId };
    return { outcome: 'acked', turnId: resumable.turnId, ackedSeq: 0 };
  });
}

/**
 * The one method a store needs: update the value atomically, `null` before
 * the first write. A `StateStore<ExecutorLeaseState>` of
 * `stitchkit/application` — a file or a database row — fits as it is.
 */
export interface ExecutorLeaseStateStore {
  update<T>(
    transition: (
      current: ExecutorLeaseState | null,
    ) =>
      | { state: ExecutorLeaseState; result: T }
      | Promise<{ state: ExecutorLeaseState; result: T }>,
  ): Promise<T>;
}

/** A process-local store, for tests and a single-process server. */
export function memoryExecutorLeaseStore(): ExecutorLeaseStateStore & {
  snapshot(): ExecutorLeaseState;
} {
  let current: ExecutorLeaseState | null = null;
  let tail: Promise<unknown> = Promise.resolve();
  return {
    snapshot: () => current ?? EMPTY_EXECUTOR_LEASES,
    update(transition) {
      const next = tail.then(async () => {
        const { state, result } = await transition(current);
        current = ExecutorLeaseStateSchema.parse(state);
        return result;
      });
      tail = next.catch(() => undefined);
      return next;
    },
  };
}

/**
 * The server's side of the lease operations over a store: what a
 * `defineAgentExecutorContract` implementation calls. `now` is a monotonic
 * clock in milliseconds — `performance.now()` plus the process's start, not
 * `Date.now()` — so a changed wall clock never extends or ends a lease.
 */
export function createExecutorLeases(input: {
  store: ExecutorLeaseStateStore;
  now: () => number;
  ttlMs: number;
  /**
   * How many of each thread's most recent turns keep their receipt, so a resent report is
   * answered `duplicate`; an older turn's report is `not-retained`. Default 64, at most
   * {@link MAX_RETAINED_TURNS}.
   */
  retainedTurns?: number;
}) {
  const { store, now, ttlMs } = input;
  const retainedTurns = input.retainedTurns ?? DEFAULT_RETAINED_TURNS;
  assertTtlMs(ttlMs);
  assertRetainedTurns(retainedTurns);
  const run = <T>(
    fn: (state: ExecutorLeaseState) => { state: ExecutorLeaseState; result: T },
  ) => store.update((current) => fn(current ?? EMPTY_EXECUTOR_LEASES));
  return {
    claim: (claim: ThreadClaim) =>
      run((state) => {
        const next = claimThread(state, claim, now(), ttlMs);
        return { state: next.state, result: next.lease };
      }),
    renew: (renew: z.input<typeof ThreadRenewSchema>) =>
      run((state) => {
        const next = renewThread(state, renew, now(), ttlMs);
        return { state: next.state, result: next.lease };
      }),
    release: (release: z.input<typeof ThreadReleaseSchema>) =>
      run((state) => {
        const next = releaseThread(state, release, now());
        return { state: next.state, result: { released: next.released } };
      }),
    /** What the server holds of the turns a hello resumes; reads, never writes. */
    resume: (resumable: readonly ExecutorResumableTurn[]) =>
      run((state) => ({ state, result: resumeTurns(state, resumable) })),
    report: (report: TurnReport) =>
      run((state) => {
        const next = applyTurnReport(state, report, now(), retainedTurns);
        return { state: next.state, result: next.ack };
      }),
  };
}
