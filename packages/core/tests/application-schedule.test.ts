import { describe, expect, test } from 'bun:test';
import { createApplication } from '../src/application/kernel';
import type { ManagedResourceContext } from '../src/application/resource';
import {
  createManagedSchedule,
  type ManagedScheduleClock,
  type ManagedScheduleTimer,
} from '../src/application/schedule';

interface FakeTimerEntry {
  readonly id: number;
  readonly at: number;
  readonly callback: () => void;
}

const WALL_EPOCH_MS = Date.parse('2026-08-23T00:00:00.000Z');

function wallTimestamp(monotonicMs: number): string {
  return new Date(WALL_EPOCH_MS + monotonicMs).toISOString();
}

class FakeClock implements ManagedScheduleClock {
  private current = 0;
  private wallOffset = 0;
  private sequence = 0;
  private readonly timers = new Map<number, FakeTimerEntry>();

  now(): number {
    return this.current;
  }

  wallNow(): Date {
    return new Date(WALL_EPOCH_MS + this.current + this.wallOffset);
  }

  jumpWallBy(deltaMs: number): void {
    this.wallOffset += deltaMs;
  }

  schedule(callback: () => void, delayMs: number): ManagedScheduleTimer {
    const id = ++this.sequence;
    this.timers.set(id, { id, at: this.current + delayMs, callback });
    return { cancel: () => this.timers.delete(id) };
  }

  pendingTimers(): number {
    return this.timers.size;
  }

  jumpBy(deltaMs: number): void {
    this.current += deltaMs;
  }

  async runOneDueTimer(): Promise<void> {
    let due: FakeTimerEntry | undefined;
    for (const entry of this.timers.values()) {
      if (entry.at > this.current) continue;
      if (!due || entry.at < due.at || (entry.at === due.at && entry.id < due.id)) {
        due = entry;
      }
    }
    if (!due) return;
    this.timers.delete(due.id);
    due.callback();
    await flushMicrotasks();
  }

  async advanceBy(deltaMs: number): Promise<void> {
    const target = this.current + deltaMs;
    while (true) {
      let due: FakeTimerEntry | undefined;
      for (const entry of this.timers.values()) {
        if (entry.at > target) continue;
        if (!due || entry.at < due.at || (entry.at === due.at && entry.id < due.id)) {
          due = entry;
        }
      }
      if (!due) break;
      this.current = due.at;
      this.timers.delete(due.id);
      due.callback();
      await flushMicrotasks();
    }
    this.current = target;
    await flushMicrotasks();
  }
}

async function flushMicrotasks(): Promise<void> {
  await Promise.resolve();
  await Promise.resolve();
  await Promise.resolve();
}

function deferred(): { readonly promise: Promise<void>; readonly resolve: () => void } {
  let resolve = (): void => undefined;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

function resourceContext(
  clock: FakeClock,
  controller = new AbortController(),
  deadlineAt?: number,
): { readonly context: ManagedResourceContext; readonly health: string[] } {
  const health: string[] = [];
  return {
    context: {
      applicationId: 'test-app',
      signal: controller.signal,
      ...(deadlineAt !== undefined && { deadlineAt }),
      now: () => clock.now(),
      reportHealth: (value) => health.push(value),
    },
    health,
  };
}

describe('managed application schedule', () => {
  test('validates its observable descriptor and defaults the first run to one interval', async () => {
    const clock = new FakeClock();
    const calls: number[] = [];
    const schedule = createManagedSchedule({
      id: 'cleanup',
      everyMs: 10,
      clock,
      run: ({ scheduledAt }) => {
        calls.push(scheduledAt);
      },
    });
    const { context } = resourceContext(clock);

    schedule.start(context);
    expect(schedule.status.state).toBe('inactive');
    expect(clock.pendingTimers()).toBe(0);
    schedule.activate?.(context);
    const activated = schedule.status;
    expect(activated.descriptor).toEqual({
      id: 'cleanup',
      everyMs: 10,
      startAfterMs: 10,
      overlap: { mode: 'skip' },
      errorPolicy: 'continue',
    });
    expect(activated).toMatchObject({
      capturedAt: wallTimestamp(0),
      changedAt: wallTimestamp(0),
      nextRunAt: wallTimestamp(10),
    });

    await clock.advanceBy(9);
    expect(calls).toEqual([]);
    await clock.advanceBy(1);
    expect(calls).toEqual([10]);
    expect(schedule.status).toMatchObject({
      capturedAt: wallTimestamp(10),
      lastScheduledAt: wallTimestamp(10),
      lastStartedAt: wallTimestamp(10),
      lastFinishedAt: wallTimestamp(10),
    });
    const beforeWallJump = schedule.status;
    clock.jumpWallBy(3_600_000);
    const afterWallJump = schedule.status;
    expect(afterWallJump.revision).toBe(beforeWallJump.revision);
    expect(afterWallJump.lastScheduledAt).toBe(beforeWallJump.lastScheduledAt);
    expect(afterWallJump.lastStartedAt).toBe(beforeWallJump.lastStartedAt);
    expect(afterWallJump.lastFinishedAt).toBe(beforeWallJump.lastFinishedAt);
    expect(afterWallJump.nextRunAt).not.toBe(beforeWallJump.nextRunAt);

    expect(() =>
      createManagedSchedule({ id: 'bad', everyMs: 0, clock, run: () => undefined }),
    ).toThrow();
    expect(() =>
      createManagedSchedule({
        id: 'bad-parallel',
        everyMs: 1,
        overlap: { mode: 'parallel', maxConcurrent: 0 },
        clock,
        run: () => undefined,
      }),
    ).toThrow();
  });

  test('activates a zero-delay schedule only after the application is top-level ready', async () => {
    const clock = new FakeClock();
    const observedLifecycles: string[] = [];
    let readLifecycle = (): string => 'not-created';
    const schedule = createManagedSchedule({
      id: 'heartbeat',
      everyMs: 10,
      startAfterMs: 0,
      clock,
      run: () => {
        observedLifecycles.push(readLifecycle());
      },
    });
    const app = createApplication({ id: 'scheduled-app', resources: [schedule] });
    readLifecycle = () => app.getSnapshot().lifecycle;

    await app.start();
    expect(observedLifecycles).toEqual([]);
    expect(app.getSnapshot().lifecycle).toBe('ready');
    await clock.advanceBy(0);
    expect(observedLifecycles).toEqual(['ready']);
  });

  test('never arms when shutdown wins startup readiness', async () => {
    const clock = new FakeClock();
    let releaseDependency: () => void = () => undefined;
    const dependencyReady = new Promise<void>((resolve) => {
      releaseDependency = resolve;
    });
    const schedule = createManagedSchedule({
      id: 'never-armed',
      dependsOn: ['dependency'],
      everyMs: 10,
      clock,
      run: () => undefined,
    });
    const app = createApplication({
      id: 'shutdown-before-ready',
      resources: [{ id: 'dependency', start: () => ({ ready: dependencyReady }) }, schedule],
    });
    const starting = app.start();
    await Promise.resolve();

    await expect(
      app.shutdown({ gracePeriodMs: 1, forceTimeoutMs: 20 }),
    ).resolves.toMatchObject({ outcome: 'forced' });
    expect(schedule.status.state).toBe('inactive');
    expect(clock.pendingTimers()).toBe(0);
    releaseDependency();
    await expect(starting).rejects.toThrow('interrupted by shutdown');
  });

  test('supports callback reentrancy and never dispatches after close', async () => {
    const clock = new FakeClock();
    let calls = 0;
    let context: ManagedResourceContext;
    const schedule = createManagedSchedule({
      id: 'reentrant-stop',
      everyMs: 10,
      clock,
      run: () => {
        calls += 1;
        schedule.stopAdmission?.(context);
      },
    });
    ({ context } = resourceContext(clock));
    schedule.start(context);
    schedule.activate?.(context);

    await clock.advanceBy(100);
    expect(calls).toBe(1);
    expect(clock.pendingTimers()).toBe(0);
    await schedule.close?.(context);
    await clock.advanceBy(100);
    expect(calls).toBe(1);
  });

  test('keeps fixed-rate cadence and skips overlapping ticks', async () => {
    const clock = new FakeClock();
    const first = deferred();
    const scheduled: number[] = [];
    const schedule = createManagedSchedule({
      id: 'skip-work',
      everyMs: 10,
      overlap: { mode: 'skip' },
      clock,
      run: ({ scheduledAt }) => {
        scheduled.push(scheduledAt);
        return first.promise;
      },
    });
    const { context } = resourceContext(clock);
    schedule.start(context);
    schedule.activate?.(context);

    await clock.advanceBy(40);
    expect(scheduled).toEqual([10]);
    expect(schedule.status.active).toBe(1);
    expect(schedule.status.ticksSkipped).toBe(3);
    expect(schedule.status.nextRunAt).toBe(wallTimestamp(50));

    first.resolve();
    await flushMicrotasks();
    expect(schedule.status.runsCompleted).toBe(1);
  });

  test('keeps the fixed-rate boundary after an event-loop delay without backfill', async () => {
    const clock = new FakeClock();
    const calls: number[] = [];
    const schedule = createManagedSchedule({
      id: 'delayed-loop',
      everyMs: 10,
      clock,
      run: ({ scheduledAt }) => {
        calls.push(scheduledAt);
      },
    });
    const { context } = resourceContext(clock);
    schedule.start(context);
    schedule.activate?.(context);

    clock.jumpBy(35);
    await clock.runOneDueTimer();
    expect(calls).toEqual([10]);
    expect(schedule.status.ticksSkipped).toBe(2);
    expect(schedule.status.nextRunAt).toBe(wallTimestamp(40));
    await clock.advanceBy(5);
    expect(calls).toEqual([10, 40]);
  });

  test('queue-one collapses ticks to the latest successor and discards it on stop', async () => {
    const clock = new FakeClock();
    const first = deferred();
    const second = deferred();
    const calls: number[] = [];
    const schedule = createManagedSchedule({
      id: 'queued-work',
      everyMs: 10,
      overlap: { mode: 'queue-one' },
      clock,
      run: ({ scheduledAt }) => {
        calls.push(scheduledAt);
        return calls.length === 1 ? first.promise : second.promise;
      },
    });
    const { context } = resourceContext(clock);
    schedule.start(context);
    schedule.activate?.(context);

    await clock.advanceBy(40);
    expect(calls).toEqual([10]);
    expect(schedule.status.queued).toBeTrue();
    first.resolve();
    await flushMicrotasks();
    expect(calls).toEqual([10, 40]);
    expect(schedule.status.queued).toBeFalse();

    await clock.advanceBy(10);
    expect(schedule.status.queued).toBeTrue();
    await schedule.stopAdmission?.(context);
    expect(schedule.status.queued).toBeFalse();
    expect(clock.pendingTimers()).toBe(0);
    second.resolve();
    await flushMicrotasks();
    expect(calls).toEqual([10, 40]);
    expect(schedule.status.state).toBe('stopped');
  });

  test('parallel mode never exceeds maxConcurrent and skips overflow ticks', async () => {
    const clock = new FakeClock();
    const executions = [deferred(), deferred()];
    let maximumActive = 0;
    const schedule = createManagedSchedule({
      id: 'parallel-work',
      everyMs: 10,
      overlap: { mode: 'parallel', maxConcurrent: 2 },
      clock,
      run: () => {
        maximumActive = Math.max(maximumActive, schedule.status.active);
        const execution = executions.shift();
        return execution?.promise;
      },
    });
    const { context } = resourceContext(clock);
    schedule.start(context);
    schedule.activate?.(context);

    await clock.advanceBy(40);
    expect(schedule.status.runsStarted).toBe(2);
    expect(schedule.status.active).toBe(2);
    expect(schedule.status.ticksSkipped).toBe(2);
    expect(maximumActive).toBe(2);
  });

  test('continues after an error, isolates onError and restores health on success', async () => {
    const clock = new FakeClock();
    let attempts = 0;
    const schedule = createManagedSchedule({
      id: 'recovering-work',
      everyMs: 10,
      errorPolicy: 'continue',
      clock,
      run: () => {
        attempts += 1;
        if (attempts === 1) throw new Error('tick failed');
      },
      onError: () => {
        throw new Error('diagnostics failed');
      },
    });
    const { context, health } = resourceContext(clock);
    schedule.start(context);
    schedule.activate?.(context);

    await clock.advanceBy(20);
    expect(attempts).toBe(2);
    expect(schedule.status.runsFailed).toBe(1);
    expect(schedule.status.runsCompleted).toBe(1);
    expect(health).toEqual(['healthy', 'degraded', 'healthy']);
  });

  test('stop-schedule cancels future ticks after the first failure', async () => {
    const clock = new FakeClock();
    let attempts = 0;
    const schedule = createManagedSchedule({
      id: 'failing-work',
      everyMs: 10,
      errorPolicy: 'stop-schedule',
      clock,
      run: () => {
        attempts += 1;
        throw new Error('permanent failure');
      },
    });
    const { context, health } = resourceContext(clock);
    schedule.start(context);
    schedule.activate?.(context);

    await clock.advanceBy(100);
    expect(attempts).toBe(1);
    expect(schedule.status.accepting).toBeFalse();
    expect(schedule.status.state).toBe('stopped');
    expect(clock.pendingTimers()).toBe(0);
    expect(health).toEqual(['healthy', 'unhealthy']);
  });

  test('drain cancels future work, awaits admitted work and respects the shared deadline', async () => {
    const clock = new FakeClock();
    const execution = deferred();
    const schedule = createManagedSchedule({
      id: 'drained-work',
      everyMs: 10,
      clock,
      run: () => execution.promise,
    });
    const activeController = new AbortController();
    const active = resourceContext(clock, activeController);
    schedule.start(active.context);
    schedule.activate?.(active.context);
    await clock.advanceBy(10);

    let drained = false;
    const draining = resourceContext(clock, activeController, 35);
    const drain = Promise.resolve(schedule.drain?.(draining.context)).then(() => {
      drained = true;
    });
    await clock.advanceBy(24);
    expect(drained).toBeFalse();
    expect(clock.pendingTimers()).toBe(1);
    await clock.advanceBy(1);
    await drain;
    expect(drained).toBeTrue();
    expect(schedule.status.state).toBe('draining');
    expect(clock.pendingTimers()).toBe(0);

    execution.resolve();
    await flushMicrotasks();
    expect(schedule.status.state).toBe('stopped');
  });

  test('passes the lifetime signal to callbacks and abort releases a waiting drain', async () => {
    const clock = new FakeClock();
    const execution = deferred();
    const controller = new AbortController();
    let observedSignal: AbortSignal | undefined;
    const schedule = createManagedSchedule({
      id: 'signalled-work',
      everyMs: 10,
      clock,
      run: ({ signal }) => {
        observedSignal = signal;
        return execution.promise;
      },
    });
    const { context } = resourceContext(clock, controller);
    schedule.start(context);
    schedule.activate?.(context);
    await clock.advanceBy(10);
    expect(observedSignal).toBe(controller.signal);

    let drained = false;
    const drain = Promise.resolve(schedule.drain?.(context)).then(() => {
      drained = true;
    });
    await flushMicrotasks();
    expect(drained).toBeFalse();
    controller.abort();
    await drain;
    expect(drained).toBeTrue();
  });

  test('uses the application force budget for an abort-aware active execution', async () => {
    const clock = new FakeClock();
    const schedule = createManagedSchedule({
      id: 'force-aware-work',
      everyMs: 10,
      clock,
      run: ({ signal }) =>
        new Promise<void>((resolve) => {
          signal.addEventListener('abort', () => resolve(), { once: true });
        }),
    });
    const app = createApplication({ id: 'force-aware-app', resources: [schedule] });
    await app.start();
    await clock.advanceBy(10);
    expect(schedule.status.active).toBe(1);

    await expect(
      app.shutdown({ gracePeriodMs: 1, forceTimeoutMs: 100 }),
    ).resolves.toMatchObject({
      outcome: 'forced',
      cleanupComplete: true,
    });
    expect(schedule.status.active).toBe(0);
  });
});
