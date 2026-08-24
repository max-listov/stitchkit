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
    ticksSkipped: NonNegativeSafeIntegerSchema,
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
}

const DEFAULT_OVERLAP: ManagedScheduleOverlap = { mode: 'skip' };

/** Create one fixed-rate, process-local periodic application resource. */
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
  let queuedAt: number | null = null;
  let runsStarted = 0;
  let runsCompleted = 0;
  let runsFailed = 0;
  let ticksSkipped = 0;
  let lastScheduledAt: string | null = null;
  let lastStartedAt: string | null = null;
  let lastFinishedAt: string | null = null;
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
    queuedAt = null;
  };

  const stopAdmission = (): void => {
    if (!accepting && stopped) return;
    accepting = false;
    stopped = true;
    cancelFuture();
    changed();
  };

  const reportError = (error: unknown, context: ManagedScheduleRunContext): void => {
    if (!config.onError) return;
    void Promise.resolve()
      .then(() => config.onError?.(error, context))
      .catch(() => {
        // Error diagnostics cannot fail the schedule or create an unhandled rejection.
      });
  };

  const state = (): ManagedScheduleStatus['state'] => {
    if (!activated) return stopped ? 'stopped' : 'inactive';
    if (!accepting) return active.size > 0 ? 'draining' : 'stopped';
    return active.size > 0 ? 'running' : 'scheduled';
  };

  const wallAt = (
    monotonicAt: number | null,
    anchor: { readonly monotonicNow: number; readonly wallNow: number },
  ): string | null => {
    if (monotonicAt === null) return null;
    return new Date(anchor.wallNow + monotonicAt - anchor.monotonicNow).toISOString();
  };

  const status = (): ManagedScheduleStatus => {
    const captured = clock.wallNow();
    const anchor = { monotonicNow: clock.now(), wallNow: captured.getTime() };
    return ManagedScheduleStatusSchema.parse({
      descriptor,
      state: state(),
      revision,
      capturedAt: captured.toISOString(),
      changedAt,
      accepting,
      active: active.size,
      queued: queuedAt !== null,
      runsStarted,
      runsCompleted,
      runsFailed,
      ticksSkipped,
      nextRunAt: wallAt(nextRunAt, anchor),
      lastScheduledAt,
      lastStartedAt,
      lastFinishedAt,
    });
  };

  let startExecution: (scheduledAt: number) => void = () => undefined;

  const settleExecution = (): void => {
    if (!accepting || queuedAt === null || active.size !== 0) return;
    const successorAt = queuedAt;
    queuedAt = null;
    changed();
    startExecution(successorAt);
  };

  startExecution = (scheduledAt): void => {
    const resourceContext = activationContext;
    if (!accepting || !resourceContext) return;
    const startedAt = clock.now();
    const wallStartedAt = clock.wallNow().getTime();
    const runContext: ManagedScheduleRunContext = {
      applicationId: resourceContext.applicationId,
      signal: resourceContext.signal,
      scheduledAt,
      startedAt,
      now: () => clock.now(),
    };
    runsStarted += 1;
    lastScheduledAt = new Date(wallStartedAt + scheduledAt - startedAt).toISOString();
    lastStartedAt = new Date(wallStartedAt).toISOString();
    changed();

    let tracked: Promise<void>;
    tracked = Promise.resolve()
      .then(() => config.run(runContext))
      .then(
        () => {
          runsCompleted += 1;
          lastFinishedAt = clock.wallNow().toISOString();
          if (descriptor.errorPolicy === 'continue' && accepting) {
            resourceContext.reportHealth('healthy');
          }
        },
        (error: unknown) => {
          runsFailed += 1;
          lastFinishedAt = clock.wallNow().toISOString();
          reportError(error, runContext);
          if (descriptor.errorPolicy === 'stop-schedule') {
            resourceContext.reportHealth('unhealthy');
            stopAdmission();
          } else {
            resourceContext.reportHealth('degraded');
          }
        },
      )
      .finally(() => {
        active.delete(tracked);
        changed();
        settleExecution();
      });
    active.add(tracked);
  };

  const dispatchTick = (scheduledAt: number): void => {
    if (!accepting) return;
    if (descriptor.overlap.mode === 'skip') {
      if (active.size > 0) {
        ticksSkipped += 1;
        changed();
        return;
      }
      startExecution(scheduledAt);
      return;
    }
    if (descriptor.overlap.mode === 'queue-one') {
      if (active.size > 0) {
        queuedAt = scheduledAt;
        changed();
        return;
      }
      startExecution(scheduledAt);
      return;
    }
    if (active.size >= descriptor.overlap.maxConcurrent) {
      ticksSkipped += 1;
      changed();
      return;
    }
    startExecution(scheduledAt);
  };

  const arm = (): void => {
    if (!accepting || nextRunAt === null) return;
    const delayMs = Math.max(0, nextRunAt - clock.now());
    timer = clock.schedule(() => {
      timer = null;
      if (!accepting || nextRunAt === null) return;
      const scheduledAt = nextRunAt;
      const observedAt = clock.now();
      const elapsedIntervals = Math.max(
        1,
        Math.floor((observedAt - scheduledAt) / descriptor.everyMs) + 1,
      );
      if (elapsedIntervals > 1) {
        ticksSkipped += elapsedIntervals - 1;
        changed();
      }
      nextRunAt = scheduledAt + elapsedIntervals * descriptor.everyMs;
      arm();
      dispatchTick(scheduledAt);
    }, delayMs);
  };

  const waitForActive = async (
    context: ManagedResourceContext,
    deadlineAt: number | undefined,
  ): Promise<void> => {
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
  };

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
    start(): void {
      if (stopped) throw new Error(`[stitchkit] schedule "${descriptor.id}" is stopped`);
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
