import type { ManagedResourceContext } from './resource';
import {
  type ManagedScheduleClock,
  type ManagedScheduleConfig,
  type ManagedScheduleDescriptor,
  ManagedScheduleDescriptorSchema,
  type ManagedScheduleOverlap,
  type ManagedScheduleRunContext,
  type ManagedScheduleStatus,
  type ManagedScheduleTimer,
  type ManagedScheduleTrigger,
} from './schedule-contract';

const DEFAULT_OVERLAP: ManagedScheduleOverlap = { mode: 'skip' };

export interface ScheduleCounts {
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

export function emptyCounts(): ScheduleCounts {
  return {
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
}

/** The validated public descriptor of a schedule configuration, with defaults applied. */
export function describeSchedule(config: ManagedScheduleConfig): ManagedScheduleDescriptor {
  return ManagedScheduleDescriptorSchema.parse({
    id: config.id,
    everyMs: config.everyMs,
    startAfterMs: config.startAfterMs ?? config.everyMs,
    overlap: config.overlap ?? DEFAULT_OVERLAP,
    errorPolicy: config.errorPolicy ?? 'continue',
  });
}

export function scheduleState(
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
export function wallAt(
  monotonicAt: number | null,
  anchor: { readonly monotonicNow: number; readonly wallNow: number },
): string | null {
  if (monotonicAt === null) return null;
  return new Date(anchor.wallNow + monotonicAt - anchor.monotonicNow).toISOString();
}

/** What a due tick does under the overlap policy, given how many runs are active. A wake that
 *  is not `start` waits for a free slot under every policy: it is an event, not a missed tick. */
export function overlapDecision(
  overlap: ManagedScheduleOverlap,
  active: number,
): 'start' | 'queue' | 'skip' {
  if (overlap.mode === 'skip') return active > 0 ? 'skip' : 'start';
  if (overlap.mode === 'queue-one') return active > 0 ? 'queue' : 'start';
  return active >= overlap.maxConcurrent ? 'skip' : 'start';
}

export function reportScheduleError(
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
export async function waitForSettled(
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

export interface RunDeps {
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
export async function executeRun(
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
export function elapsedIntervals(
  scheduledAt: number,
  observedAt: number,
  everyMs: number,
): number {
  return Math.max(1, Math.floor((observedAt - scheduledAt) / everyMs) + 1);
}
