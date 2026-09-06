import { z } from 'zod';
import { defineManagedResource, type ManagedResource } from './resource';
import type { StateStore } from './state-store';

/**
 * How a run ended. `clean` and `forced` are recorded by the run itself;
 * `hot-reload` and `abnormal` are recorded by its successor, because the run
 * never got to say — the same pid started again, or a different pid found it
 * still marked active. `abnormal` is a crash observed from outside, not a kill
 * the process acknowledged, so the two stay distinct in the ledger.
 */
export const LifecycleTerminationSchema = z.enum([
  'active',
  'clean',
  'forced',
  'hot-reload',
  'abnormal',
]);
export type LifecycleTermination = z.infer<typeof LifecycleTerminationSchema>;

export const LifecycleRunSchema = z
  .object({
    runId: z.string().min(1).max(128),
    pid: z.number().int().positive(),
    version: z.string().min(1).max(256),
    startedAt: z.string().datetime({ offset: true }),
    readyAt: z.string().datetime({ offset: true }).nullable(),
    stoppedAt: z.string().datetime({ offset: true }).nullable(),
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
  readonly downtimeMs: number | null;
}

export interface ReadyFact {
  readonly type: 'ready';
  readonly runId: string;
  readonly pid: number;
  readonly readyAt: string;
  readonly startupMs: number;
  /** False when this exact ready transition was already recorded. */
  readonly recorded: boolean;
}

export interface ShutdownFact {
  readonly type: 'stopped';
  readonly runId: string;
  readonly pid: number;
  readonly stoppedAt: string;
  readonly uptimeMs: number | null;
  readonly termination: 'clean' | 'forced';
  readonly recorded: boolean;
}

export type ProcessLifecycleFact = StartFact | ReadyFact | ShutdownFact;

export interface LifecycleTransition<TFact extends ProcessLifecycleFact> {
  readonly state: LifecycleState;
  readonly fact: TFact;
}

const emptyState = (): LifecycleState => ({ schemaVersion: 1, runs: [] });
const epoch = (value: string): number => Date.parse(value);
const elapsed = (later: string, earlier: string): number =>
  Math.max(0, epoch(later) - epoch(earlier));
/**
 * The list is newest-first in the order the transitions wrote it — every write
 * goes through one atomic update, so that order is the causal one. Clocks are
 * not: a successor whose clock lags its predecessor must still find that
 * predecessor at the head, so the list is never re-sorted by `startedAt`.
 * Retention drops finished runs first; an active run — a live handoff
 * predecessor — is dropped only when nothing finished is left to drop.
 */
function normalize(state: LifecycleState | null, retain: number): LifecycleState {
  const parsed = LifecycleStateSchema.parse(state ?? emptyState());
  const runs = [...parsed.runs];
  for (let index = runs.length - 1; runs.length > retain && index >= 0; index -= 1) {
    if (runs[index]?.termination !== 'active') runs.splice(index, 1);
  }
  return { schemaVersion: 1, runs: runs.slice(0, retain) };
}

/**
 * What a start means when the newest run is still marked active under another
 * pid **and the same version**. `abnormal` (default): the predecessor crashed
 * without recording its exit — one process per deployment, a restart after a
 * kill. `handoff`: two processes of one build overlap on purpose (a cluster, a
 * zero-downtime reload of the same build), so the predecessor stays active and
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

/** Apply one process start without touching persistence or application events. */
export function transitionProcessStart(
  source: LifecycleState | null,
  input: TransitionStartInput,
): LifecycleTransition<StartFact> {
  const retain = z
    .number()
    .int()
    .min(1)
    .max(1_000)
    .parse(input.retain ?? 20);
  const state = normalize(source, 1_000);
  const run = LifecycleRunSchema.parse({
    runId: input.runId,
    pid: input.pid,
    version: input.version,
    startedAt: input.now,
    readyAt: null,
    stoppedAt: null,
    termination: 'active',
  });
  if (state.runs.some((candidate) => candidate.runId === run.runId)) {
    throw new Error(`[stitchkit] lifecycle run id already exists: ${run.runId}`);
  }

  const previous = state.runs[0] ?? null;
  let previousExit: PreviousExit = 'first-boot';
  let downtimeMs: number | null = null;
  if (previous?.stoppedAt) {
    previousExit =
      previous.termination === 'forced' ||
      previous.termination === 'abnormal' ||
      previous.termination === 'hot-reload'
        ? previous.termination
        : 'clean';
    downtimeMs = elapsed(run.startedAt, previous.stoppedAt);
  } else if (previous) {
    if (previous.pid === run.pid) previousExit = 'hot-reload';
    else if (isVersionChange(previous.version, run.version)) previousExit = 'handoff';
    else previousExit = input.sameVersionOverlap ?? 'abnormal';
  }

  const runs = state.runs.map((candidate): LifecycleRun => {
    if (candidate.runId !== previous?.runId || candidate.termination !== 'active')
      return candidate;
    if (previousExit === 'hot-reload') {
      return { ...candidate, stoppedAt: run.startedAt, termination: 'hot-reload' };
    }
    if (previousExit === 'abnormal') {
      // The crash time is unknown; the successor's start is the upper bound.
      return { ...candidate, stoppedAt: run.startedAt, termination: 'abnormal' };
    }
    return candidate;
  });
  const next = normalize({ schemaVersion: 1, runs: [run, ...runs] }, retain);
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
      downtimeMs,
    },
  };
}

export interface TransitionReadyInput {
  readonly runId: string;
  readonly pid: number;
  readonly now: string;
  readonly retain?: number;
}

export function transitionProcessReady(
  source: LifecycleState | null,
  input: TransitionReadyInput,
): LifecycleTransition<ReadyFact> {
  const retain = input.retain ?? 20;
  const state = normalize(source, retain);
  const target = state.runs.find(
    (run) =>
      run.runId === input.runId && run.pid === input.pid && run.termination === 'active',
  );
  if (!target) {
    return {
      state,
      fact: {
        type: 'ready',
        runId: input.runId,
        pid: input.pid,
        readyAt: input.now,
        startupMs: 0,
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
      recorded: target.readyAt === null,
    },
  };
}

export interface TransitionShutdownInput {
  readonly runId: string;
  readonly pid: number;
  readonly now: string;
  readonly forced?: boolean;
  readonly retain?: number;
}

export function transitionProcessShutdown(
  source: LifecycleState | null,
  input: TransitionShutdownInput,
): LifecycleTransition<ShutdownFact> {
  const state = normalize(source, input.retain ?? 20);
  const target = state.runs.find(
    (run) =>
      run.runId === input.runId && run.pid === input.pid && run.termination === 'active',
  );
  const termination = input.forced ? 'forced' : 'clean';
  if (!target) {
    return {
      state,
      fact: {
        type: 'stopped',
        runId: input.runId,
        pid: input.pid,
        stoppedAt: input.now,
        uptimeMs: null,
        termination,
        recorded: false,
      },
    };
  }
  return {
    state: {
      schemaVersion: 1,
      runs: state.runs.map((run) =>
        run.runId === target.runId ? { ...run, stoppedAt: input.now, termination } : run,
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

export interface ProcessLifecycleLedger {
  recordStart(input: { readonly version: string }): Promise<StartFact>;
  recordReady(): Promise<ReadyFact>;
  recordShutdown(input?: { readonly forced?: boolean }): Promise<ShutdownFact>;
  current(): Promise<LifecycleRun | null>;
  runs(): Promise<readonly LifecycleRun[]>;
  subscribe(listener: (fact: ProcessLifecycleFact) => void | Promise<void>): () => void;
}

export interface ProcessLifecycleLedgerConfig {
  readonly store: StateStore<LifecycleState>;
  readonly clock?: () => Date;
  readonly pid?: number;
  readonly retain?: number;
  readonly runId?: string | (() => string);
  readonly sameVersionOverlap?: SameVersionOverlap;
  readonly onSubscriberError?: (
    error: unknown,
    fact: ProcessLifecycleFact,
  ) => void | Promise<void>;
}

export function createProcessLifecycleLedger(
  config: ProcessLifecycleLedgerConfig,
): ProcessLifecycleLedger {
  const clock = config.clock ?? (() => new Date());
  const pid = z
    .number()
    .int()
    .positive()
    .parse(config.pid ?? process.pid);
  const retain = z
    .number()
    .int()
    .min(1)
    .max(1_000)
    .parse(config.retain ?? 20);
  const configuredRunId = config.runId;
  const nextRunId =
    typeof configuredRunId === 'function'
      ? configuredRunId
      : configuredRunId === undefined
        ? () => crypto.randomUUID()
        : () => configuredRunId;
  let runId = nextRunId();
  let started = false;
  const listeners = new Set<(fact: ProcessLifecycleFact) => void | Promise<void>>();

  const publish = (fact: ProcessLifecycleFact): void => {
    for (const listener of listeners) {
      Promise.resolve()
        .then(() => listener(fact))
        .catch((error) => config.onSubscriberError?.(error, fact));
    }
  };

  return {
    async recordStart({ version }) {
      if (started) runId = nextRunId();
      const fact = await config.store.update((state) => {
        const transition = transitionProcessStart(state, {
          runId,
          pid,
          version,
          now: clock().toISOString(),
          retain,
          sameVersionOverlap: config.sameVersionOverlap,
        });
        return { state: transition.state, result: transition.fact };
      });
      started = true;
      publish(fact);
      return fact;
    },
    async recordReady() {
      const fact = await config.store.update((state) => {
        const transition = transitionProcessReady(state, {
          runId,
          pid,
          now: clock().toISOString(),
          retain,
        });
        return { state: transition.state, result: transition.fact };
      });
      if (fact.recorded) publish(fact);
      return fact;
    },
    async recordShutdown(input) {
      const fact = await config.store.update((state) => {
        const transition = transitionProcessShutdown(state, {
          runId,
          pid,
          now: clock().toISOString(),
          forced: input?.forced,
          retain,
        });
        return { state: transition.state, result: transition.fact };
      });
      if (fact.recorded) publish(fact);
      return fact;
    },
    async current() {
      const state = normalize(await config.store.read(), retain);
      return state.runs.find((run) => run.runId === runId && run.pid === pid) ?? null;
    },
    async runs() {
      return normalize(await config.store.read(), retain).runs;
    },
    subscribe(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
  };
}

export interface LifecycleLedgerResourceConfig {
  readonly id?: string;
  readonly version: string;
}

export interface LifecycleLedgerResource extends ManagedResource {
  start(): Promise<{ readonly value: ProcessLifecycleLedger }>;
}

export function lifecycleLedgerResource(
  ledger: ProcessLifecycleLedger,
  config: LifecycleLedgerResourceConfig,
): LifecycleLedgerResource {
  let stopped = false;
  let shutdown: Promise<ShutdownFact> | undefined;
  const stop = async (forced: boolean): Promise<void> => {
    if (stopped) return;
    if (!shutdown) shutdown = ledger.recordShutdown({ forced });
    try {
      await shutdown;
      stopped = true;
    } finally {
      if (!stopped) shutdown = undefined;
    }
  };
  return defineManagedResource({
    id: config.id ?? 'lifecycle',
    async start() {
      // A restart re-enters `start` on the same resource: the previous run's
      // settled shutdown must not answer for the new run's.
      stopped = false;
      shutdown = undefined;
      await ledger.recordStart({ version: config.version });
      return { value: ledger };
    },
    async activate() {
      await ledger.recordReady();
    },
    async close() {
      await stop(false);
    },
    async force() {
      await stop(true);
    },
  });
}
