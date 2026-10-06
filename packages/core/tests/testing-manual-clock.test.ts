import { describe, expect, test } from 'bun:test';
import type { DurabilityClock } from '../src/durability/contract';
import type {
  BoundedAdmissionClock,
  ManagedResourceContext,
  ManagedScheduleClock,
  RevisionSignalClock,
} from '../src/entrypoints/application';
import { createManagedSchedule } from '../src/entrypoints/application';
import { createManualClock, ManualClockError } from '../src/entrypoints/testing';

type Schedule = (callback: () => void, delayMs: number) => { cancel(): void };

/**
 * A retrier whose continuation does real asynchronous work before it arms the next attempt.
 * Attempt 1 at 0 fails and retries at 5 s; that attempt fails too, does its work, and only then
 * arms attempt 3 three seconds later, at 8 s.
 */
function retrier(schedule: Schedule, work: () => Promise<void>): number[] {
  const attempts: number[] = [];
  const attempt = async (at: number) => {
    attempts.push(at);
    if (attempts.length === 3) return;
    await work();
    const delay = attempts.length === 1 ? 5_000 : 3_000;
    schedule(() => void attempt(at + delay), delay);
  };
  void attempt(0);
  return attempts;
}

/** A continuation that resumes on the event loop's next turns, like an already-readable socket. */
const eventLoopTurns = async () => {
  await new Promise<void>((resolve) => setImmediate(resolve));
  await new Promise<void>((resolve) => setImmediate(resolve));
};

/** Real work far longer than the clock's event-loop yields: a request, a hash in a thread pool. */
const realWork = () => new Promise<void>((resolve) => setTimeout(resolve, 20));

/** The trap the clock exists to avoid: fire due timers and only drain microtasks between them. */
function microtaskOnlyClock() {
  let now = 0;
  const timers: { at: number; callback: () => void }[] = [];
  return {
    schedule: ((callback, delayMs) => {
      const timer = { at: now + delayMs, callback };
      timers.push(timer);
      return { cancel: () => timers.splice(timers.indexOf(timer), 1) };
    }) satisfies Schedule,
    async advance(ms: number) {
      const target = now + ms;
      for (;;) {
        timers.sort((left, right) => left.at - right.at);
        const due = timers[0];
        if (!due || due.at > target) break;
        timers.shift();
        now = due.at;
        due.callback();
        for (let turn = 0; turn < 8; turn++) await Promise.resolve();
      }
      now = target;
    },
  };
}

describe('createManualClock', () => {
  test('a retry armed at the fifth second still fires inside advance(10_000)', async () => {
    const clock = createManualClock();
    const attempts = retrier(
      (callback, delayMs) => clock.schedule(callback, delayMs),
      eventLoopTurns,
    );
    await clock.advance(10_000);
    expect(attempts).toEqual([0, 5_000, 8_000]);
    expect(clock.now()).toBe(10_000);
    expect(clock.pending()).toBe(0);
  });

  test('negative control: a clock that only drains microtasks skips that retry', async () => {
    const clock = microtaskOnlyClock();
    const attempts = retrier(clock.schedule, eventLoopTurns);
    await clock.advance(10_000);
    expect(attempts).not.toContain(8_000);
  });

  test('real I/O of unknown length holds the clock, and the retry after it still fires', async () => {
    const clock = createManualClock();
    // The test wraps the I/O dependency it injects; the code under test needs no clock API.
    const heldRead = async () => {
      const read = clock.hold('request to the fake upstream');
      try {
        await realWork();
      } finally {
        read.release();
      }
    };
    const attempts = retrier(
      (callback, delayMs) => clock.schedule(callback, delayMs),
      heldRead,
    );
    await clock.advance(10_000);
    expect(attempts).toEqual([0, 5_000, 8_000]);
  });

  test('negative control: the same I/O without a hold outruns the yields and the retry is lost', async () => {
    const clock = createManualClock();
    const attempts = retrier(
      (callback, delayMs) => clock.schedule(callback, delayMs),
      async () => {
        await realWork();
      },
    );
    await clock.advance(10_000);
    expect(attempts).not.toContain(8_000);
  });

  test('timers fire in deadline order, ties in scheduling order, and cancel', async () => {
    const clock = createManualClock({ startMs: 100 });
    const fired: string[] = [];
    clock.schedule(() => fired.push('b@20'), 20);
    clock.schedule(() => fired.push('a@10'), 10);
    clock.schedule(() => fired.push('c@20'), 20);
    const cancelled = clock.schedule(() => fired.push('never'), 5);
    clock.schedule(() => fired.push('late'), 31);
    cancelled.cancel();
    cancelled.cancel();
    expect(clock.pending()).toBe(4);
    await clock.advance(30);
    expect(fired).toEqual(['a@10', 'b@20', 'c@20']);
    expect(clock.now()).toBe(130);
    expect(clock.pending()).toBe(1);
  });

  test('the wall clock moves with monotonic time', async () => {
    const clock = createManualClock({ wallStart: new Date('2026-10-06T00:00:00.000Z') });
    await clock.advance(1_500);
    expect(clock.wallNow().toISOString()).toBe('2026-10-06T00:00:01.500Z');
  });

  test('a callback that throws rejects advance with its error', async () => {
    const clock = createManualClock();
    clock.schedule(() => {
      throw new Error('timer failed');
    }, 1);
    await expect(clock.advance(5)).rejects.toThrow('timer failed');
  });

  test('time waits for an open hold, and a hold past the limit is named', async () => {
    const clock = createManualClock({ holdLimitMs: 1_000 });
    const order: string[] = [];
    const work = clock.hold('upload over the socket');
    setTimeout(() => {
      order.push('work done');
      clock.schedule(() => order.push('follow-up'), 50);
      work.release();
    }, 20);
    await clock.advance(100);
    expect(order).toEqual(['work done', 'follow-up']);

    const stuck = createManualClock({ holdLimitMs: 30 });
    stuck.hold('checksum in the thread pool');
    const failure = await stuck.advance(10).then(
      () => null,
      (error: unknown) => error,
    );
    expect(failure).toBeInstanceOf(ManualClockError);
    expect(failure).toMatchObject({
      code: 'MANUAL_CLOCK_HOLD_TIMEOUT',
      holds: ['checksum in the thread pool'],
    });
    expect(String(failure)).toContain('checksum in the thread pool');
  });

  test('a parked hold lets the clock reach the deadline it waits for', async () => {
    const clock = createManualClock({ holdLimitMs: 50 });
    const request = clock.hold('request waiting for its deadline');
    let timedOut = false;
    clock.schedule(() => {
      timedOut = true;
      request.release();
    }, 2_000);
    const resume = request.park();
    await clock.advance(2_000);
    expect(timedOut).toBe(true);
    resume();
  });

  test('until jumps deadline to deadline and fails by its manual limit', async () => {
    const clock = createManualClock();
    let ticks = 0;
    const tick = () => {
      ticks++;
      clock.schedule(tick, 1_000);
    };
    clock.schedule(tick, 1_000);
    expect(await clock.until(() => ticks === 3)).toBe(3_000);
    const failure = await clock
      .until(() => false, { limitMs: 5_000 })
      .then(
        () => null,
        (error: unknown) => error,
      );
    expect(failure).toMatchObject({ code: 'MANUAL_CLOCK_LIMIT' });
    expect(String(failure)).toContain('1 timer(s) pending');
  });

  test('a second advance while one runs is refused, so time never runs backwards', async () => {
    const clock = createManualClock();
    const first = clock.advance(1_000);
    await expect(clock.advance(10)).rejects.toThrow('already advancing');
    await first;
    expect(clock.now()).toBe(1_000);
  });

  test('invalid moves and options are refused', () => {
    const clock = createManualClock();
    expect(clock.advance(-1)).rejects.toThrow(RangeError);
    expect(() => clock.schedule(() => undefined, Number.NaN)).toThrow(RangeError);
    expect(() => createManualClock({ holdLimitMs: 0 })).toThrow();
  });

  test('one clock is every timer boundary Stitchkit takes', () => {
    const clock = createManualClock();
    const boundaries: [
      ManagedScheduleClock,
      DurabilityClock,
      RevisionSignalClock,
      BoundedAdmissionClock,
    ] = [clock, clock, clock, clock];
    expect(boundaries).toHaveLength(4);
  });

  test('drives a managed schedule as its clock', async () => {
    const clock = createManualClock();
    const runs: number[] = [];
    const schedule = createManagedSchedule({
      id: 'sweep',
      everyMs: 1_000,
      clock,
      run: ({ scheduledAt }) => {
        runs.push(scheduledAt);
      },
    });
    const context: ManagedResourceContext = {
      applicationId: 'manual-clock',
      admission: {
        acquire: () => null,
        acquireWhenAccepting: () => new Promise(() => undefined),
      },
      signal: new AbortController().signal,
      now: () => clock.now(),
      reportHealth: () => undefined,
      use: () => {
        throw new Error('no graph');
      },
    };
    schedule.start(context);
    schedule.activate?.(context);
    await clock.advance(3_500);
    expect(runs).toEqual([1_000, 2_000, 3_000]);
  });
});
