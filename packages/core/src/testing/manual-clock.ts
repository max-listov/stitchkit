/**
 * Manual time for tests of schedules, retries and deadlines.
 *
 * Time stands still until the test moves it, and due timers fire strictly in deadline order
 * (ties in scheduling order), so "retry after 5 s" runs in milliseconds and the same way every
 * time. It satisfies every timer boundary Stitchkit accepts: `ManagedScheduleClock`,
 * `DurabilityClock`, `RevisionSignalClock` and `BoundedAdmissionClock`.
 *
 * Between firings the clock yields to the **real event loop** (`setImmediate` turns), not just to
 * microtasks: an async continuation that schedules the next timer often waits on I/O (a socket,
 * a file), and without a real turn `advance(10_000)` would skip a retry the code meant to arm at
 * the fifth second. When the work in flight has no bounded length (a request over a socket, a
 * hash in a thread pool), the code under test `hold`s the clock for its duration; the clock does
 * not move while a hold is open and waits for it in real time, up to `holdLimitMs`, then fails
 * naming every open hold. A held operation that itself waits for the clock (a deadline it is
 * timing out on) `park`s its hold, or the deadline it waits for would never come.
 */

import { assertPositiveSafeInteger } from '../internal/positive-integer';

/** Cancels one scheduled callback; calling it again is harmless. */
export interface ManualClockTimer {
  cancel(): void;
}

/** An open hold: the clock stays where it is until `release`, unless the hold is parked. */
export interface ManualClockHold {
  /** Ends the hold. */
  release(): void;
  /** The held work now waits for the clock itself; returns the function that ends the park. */
  park(): () => void;
}

export interface ManualClockOptions {
  /** Monotonic start, in milliseconds. Default `0`. */
  readonly startMs?: number;
  /** Wall-clock instant at `startMs`. Default `2026-01-01T00:00:00.000Z`. */
  readonly wallStart?: Date;
  /** Real event-loop turns yielded after each firing. Default `8`. */
  readonly yieldTurns?: number;
  /** Real milliseconds the clock waits for open holds before failing. Default `5000`. */
  readonly holdLimitMs?: number;
}

export interface ManualClockUntilOptions {
  /** Manual milliseconds per step while no timer is pending. Default `100`. */
  readonly stepMs?: number;
  /** Manual milliseconds after which `until` fails. Default `600_000`. */
  readonly limitMs?: number;
}

export interface ManualClock {
  /** Monotonic milliseconds. */
  now(): number;
  /** The wall clock that moves with `now`. */
  wallNow(): Date;
  /** Runs `callback` once the clock reaches `now() + delayMs` (negative delays fire next). */
  schedule(callback: () => void, delayMs: number): ManualClockTimer;
  /**
   * Moves time by `ms`, firing every timer due on the way in deadline order and yielding to the
   * event loop after each, so a timer armed by a fired callback inside the window fires too.
   * A callback that throws rejects `advance` with that error.
   */
  advance(ms: number): Promise<void>;
  /**
   * Moves time from deadline to deadline (by `stepMs` while nothing is pending) until `done()`
   * holds; resolves with the manual milliseconds that took. Fails with `MANUAL_CLOCK_LIMIT`
   * once `limitMs` of manual time pass, naming how many timers are pending.
   */
  until(done: () => boolean, options?: ManualClockUntilOptions): Promise<number>;
  /** How many timers wait. A timer leaked past a component's `close()` shows here. */
  pending(): number;
  /** Holds time while unbounded real work runs; `reason` names it if the hold outlives the limit. */
  hold(reason: string): ManualClockHold;
}

/** `MANUAL_CLOCK_HOLD_TIMEOUT`: open holds outlived `holdLimitMs`; `MANUAL_CLOCK_LIMIT`: `until` ran out. */
export type ManualClockErrorCode = 'MANUAL_CLOCK_HOLD_TIMEOUT' | 'MANUAL_CLOCK_LIMIT';

/** A manual clock refused to go on; the message and `holds` name what did not finish. */
export class ManualClockError extends Error {
  override readonly name = 'ManualClockError';
  constructor(
    readonly code: ManualClockErrorCode,
    message: string,
    /** Reasons of the open, unparked holds (`MANUAL_CLOCK_HOLD_TIMEOUT` only). */
    readonly holds: readonly string[] = [],
  ) {
    super(message);
  }
}

interface ScheduledTimer {
  readonly at: number;
  readonly order: number;
  readonly callback: () => void;
}

const DEFAULT_WALL_START = Date.parse('2026-01-01T00:00:00.000Z');

export function createManualClock(options: ManualClockOptions = {}): ManualClock {
  const startMs = options.startMs ?? 0;
  if (!Number.isFinite(startMs)) throw new RangeError('startMs must be a finite number');
  const wallStart = options.wallStart?.getTime() ?? DEFAULT_WALL_START;
  if (!Number.isFinite(wallStart)) throw new RangeError('wallStart must be a valid date');
  const turns = options.yieldTurns ?? 8;
  assertPositiveSafeInteger('yieldTurns', turns);
  const holdLimitMs = options.holdLimitMs ?? 5000;
  assertPositiveSafeInteger('holdLimitMs', holdLimitMs);

  let now = startMs;
  let order = 0;
  /** One move at a time: two interleaved moves would each set `now` and run time backwards. */
  let moving = false;
  const timers = new Map<number, ScheduledTimer>();
  /** Open holds by id, with whether each is parked. */
  const holds = new Map<number, { reason: string; parked: boolean }>();

  const activeHolds = () =>
    [...holds.values()].filter((hold) => !hold.parked).map((hold) => hold.reason);
  const settle = async () => {
    for (let turn = 0; turn < turns; turn++)
      await new Promise<void>((resolve) => setImmediate(resolve));
  };
  /** Time does not move while real work that does not wait for the clock is in flight. */
  const idle = async () => {
    const started = performance.now();
    for (let open = activeHolds(); open.length > 0; open = activeHolds()) {
      if (performance.now() - started > holdLimitMs)
        throw new ManualClockError(
          'MANUAL_CLOCK_HOLD_TIMEOUT',
          `Manual clock waited ${holdLimitMs} ms of real time for ${open.length} open hold(s): ${open.join(', ')}`,
          open,
        );
      await new Promise<void>((resolve) => setTimeout(resolve, 0));
    }
    await settle();
  };
  const nextDue = (limit: number): [number, ScheduledTimer] | undefined => {
    let best: [number, ScheduledTimer] | undefined;
    for (const entry of timers) {
      const [, timer] = entry;
      if (timer.at > limit) continue;
      if (
        !best ||
        timer.at < best[1].at ||
        (timer.at === best[1].at && timer.order < best[1].order)
      )
        best = entry;
    }
    return best;
  };

  /** Fires every timer due by `target` in order, yielding after each, then lands on `target`. */
  const move = async (target: number) => {
    await idle();
    for (let due = nextDue(target); due; due = nextDue(target)) {
      const [id, timer] = due;
      timers.delete(id);
      now = Math.max(now, timer.at);
      timer.callback();
      await idle();
    }
    now = target;
    await idle();
  };

  const clock: ManualClock = {
    now: () => now,
    wallNow: () => new Date(wallStart + (now - startMs)),
    schedule(callback, delayMs) {
      if (Number.isNaN(delayMs)) throw new RangeError('Timer delay must be a number');
      const id = ++order;
      timers.set(id, { at: now + Math.max(0, delayMs), order: id, callback });
      return { cancel: () => void timers.delete(id) };
    },
    async advance(ms) {
      if (!Number.isFinite(ms) || ms < 0)
        throw new RangeError(`Manual clock cannot advance by ${ms} ms`);
      if (moving)
        throw new Error('Manual clock is already advancing; await that advance first');
      moving = true;
      try {
        await move(now + ms);
      } finally {
        moving = false;
      }
    },

    async until(done, { stepMs = 100, limitMs = 600_000 } = {}) {
      assertPositiveSafeInteger('stepMs', stepMs);
      assertPositiveSafeInteger('limitMs', limitMs);
      const from = now;
      await idle();
      while (!done()) {
        if (now - from >= limitMs)
          throw new ManualClockError(
            'MANUAL_CLOCK_LIMIT',
            `Condition still false after ${now - from} ms of manual time (limit ${limitMs} ms, ${timers.size} timer(s) pending)`,
          );
        // Jump to the next deadline: nothing happens between deadlines, and walking there in
        // steps would pay event-loop turns for empty time. With no timer, step while I/O lands.
        const next = nextDue(Number.POSITIVE_INFINITY);
        const jump = next ? Math.max(0, next[1].at - now) : stepMs;
        await clock.advance(Math.min(jump, from + limitMs - now));
      }
      return now - from;
    },
    pending: () => timers.size,
    hold(reason) {
      const id = ++order;
      holds.set(id, { reason, parked: false });
      return {
        release: () => void holds.delete(id),
        park() {
          const hold = holds.get(id);
          if (!hold || hold.parked) return () => undefined;
          hold.parked = true;
          return () => {
            const current = holds.get(id);
            if (current) current.parked = false;
          };
        },
      };
    },
  };
  return clock;
}
