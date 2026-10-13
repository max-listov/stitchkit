import { z } from 'zod';
import type { ManagedResource, ManagedResourceContext } from './resource';
import { ApplicationIdSchema } from './schemas';

const NonNegativeSafeIntegerSchema = z
  .number()
  .int()
  .nonnegative()
  .refine(Number.isSafeInteger, 'Expected a safe integer');
const PositiveSafeIntegerSchema = NonNegativeSafeIntegerSchema.refine(
  (value) => value > 0,
  'Expected a positive integer',
);

export const ManagedScheduleOverlapSchema = z.discriminatedUnion('mode', [
  z.object({ mode: z.literal('skip') }).readonly(),
  z.object({ mode: z.literal('queue-one') }).readonly(),
  z
    .object({
      mode: z.literal('parallel'),
      maxConcurrent: PositiveSafeIntegerSchema,
    })
    .readonly(),
]);
export type ManagedScheduleOverlap = z.infer<typeof ManagedScheduleOverlapSchema>;

export const ManagedScheduleErrorPolicySchema = z.enum(['continue', 'stop-schedule']);
export type ManagedScheduleErrorPolicy = z.infer<typeof ManagedScheduleErrorPolicySchema>;

const ManagedScheduleTriggerSchema = z.enum(['timer', 'wake']);
/** What started a run: the period elapsing, or the owner's `wake()`. */
export type ManagedScheduleTrigger = z.infer<typeof ManagedScheduleTriggerSchema>;

export const ManagedScheduleDescriptorSchema = z
  .object({
    id: ApplicationIdSchema,
    everyMs: PositiveSafeIntegerSchema,
    startAfterMs: NonNegativeSafeIntegerSchema,
    overlap: ManagedScheduleOverlapSchema,
    errorPolicy: ManagedScheduleErrorPolicySchema,
  })
  .readonly();
export type ManagedScheduleDescriptor = z.infer<typeof ManagedScheduleDescriptorSchema>;

export const ManagedScheduleStatusSchema = z
  .object({
    descriptor: ManagedScheduleDescriptorSchema,
    state: z.enum(['inactive', 'scheduled', 'running', 'draining', 'stopped']),
    revision: NonNegativeSafeIntegerSchema,
    capturedAt: z.string().datetime({ offset: true }),
    changedAt: z.string().datetime({ offset: true }),
    accepting: z.boolean(),
    active: NonNegativeSafeIntegerSchema,
    queued: z.boolean(),
    runsStarted: NonNegativeSafeIntegerSchema,
    runsCompleted: NonNegativeSafeIntegerSchema,
    runsFailed: NonNegativeSafeIntegerSchema,
    runsWoken: NonNegativeSafeIntegerSchema,
    ticksSkipped: NonNegativeSafeIntegerSchema,
    wakesCoalesced: NonNegativeSafeIntegerSchema,
    lastTrigger: ManagedScheduleTriggerSchema.nullable(),
    nextRunAt: z.string().datetime({ offset: true }).nullable(),
    lastScheduledAt: z.string().datetime({ offset: true }).nullable(),
    lastStartedAt: z.string().datetime({ offset: true }).nullable(),
    lastFinishedAt: z.string().datetime({ offset: true }).nullable(),
  })
  .readonly();
export type ManagedScheduleStatus = z.infer<typeof ManagedScheduleStatusSchema>;

export interface ManagedScheduleTimer {
  cancel(): void;
}

/** Monotonic timer boundary. Tests can replace it without changing schedule semantics. */
export interface ManagedScheduleClock {
  /** Monotonic clock used for cadence and deadline arithmetic. */
  now(): number;
  /** Wall clock used only to project portable status timestamps. */
  wallNow(): Date;
  schedule(callback: () => void, delayMs: number): ManagedScheduleTimer;
}

const systemClock: ManagedScheduleClock = {
  now: () => performance.now(),
  wallNow: () => new Date(),
  schedule(callback, delayMs) {
    const timer = setTimeout(callback, delayMs);
    return { cancel: () => clearTimeout(timer) };
  },
};

export interface ManagedScheduleRunContext {
  readonly applicationId: string;
  readonly signal: AbortSignal;
  readonly scheduledAt: number;
  readonly startedAt: number;
  readonly trigger: ManagedScheduleTrigger;
  now(): number;
}

export interface ManagedScheduleConfig {
  readonly id: string;
  readonly dependsOn?: readonly string[];
  readonly required?: boolean;
  readonly everyMs: number;
  /** Defaults to one interval. A zero value schedules the first run after activation. */
  readonly startAfterMs?: number;
  readonly overlap?: ManagedScheduleOverlap;
  readonly errorPolicy?: ManagedScheduleErrorPolicy;
  readonly run: (context: ManagedScheduleRunContext) => void | Promise<void>;
  readonly onError?: (
    error: unknown,
    context: ManagedScheduleRunContext,
  ) => void | Promise<void>;
  readonly clock?: ManagedScheduleClock;
}

export interface ManagedSchedule extends ManagedResource {
  readonly status: ManagedScheduleStatus;
  /**
   * Ask for one run now, because the owner knows work has appeared. The run takes the same path
   * as a timer run: `overlap`, `onError`, `errorPolicy` and the counters apply, and the period
   * keeps its own cadence as the check for an event that was lost. Calls made in one tick, or
   * while a run holds every slot, collapse into one following run. Before the schedule is
   * activated and after it stops accepting, the call does nothing and is not remembered.
   */
  wake(): void;
}

const DEFAULT_OVERLAP: ManagedScheduleOverlap = { mode: 'skip' };

/** Create one fixed-rate, process-local periodic application resource. */
interface ScheduleCounts {
  runsStarted: number;
  runsCompleted: number;
  runsFailed: number;
  runsWoken: number;
  ticksSkipped: number;
  wakesCoalesced: number;
  lastTrigger: ManagedScheduleTrigger | null;
  lastScheduledAt: string | null;
  lastStartedAt: string | null;
  lastFinishedAt: string | null;
}

function scheduleState(
  activated: boolean,
  stopped: boolean,
  accepting: boolean,
  active: number,
): ManagedScheduleStatus['state'] {
  if (!activated) return stopped ? 'stopped' : 'inactive';
  if (!accepting) return active > 0 ? 'draining' : 'stopped';
  return active > 0 ? 'running' : 'scheduled';
}

/** A monotonic instant on the wall clock, through one captured anchor. */
function wallAt(
  monotonicAt: number | null,
  anchor: { readonly monotonicNow: number; readonly wallNow: number },
): string | null {
  if (monotonicAt === null) return null;
  return new Date(anchor.wallNow + monotonicAt - anchor.monotonicNow).toISOString();
}

/** What a due tick does under the overlap policy, given how many runs are active. A wake that
 *  is not `start` waits for a free slot under every policy: it is an event, not a missed tick. */
function overlapDecision(
  overlap: ManagedScheduleOverlap,
  active: number,
): 'start' | 'queue' | 'skip' {
  if (overlap.mode === 'skip') return active > 0 ? 'skip' : 'start';
  if (overlap.mode === 'queue-one') return active > 0 ? 'queue' : 'start';
  return active >= overlap.maxConcurrent ? 'skip' : 'start';
}

function reportScheduleError(
  config: ManagedScheduleConfig,
  error: unknown,
  context: ManagedScheduleRunContext,
): void {
  if (!config.onError) return;
  void Promise.resolve()
    .then(() => config.onError?.(error, context))
    .catch(() => {
      // Error diagnostics cannot fail the schedule or create an unhandled rejection.
    });
}

/** Wait for the active runs to settle, or for the signal or the deadline first. */
async function waitForSettled(
  active: ReadonlySet<Promise<void>>,
  clock: ManagedScheduleClock,
  context: ManagedResourceContext,
  deadlineAt: number | undefined,
): Promise<void> {
  if (active.size === 0 || context.signal.aborted) return;
  await new Promise<void>((resolve) => {
    let settled = false;
    let deadlineTimer: ManagedScheduleTimer | null = null;
    const finish = (): void => {
      if (settled) return;
      settled = true;
      deadlineTimer?.cancel();
      context.signal.removeEventListener('abort', finish);
      resolve();
    };
    context.signal.addEventListener('abort', finish, { once: true });
    if (deadlineAt !== undefined) {
      deadlineTimer = clock.schedule(finish, Math.max(0, deadlineAt - context.now()));
    }
    void Promise.allSettled([...active]).then(finish);
  });
}

interface RunDeps {
  readonly config: ManagedScheduleConfig;
  readonly descriptor: ManagedScheduleDescriptor;
  readonly clock: ManagedScheduleClock;
  readonly counts: ScheduleCounts;
  readonly resourceContext: ManagedResourceContext;
  changed(): void;
  stopAdmission(): void;
  isAccepting(): boolean;
}

/**
 * One execution of the schedule's `run`, counted and timestamped, with its
 * outcome turned into health under the error policy. Never rejects.
 */
async function executeRun(
  deps: RunDeps,
  scheduledAt: number,
  trigger: ManagedScheduleTrigger,
): Promise<void> {
  const { config, descriptor, clock, counts, resourceContext } = deps;
  const startedAt = clock.now();
  const wallStartedAt = clock.wallNow().getTime();
  const runContext: ManagedScheduleRunContext = {
    applicationId: resourceContext.applicationId,
    signal: resourceContext.signal,
    scheduledAt,
    startedAt,
    trigger,
    now: () => clock.now(),
  };
  counts.runsStarted += 1;
  if (trigger === 'wake') counts.runsWoken += 1;
  counts.lastTrigger = trigger;
  counts.lastScheduledAt = new Date(wallStartedAt + scheduledAt - startedAt).toISOString();
  counts.lastStartedAt = new Date(wallStartedAt).toISOString();
  deps.changed();
  try {
    // A microtask first, as before: `run` never starts inside the tick that armed it.
    await Promise.resolve();
    await config.run(runContext);
  } catch (error) {
    counts.runsFailed += 1;
    counts.lastFinishedAt = clock.wallNow().toISOString();
    reportScheduleError(config, error, runContext);
    if (descriptor.errorPolicy === 'stop-schedule') {
      resourceContext.reportHealth('unhealthy');
      deps.stopAdmission();
    } else {
      resourceContext.reportHealth('degraded');
    }
    return;
  }
  counts.runsCompleted += 1;
  counts.lastFinishedAt = clock.wallNow().toISOString();
  if (descriptor.errorPolicy === 'continue' && deps.isAccepting()) {
    resourceContext.reportHealth('healthy');
  }
}

/** How many whole intervals a late timer spans: at least one, the tick it fired for. */
function elapsedIntervals(scheduledAt: number, observedAt: number, everyMs: number): number {
  return Math.max(1, Math.floor((observedAt - scheduledAt) / everyMs) + 1);
}

export function createManagedSchedule(config: ManagedScheduleConfig): ManagedSchedule {
  const descriptor = ManagedScheduleDescriptorSchema.parse({
    id: config.id,
    everyMs: config.everyMs,
    startAfterMs: config.startAfterMs ?? config.everyMs,
    overlap: config.overlap ?? DEFAULT_OVERLAP,
    errorPolicy: config.errorPolicy ?? 'continue',
  });
  const dependsOn = config.dependsOn?.map((id) => ApplicationIdSchema.parse(id));
  const clock = config.clock ?? systemClock;

  let revision = 0;
  let accepting = false;
  let activated = false;
  let stopped = false;
  let timer: ManagedScheduleTimer | null = null;
  let activationContext: ManagedResourceContext | null = null;
  let nextRunAt: number | null = null;
  let queued: { readonly at: number; readonly trigger: ManagedScheduleTrigger } | null = null;
  const counts: ScheduleCounts = {
    runsStarted: 0,
    runsCompleted: 0,
    runsFailed: 0,
    runsWoken: 0,
    ticksSkipped: 0,
    wakesCoalesced: 0,
    lastTrigger: null,
    lastScheduledAt: null,
    lastStartedAt: null,
    lastFinishedAt: null,
  };
  let changedAt = clock.wallNow().toISOString();
  const active = new Set<Promise<void>>();

  const changed = (): void => {
    revision += 1;
    changedAt = clock.wallNow().toISOString();
  };

  const cancelFuture = (): void => {
    timer?.cancel();
    timer = null;
    nextRunAt = null;
    queued = null;
  };

  const stopAdmission = (): void => {
    if (!accepting && stopped) return;
    accepting = false;
    stopped = true;
    cancelFuture();
    changed();
  };

  const status = (): ManagedScheduleStatus => {
    const captured = clock.wallNow();
    const anchor = { monotonicNow: clock.now(), wallNow: captured.getTime() };
    return ManagedScheduleStatusSchema.parse({
      descriptor,
      state: scheduleState(activated, stopped, accepting, active.size),
      revision,
      capturedAt: captured.toISOString(),
      changedAt,
      accepting,
      active: active.size,
      queued: queued !== null,
      ...counts,
      nextRunAt: wallAt(nextRunAt, anchor),
    });
  };

  let startExecution: (scheduledAt: number, trigger: ManagedScheduleTrigger) => void = () =>
    undefined;

  /** Start the one pending run once a slot is free. */
  const settleExecution = (): void => {
    if (!accepting || queued === null) return;
    if (overlapDecision(descriptor.overlap, active.size) !== 'start') return;
    const successor = queued;
    queued = null;
    changed();
    startExecution(successor.at, successor.trigger);
  };

  startExecution = (scheduledAt, trigger): void => {
    const resourceContext = activationContext;
    if (!accepting || !resourceContext) return;
    // A run that starts now sees everything a pending request was waiting for.
    queued = null;
    const tracked = executeRun(
      {
        config,
        descriptor,
        clock,
        counts,
        resourceContext,
        changed,
        stopAdmission,
        isAccepting: () => accepting,
      },
      scheduledAt,
      trigger,
    ).finally(() => {
      active.delete(tracked);
      changed();
      settleExecution();
    });
    active.add(tracked);
  };

  const dispatchTick = (scheduledAt: number): void => {
    if (!accepting) return;
    const decision = overlapDecision(descriptor.overlap, active.size);
    if (decision === 'start') {
      startExecution(scheduledAt, 'timer');
      return;
    }
    if (decision === 'queue')
      queued = { at: scheduledAt, trigger: queued?.trigger ?? 'timer' };
    else counts.ticksSkipped += 1;
    changed();
  };

  const wake = (): void => {
    if (!accepting) return;
    if (queued) {
      counts.wakesCoalesced += 1;
      queued = { at: queued.at, trigger: 'wake' };
      changed();
      return;
    }
    queued = { at: clock.now(), trigger: 'wake' };
    changed();
    // The run is begun after the caller's tick, so a burst of calls in it becomes one run.
    queueMicrotask(settleExecution);
  };

  const arm = (): void => {
    if (!accepting || nextRunAt === null) return;
    const delayMs = Math.max(0, nextRunAt - clock.now());
    timer = clock.schedule(() => {
      timer = null;
      if (!accepting || nextRunAt === null) return;
      const scheduledAt = nextRunAt;
      const elapsed = elapsedIntervals(scheduledAt, clock.now(), descriptor.everyMs);
      if (elapsed > 1) {
        counts.ticksSkipped += elapsed - 1;
        changed();
      }
      nextRunAt = scheduledAt + elapsed * descriptor.everyMs;
      arm();
      dispatchTick(scheduledAt);
    }, delayMs);
  };

  const waitForActive = (context: ManagedResourceContext, deadlineAt: number | undefined) =>
    waitForSettled(active, clock, context, deadlineAt);

  const drain = async (context: ManagedResourceContext): Promise<void> => {
    stopAdmission();
    await waitForActive(context, context.deadlineAt);
  };

  return {
    id: descriptor.id,
    ...(dependsOn && { dependsOn }),
    ...(config.required !== undefined && { required: config.required }),
    get status() {
      return status();
    },
    wake,
    start(): void {
      // A new generation, not a refusal.
      //
      // This used to throw whenever `stopped` was set, which `close()` always
      // sets — so a schedule survived exactly one lifetime and any
      // `restart({ resourceId })` naming it, or naming anything it depends on,
      // closed the old generation and then permanently failed the new one.
      // Schedules are required by default, so the application was left
      // `unhealthy` with no way back short of restarting the process.
      //
      // Refusing a start after the application is *finished* is still right —
      // but it is the kernel's call, not this resource's: only the kernel knows
      // whether this `close` was a restart or the way down, and it already
      // refuses `restart` unless the application is `ready`. From in here the
      // two are indistinguishable, and guessing produced the worse answer.
      if (active.size > 0) {
        throw new Error(
          `[stitchkit] schedule "${descriptor.id}" still has executions from its previous generation`,
        );
      }
      cancelFuture();
      stopped = false;
      accepting = false;
      activated = false;
      activationContext = null;
      queued = null;
      changed();
    },
    activate(context): void {
      if (activated || stopped) return;
      activated = true;
      accepting = true;
      activationContext = context;
      nextRunAt = clock.now() + descriptor.startAfterMs;
      context.reportHealth('healthy');
      changed();
      arm();
    },
    stopAdmission(): void {
      stopAdmission();
    },
    drain,
    close(): void {
      stopAdmission();
    },
    async force(context): Promise<void> {
      stopAdmission();
      await waitForActive(context, context.forceDeadlineAt);
      if (active.size > 0) {
        throw new Error(`[stitchkit] schedule "${descriptor.id}" still has active executions`);
      }
    },
  };
}
