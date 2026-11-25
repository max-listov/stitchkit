/**
 * A wait that may outlast the timer ceiling is taken by `scheduleAt` alone, in steps of at most
 * `MAX_TIMER_MS`, re-read against its clock on every step so it never fires early — and the
 * owners that wait so (a durable park, a session's refresh retry) wait through it.
 */
import { expect, test } from 'bun:test';
import { createSessionScope } from '../src/browser/session';
import { createSessionRefreshTimer } from '../src/browser/session-refresh-timer';
import { waitForDeadline } from '../src/durability/scheduler';
import { createAgentScheduleService } from '../src/entrypoints/agent-runtime';
import { MAX_TIMER_MS, scheduleAt } from '../src/internal/timers';
import { openSqliteStore } from './support/sqlite-store';

/** A clock whose timers fire only when the test moves time, each at its own instant. */
function steppedClock() {
  let now = 0;
  const timers = new Map<number, { at: number; run: () => void }>();
  const delays: number[] = [];
  let sequence = 0;
  return {
    delays,
    now: () => now,
    schedule(run: () => void, delayMs: number) {
      delays.push(delayMs);
      const id = ++sequence;
      timers.set(id, { at: now + delayMs, run });
      return { cancel: () => timers.delete(id) };
    },
    /** Fire the earliest timer, setting the clock to `at ?? its instant`. */
    fireNext(at?: number) {
      const [id, next] = [...timers].sort((a, b) => a[1].at - b[1].at)[0] ?? [];
      if (id === undefined || next === undefined) return false;
      timers.delete(id);
      now = at ?? next.at;
      next.run();
      return true;
    },
    pending: () => timers.size,
  };
}

test('a wait past the ceiling is taken in steps of the ceiling, and fires once at its instant', () => {
  const clock = steppedClock();
  let fired = 0;
  scheduleAt(clock, 2 * MAX_TIMER_MS + 5, () => {
    fired += 1;
  });
  while (clock.fireNext())
    expect(fired === 0 || clock.now() === 2 * MAX_TIMER_MS + 5).toBe(true);
  expect(clock.delays).toEqual([MAX_TIMER_MS, MAX_TIMER_MS, 5]);
  expect(fired).toBe(1);
});

test('a step that ends before the instant arms the rest instead of firing early', () => {
  const clock = steppedClock();
  let fired = 0;
  scheduleAt(clock, 100, () => {
    fired += 1;
  });
  // The timer fires, but the clock reads 99: one millisecond is still to wait.
  clock.fireNext(99);
  expect(fired).toBe(0);
  expect(clock.delays).toEqual([100, 1]);
  clock.fireNext();
  expect(fired).toBe(1);
});

test('a wait cancelled by code its clock runs leaves no step armed, on either read', () => {
  // A step that ends early reads the clock twice: to see it is early, and to arm the rest.
  for (const cancelOnRead of [2, 3]) {
    const clock = steppedClock();
    let reads = 0;
    let wait: { cancel(): void } | undefined;
    let fired = 0;
    const reading = {
      now: () => {
        reads += 1;
        if (reads === cancelOnRead) wait?.cancel();
        return clock.now();
      },
      schedule: clock.schedule,
    };
    wait = scheduleAt(reading, 100, () => {
      fired += 1;
    });
    clock.fireNext(50);
    expect(clock.pending(), `cancelled on read ${cancelOnRead}`).toBe(0);
    expect(fired).toBe(0);
  }
});

test('a durable park waits past the ceiling through the stepper', async () => {
  const clock = steppedClock();
  const parked = waitForDeadline(clock, 3 * MAX_TIMER_MS, 'park');
  let woke = false;
  void parked.then(() => {
    woke = true;
  });
  for (let step = 0; step < 2; step++) clock.fireNext();
  await Promise.resolve();
  expect(woke).toBe(false);
  clock.fireNext();
  await parked;
  expect(clock.delays).toEqual([MAX_TIMER_MS, MAX_TIMER_MS, MAX_TIMER_MS]);
});

test("a session's refresh retry past the ceiling waits through the stepper and fires once", () => {
  const clock = steppedClock();
  const scope = createSessionScope<string>();
  const operation = scope.replace('signed-in');
  let due = 0;
  const timer = createSessionRefreshTimer({
    scope,
    clock: { now: clock.now, monotonic: clock.now, schedule: clock.schedule },
    leadMs: 0,
    cooldownMs: 0,
    storageRetryMs: 1_000,
    onRefreshDue: () => {
      due += 1;
    },
    onStorageRetry: () => undefined,
  });
  timer.bind(operation);
  timer.armRetry(operation, MAX_TIMER_MS + 7);
  clock.fireNext();
  expect(due).toBe(0);
  clock.fireNext();
  expect(due).toBe(1);
  expect(clock.delays).toEqual([MAX_TIMER_MS, 7]);
});

test('an agent schedule due past the ceiling is waited for in steps, on the service clock', async () => {
  let current = new Date('2026-09-08T01:00:00.000Z');
  const delays: number[] = [];
  const armed: (() => void)[] = [];
  const { sqlite } = openSqliteStore(':memory:');
  const schedules = createAgentScheduleService({
    maxActivePerConversation: 10,
    minIntervalMs: 1,
    host: sqlite.host,
    dispatch: async () => undefined,
    now: () => current,
    setTimer: (callback, delayMs) => {
      delays.push(delayMs);
      armed.push(callback);
      return setTimeout(() => undefined, 0);
    },
    clearTimer: () => undefined,
  });
  try {
    await schedules.scheduleInput({
      conversationId: 's',
      input: { wake: true },
      afterMs: MAX_TIMER_MS + 1_000,
    });
    expect(delays.at(-1)).toBe(MAX_TIMER_MS);
    // The step ends a ceiling later; the schedule is still a second away, so the rest is armed.
    current = new Date(current.getTime() + MAX_TIMER_MS);
    armed.at(-1)?.();
    expect(delays.at(-1)).toBe(1_000);
  } finally {
    schedules.close();
    await sqlite.close();
  }
});
