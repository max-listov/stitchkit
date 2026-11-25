import { abortReason } from '../internal/abort-race';
import { assertTimerMs } from '../internal/deadline';
import { type SteppedTimerClock, scheduleAt } from '../internal/timers';
import { TelegramNotDispatchedError } from './not-dispatched';
import type { TelegramOutboundCallOptions, TelegramOutboundLane } from './outbound-budget';
import type { OutboundPauses } from './outbound-pauses';

interface Waiter {
  readonly cost: number;
  readonly lane: TelegramOutboundLane;
  readonly chat: string | undefined;
  readonly resolve: () => void;
  readonly reject: (reason: unknown) => void;
  readonly signal?: AbortSignal;
  onAbort?: () => void;
  /** Stops the `maxWaitMs` timer. */
  expiry?: AbortController;
}

/** One token's waiting calls, granted one interval apart around whatever is paused. */
export interface OutboundQueue {
  acquire(
    cost: number,
    signal?: AbortSignal,
    options?: TelegramOutboundCallOptions,
  ): Promise<void>;
  /** Wake the drain: a pause changed what it was sleeping on. */
  wake(): void;
  /** Wait until `at` on the budget's clock, however far: `scheduleAt` steps under the timer ceiling. */
  waitUntil(at: number, signal?: AbortSignal): Promise<void>;
  counts(): {
    readonly granted: number;
    readonly messages: number;
    readonly queued: number;
    readonly queuedBulk: number;
  };
}

/**
 * Wait until `at` on the budget's clock, however far: its clock and sleeper become the stepped
 * timer of `scheduleAt`. A step the sleeper refuses for a reason of its own, not the
 * cancellation, fails the wait with it.
 */
function waitOnClock(
  now: () => number,
  sleepFor: (milliseconds: number, signal?: AbortSignal) => Promise<void>,
  at: number,
  signal?: AbortSignal,
): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    if (signal?.aborted) {
      reject(abortReason(signal));
      return;
    }
    if (at <= now()) {
      resolve();
      return;
    }
    let settled = false;
    const settle = (finish: () => void): void => {
      if (settled) return;
      settled = true;
      signal?.removeEventListener('abort', onAbort);
      finish();
    };
    const clock: SteppedTimerClock = {
      now,
      schedule(callback, delayMs) {
        const step = new AbortController();
        sleepFor(delayMs, step.signal).then(callback, (error: unknown) => {
          if (!step.signal.aborted) settle(() => reject(error));
        });
        return { cancel: () => step.abort() };
      },
    };
    const timer = scheduleAt(clock, at, () => settle(resolve));
    const onAbort = (): void => {
      timer.cancel();
      settle(() => reject(signal ? abortReason(signal) : undefined));
    };
    signal?.addEventListener('abort', onAbort, { once: true });
  });
}

export function createOutboundQueue(
  interval: number,
  now: () => number,
  sleepFor: (milliseconds: number, signal?: AbortSignal) => Promise<void>,
  pauses: OutboundPauses,
): OutboundQueue {
  const queue: Waiter[] = [];
  let nextGrantAt = now();
  let granted = 0;
  let messages = 0;
  let draining = false;
  let waking: AbortController | undefined;
  /** When the drain's current wait ends, while it is waiting. */
  let wakingAt = Number.POSITIVE_INFINITY;

  const waitUntil = (at: number, signal?: AbortSignal): Promise<void> =>
    waitOnClock(now, sleepFor, at, signal);

  const wake = (): void => {
    const current = waking;
    waking = undefined;
    current?.abort();
  };

  /**
   * The oldest interactive call no pause holds, else the oldest such bulk one,
   * else the call that resumes first. A chat on pause never holds its place at
   * the head of the queue, so the other chats go on around it.
   */
  const nextWaiter = (current: number): Waiter | undefined => {
    let bulk: Waiter | undefined;
    let held: Waiter | undefined;
    for (const waiter of queue) {
      if (pauses.resumesAt(waiter.chat) > current) {
        if (
          held === undefined ||
          pauses.resumesAt(waiter.chat) < pauses.resumesAt(held.chat)
        ) {
          held = waiter;
        }
      } else if (waiter.lane === 'interactive') {
        return waiter;
      } else {
        bulk ??= waiter;
      }
    }
    return bulk ?? held;
  };

  const detach = (waiter: Waiter): void => {
    if (waiter.onAbort) waiter.signal?.removeEventListener('abort', waiter.onAbort);
    waiter.expiry?.abort();
  };

  const remove = (waiter: Waiter): void => {
    const index = queue.indexOf(waiter);
    if (index === -1) return;
    const next = nextWaiter(now()) === waiter;
    queue.splice(index, 1);
    if (next) wake();
  };

  const drain = async (): Promise<void> => {
    if (draining) return;
    draining = true;
    try {
      while (queue.length > 0) {
        const current = now();
        const head = nextWaiter(current);
        if (head === undefined) break;
        if (head.signal?.aborted) {
          remove(head);
          continue;
        }
        const at = Math.max(current, nextGrantAt, pauses.resumesAt(head.chat));
        if (at > current) {
          const controller = new AbortController();
          waking = controller;
          wakingAt = at;
          try {
            await waitUntil(at, controller.signal);
          } catch (error) {
            if (!controller.signal.aborted) {
              for (const waiter of queue.splice(0)) {
                detach(waiter);
                waiter.reject(error);
              }
              return;
            }
          } finally {
            if (waking === controller) waking = undefined;
            wakingAt = Number.POSITIVE_INFINITY;
          }
          continue;
        }
        queue.splice(queue.indexOf(head), 1);
        detach(head);
        nextGrantAt = at + head.cost * interval;
        granted += 1;
        messages += head.cost;
        head.resolve();
      }
    } finally {
      draining = false;
      // A waiter added after the loop checked the empty queue but before the
      // flag was cleared must not be left behind.
      if (queue.length > 0) void drain();
    }
  };

  const expireAfter = (
    waiter: Waiter,
    maxWaitMs: number,
    reject: (reason: unknown) => void,
  ): void => {
    waiter.expiry = new AbortController();
    void waitUntil(now() + maxWaitMs, waiter.expiry.signal).then(
      () => {
        if (!queue.includes(waiter)) return;
        remove(waiter);
        detach(waiter);
        reject(
          new TelegramNotDispatchedError(
            'queue',
            'the Telegram request waited longer than maxWaitMs for its turn',
          ),
        );
      },
      () => undefined,
    );
  };

  return {
    acquire(cost, signal, options) {
      if (!Number.isSafeInteger(cost) || cost < 1) {
        return Promise.reject(
          new RangeError('cost must be an integer of at least one message'),
        );
      }
      if (signal?.aborted) return Promise.reject(abortReason(signal));
      const maxWaitMs = options?.maxWaitMs;
      try {
        assertTimerMs('maxWaitMs', maxWaitMs);
      } catch (error) {
        return Promise.reject(error);
      }
      const chat = options?.chatId === undefined ? undefined : String(options.chatId);
      return new Promise<void>((resolve, reject) => {
        const waiter: Waiter = {
          cost,
          lane: options?.lane ?? 'interactive',
          chat,
          resolve,
          reject,
          ...(signal && { signal }),
        };
        if (signal) {
          const onAbort = (): void => {
            remove(waiter);
            detach(waiter);
            reject(abortReason(signal));
          };
          waiter.onAbort = onAbort;
          signal.addEventListener('abort', onAbort, { once: true });
        }
        if (maxWaitMs !== undefined) expireAfter(waiter, maxWaitMs, reject);
        queue.push(waiter);
        // The drain may be asleep until some other chat resumes.
        if (Math.max(now(), nextGrantAt, pauses.resumesAt(chat)) < wakingAt) wake();
        void drain();
      });
    },
    wake,
    waitUntil,
    counts: () => ({
      granted,
      messages,
      queued: queue.length,
      queuedBulk: queue.filter((waiter) => waiter.lane === 'bulk').length,
    }),
  };
}
