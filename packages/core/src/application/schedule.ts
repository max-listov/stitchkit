import type { ManagedResourceContext } from './resource';
import {
  type ManagedSchedule,
  type ManagedScheduleClock,
  type ManagedScheduleConfig,
  type ManagedScheduleStatus,
  ManagedScheduleStatusSchema,
  type ManagedScheduleTimer,
  type ManagedScheduleTrigger,
} from './schedule-contract';
import {
  describeSchedule,
  elapsedIntervals,
  emptyCounts,
  executeRun,
  overlapDecision,
  scheduleState,
  waitForSettled,
  wallAt,
} from './schedule-run';
import { ApplicationIdSchema } from './schemas';

const systemClock: ManagedScheduleClock = {
  now: () => performance.now(),
  wallNow: () => new Date(),
  schedule(callback, delayMs) {
    const timer = setTimeout(callback, delayMs);
    return { cancel: () => clearTimeout(timer) };
  },
};

/** Create one fixed-rate, process-local periodic application resource. */
export function createManagedSchedule(config: ManagedScheduleConfig): ManagedSchedule {
  const descriptor = describeSchedule(config);
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
  const counts = emptyCounts();
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
      // A start after `close()` begins a new generation: `restart({ resourceId })` closes a
      // resource and starts it again. Refusing a start once the application is finished is the
      // kernel's call; only it knows whether a close was a restart or the way down.
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
