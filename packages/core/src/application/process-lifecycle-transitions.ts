import { z } from 'zod';

/**
 * Where a run is. `active` and `draining` are open: the run is alive, and
 * `draining` means it has stopped admitting work — from `unavailableAt` on
 * nobody new is answered. The rest are how it ended. `clean`, `forced` and
 * `startup-failed` are recorded by the run itself; `hot-reload` and `abnormal`
 * by its successor, because the run never got to say — the same pid started
 * again, or a different pid found it still open. `abnormal` is a crash
 * observed from outside, not a kill the process acknowledged, so the two stay
 * distinct. `startup-failed` is a run that ended before it was ever ready,
 * whether it said so itself or a successor found it open.
 */
export const LifecycleTerminationSchema = z.enum([
  'active',
  'draining',
  'clean',
  'forced',
  'startup-failed',
  'hot-reload',
  'abnormal',
]);
export type LifecycleTermination = z.infer<typeof LifecycleTerminationSchema>;

const timestamp = z.string().datetime({ offset: true });

export const LifecycleRunSchema = z
  .object({
    runId: z.string().min(1).max(128),
    pid: z.number().int().positive(),
    version: z.string().min(1).max(256),
    startedAt: timestamp,
    readyAt: timestamp.nullable(),
    /**
     * When the run stopped answering: its admission stopped, or — for a run
     * that recorded its own stop without draining — that stop. Null while it
     * answers, for a run that never did, and for a crash nobody timed.
     * Optional on read so a ledger written before the field still loads.
     */
    unavailableAt: timestamp.nullable().default(null),
    stoppedAt: timestamp.nullable(),
    termination: LifecycleTerminationSchema,
  })
  .strict();
export type LifecycleRun = z.infer<typeof LifecycleRunSchema>;

export const LifecycleStateSchema = z
  .object({
    schemaVersion: z.literal(1),
    runs: z.array(LifecycleRunSchema),
  })
  .strict();
export type LifecycleState = z.infer<typeof LifecycleStateSchema>;

export const PreviousExitSchema = z.enum([
  'first-boot',
  'hot-reload',
  'clean',
  'forced',
  'startup-failed',
  'handoff',
  'abnormal',
]);
export type PreviousExit = z.infer<typeof PreviousExitSchema>;

export interface StartFact {
  readonly type: 'started';
  readonly runId: string;
  readonly pid: number;
  readonly version: string;
  readonly startedAt: string;
  readonly previousExit: PreviousExit;
  readonly previousRunId: string | null;
  readonly previousPid: number | null;
  readonly previousVersion: string | null;
  readonly versionChanged: boolean;
  /**
   * From the predecessor's recorded stop to this start: the gap between two
   * processes, not the time nobody answered — that is `ReadyFact.downtimeMs`.
   */
  readonly processGapMs: number | null;
}

export interface ReadyFact {
  readonly type: 'ready';
  readonly runId: string;
  readonly pid: number;
  readonly readyAt: string;
  readonly startupMs: number;
  /**
   * The window in which nobody answered: from the moment the last run that
   * served stopped admitting work to this run's readiness — its drain plus
   * this start. Zero when that run still answers (a handoff); null on first
   * boot and when its end was never timed (a crash, a hot reload).
   */
  readonly downtimeMs: number | null;
  /** The moment `downtimeMs` is counted from, when it is known. */
  readonly unavailableSince: string | null;
  /** False when this exact ready transition was already recorded. */
  readonly recorded: boolean;
}

export interface DrainingFact {
  readonly type: 'draining';
  readonly runId: string;
  readonly pid: number;
  /** Null for a run that never became ready: it was never available. */
  readonly unavailableAt: string | null;
  readonly recorded: boolean;
}

export interface ShutdownFact {
  readonly type: 'stopped';
  readonly runId: string;
  readonly pid: number;
  readonly stoppedAt: string;
  readonly uptimeMs: number | null;
  readonly termination: 'clean' | 'forced' | 'startup-failed';
  readonly recorded: boolean;
}

export type ProcessLifecycleFact = StartFact | ReadyFact | DrainingFact | ShutdownFact;

export interface LifecycleTransition<TFact extends ProcessLifecycleFact> {
  readonly state: LifecycleState;
  readonly fact: TFact;
}

const emptyState = (): LifecycleState => ({ schemaVersion: 1, runs: [] });
const epoch = (value: string): number => Date.parse(value);
const elapsed = (later: string, earlier: string): number =>
  Math.max(0, epoch(later) - epoch(earlier));

export const isOpenRun = (run: LifecycleRun): boolean =>
  run.termination === 'active' || run.termination === 'draining';

/**
 * The list is newest-first in the order the transitions wrote it — every write
 * goes through one atomic update, so that order is the causal one. Clocks are
 * not: a successor whose clock lags its predecessor must still find that
 * predecessor at the head, so the list is never re-sorted by `startedAt`.
 * Retention drops finished runs first; an open run — a live handoff
 * predecessor — is dropped only when nothing finished is left to drop.
 */
export function normalizeLifecycleState(
  state: LifecycleState | null,
  retain: number,
): LifecycleState {
  const parsed = LifecycleStateSchema.parse(state ?? emptyState());
  const runs = [...parsed.runs];
  for (let index = runs.length - 1; runs.length > retain && index >= 0; index -= 1) {
    const run = runs[index];
    if (run && !isOpenRun(run)) runs.splice(index, 1);
  }
  return { schemaVersion: 1, runs: runs.slice(0, retain) };
}

/**
 * What a start means when the newest run is still open under another pid
 * **and the same version**. `abnormal` (default): the predecessor crashed
 * without recording its exit — one process per deployment, a restart after a
 * kill. `handoff`: processes of one build overlap on purpose (a cluster, a
 * zero-downtime reload of the same build), so every open run stays open and
 * records its own shutdown later. A different version is always a handoff; a
 * version of `unknown` on either side is never a version change.
 */
export type SameVersionOverlap = 'abnormal' | 'handoff';

export interface TransitionStartInput {
  readonly runId: string;
  readonly pid: number;
  readonly version: string;
  readonly now: string;
  readonly retain?: number;
  readonly sameVersionOverlap?: SameVersionOverlap;
}

const UNKNOWN_VERSION = 'unknown';

function isVersionChange(previous: string, next: string): boolean {
  return previous !== UNKNOWN_VERSION && next !== UNKNOWN_VERSION && previous !== next;
}

const RetainSchema = z.number().int().min(1).max(1_000);

function previousExitOf(
  previous: LifecycleRun | null,
  run: LifecycleRun,
  overlap: SameVersionOverlap,
): PreviousExit {
  if (!previous) return 'first-boot';
  const ended = previous.termination;
  if (ended !== 'active' && ended !== 'draining') return ended;
  if (previous.pid === run.pid) return 'hot-reload';
  if (isVersionChange(previous.version, run.version) || overlap === 'handoff')
    return 'handoff';
  return previous.readyAt === null ? 'startup-failed' : 'abnormal';
}

/**
 * How a start closes the open runs it finds. The same pid is always a hot
 * reload. Otherwise a run stays open only when it may still be answering: the
 * newest one in a handoff, or any one where overlap was declared. Every other
 * open run was abandoned — not only the newest: two crashes in a row leave two.
 */
function closeAbandoned(
  candidate: LifecycleRun,
  previous: LifecycleRun | null,
  previousExit: PreviousExit,
  run: LifecycleRun,
  overlap: SameVersionOverlap,
): LifecycleRun {
  if (!isOpenRun(candidate)) return candidate;
  // The crash time is unknown; the successor's start is the upper bound.
  const closed = { ...candidate, stoppedAt: run.startedAt };
  if (candidate.pid === run.pid) return { ...closed, termination: 'hot-reload' };
  if (overlap === 'handoff') return candidate;
  if (candidate.runId === previous?.runId && previousExit === 'handoff') return candidate;
  return {
    ...closed,
    termination: candidate.readyAt === null ? 'startup-failed' : 'abnormal',
  };
}

/** Apply one process start without touching persistence or application events. */
export function transitionProcessStart(
  source: LifecycleState | null,
  input: TransitionStartInput,
): LifecycleTransition<StartFact> {
  const retain = RetainSchema.parse(input.retain ?? 20);
  const overlap = input.sameVersionOverlap ?? 'abnormal';
  const state = normalizeLifecycleState(source, 1_000);
  const run = LifecycleRunSchema.parse({
    runId: input.runId,
    pid: input.pid,
    version: input.version,
    startedAt: input.now,
    readyAt: null,
    unavailableAt: null,
    stoppedAt: null,
    termination: 'active',
  });
  if (state.runs.some((candidate) => candidate.runId === run.runId)) {
    throw new Error(`[stitchkit] lifecycle run id already exists: ${run.runId}`);
  }

  const previous = state.runs[0] ?? null;
  const previousExit = previousExitOf(previous, run, overlap);
  const processGapMs =
    previous && !isOpenRun(previous) && previous.stoppedAt
      ? elapsed(run.startedAt, previous.stoppedAt)
      : null;
  const runs = state.runs.map((candidate) =>
    closeAbandoned(candidate, previous, previousExit, run, overlap),
  );
  const next = normalizeLifecycleState({ schemaVersion: 1, runs: [run, ...runs] }, retain);
  return {
    state: next,
    fact: {
      type: 'started',
      runId: run.runId,
      pid: run.pid,
      version: run.version,
      startedAt: run.startedAt,
      previousExit,
      previousRunId: previous?.runId ?? null,
      previousPid: previous?.pid ?? null,
      previousVersion: previous?.version ?? null,
      versionChanged: previous !== null && isVersionChange(previous.version, run.version),
      processGapMs,
    },
  };
}

/** The run a transition applies to — owned by run id plus pid — and when. */
export interface TransitionRunInput {
  readonly runId: string;
  readonly pid: number;
  readonly now: string;
  readonly retain?: number;
}

function findOpen(state: LifecycleState, input: TransitionRunInput): LifecycleRun | undefined {
  return state.runs.find(
    (run) => run.runId === input.runId && run.pid === input.pid && isOpenRun(run),
  );
}

/**
 * Where the window nobody answered in began, seen from a run becoming ready.
 * Runs that never became ready answered nobody, so the walk passes them: after
 * a failed start the window still opens where the last serving run closed.
 */
function unavailability(
  state: LifecycleState,
  target: LifecycleRun,
  readyAt: string,
): Pick<ReadyFact, 'downtimeMs' | 'unavailableSince'> {
  const older = state.runs.slice(state.runs.indexOf(target) + 1);
  const served = older.find((run) => run.readyAt !== null);
  if (!served) return { downtimeMs: null, unavailableSince: null };
  if (served.unavailableAt !== null) {
    return {
      downtimeMs: elapsed(readyAt, served.unavailableAt),
      unavailableSince: served.unavailableAt,
    };
  }
  return isOpenRun(served)
    ? { downtimeMs: 0, unavailableSince: null }
    : { downtimeMs: null, unavailableSince: null };
}

export function transitionProcessReady(
  source: LifecycleState | null,
  input: TransitionRunInput,
): LifecycleTransition<ReadyFact> {
  const state = normalizeLifecycleState(source, input.retain ?? 20);
  const target = findOpen(state, input);
  if (target?.termination !== 'active') {
    return {
      state,
      fact: {
        type: 'ready',
        runId: input.runId,
        pid: input.pid,
        readyAt: input.now,
        startupMs: 0,
        downtimeMs: null,
        unavailableSince: null,
        recorded: false,
      },
    };
  }
  const readyAt = target.readyAt ?? input.now;
  return {
    state: {
      schemaVersion: 1,
      runs: state.runs.map((run) =>
        run.runId === target.runId && run.readyAt === null ? { ...run, readyAt } : run,
      ),
    },
    fact: {
      type: 'ready',
      runId: target.runId,
      pid: target.pid,
      readyAt,
      startupMs: elapsed(readyAt, target.startedAt),
      ...unavailability(state, target, readyAt),
      recorded: target.readyAt === null,
    },
  };
}

/** The run stopped admitting work: from here on it answers nobody new. */
export function transitionProcessDraining(
  source: LifecycleState | null,
  input: TransitionRunInput,
): LifecycleTransition<DrainingFact> {
  const state = normalizeLifecycleState(source, input.retain ?? 20);
  const target = findOpen(state, input);
  if (target?.termination !== 'active') {
    return {
      state,
      fact: {
        type: 'draining',
        runId: input.runId,
        pid: input.pid,
        unavailableAt: target ? target.unavailableAt : null,
        recorded: false,
      },
    };
  }
  // A run that never became ready was never available, so it has no moment
  // of becoming unavailable; it still enters the phase.
  const unavailableAt = target.readyAt === null ? null : input.now;
  return {
    state: {
      schemaVersion: 1,
      runs: state.runs.map((run) =>
        run.runId === target.runId ? { ...run, termination: 'draining', unavailableAt } : run,
      ),
    },
    fact: {
      type: 'draining',
      runId: target.runId,
      pid: target.pid,
      unavailableAt,
      recorded: true,
    },
  };
}

export interface TransitionShutdownInput extends TransitionRunInput {
  readonly forced?: boolean;
}

export function transitionProcessShutdown(
  source: LifecycleState | null,
  input: TransitionShutdownInput,
): LifecycleTransition<ShutdownFact> {
  const state = normalizeLifecycleState(source, input.retain ?? 20);
  const target = findOpen(state, input);
  const requested = input.forced ? 'forced' : 'clean';
  if (!target) {
    return {
      state,
      fact: {
        type: 'stopped',
        runId: input.runId,
        pid: input.pid,
        stoppedAt: input.now,
        uptimeMs: null,
        termination: requested,
        recorded: false,
      },
    };
  }
  const termination = target.readyAt === null ? 'startup-failed' : requested;
  // A run that served and stops without having drained stops answering now.
  const unavailableAt = target.unavailableAt ?? (target.readyAt === null ? null : input.now);
  return {
    state: {
      schemaVersion: 1,
      runs: state.runs.map((run) =>
        run.runId === target.runId
          ? { ...run, unavailableAt, stoppedAt: input.now, termination }
          : run,
      ),
    },
    fact: {
      type: 'stopped',
      runId: target.runId,
      pid: target.pid,
      stoppedAt: input.now,
      uptimeMs: elapsed(input.now, target.startedAt),
      termination,
      recorded: true,
    },
  };
}
