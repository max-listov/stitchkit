import { describe, expect, test } from 'bun:test';
import { getEventListeners } from 'node:events';
import {
  createRevisionSignal,
  type RevisionSignalClock,
  type RevisionSignalTimer,
} from '../src/application/revision-signal';

interface Scheduled {
  readonly at: number;
  readonly callback: () => void;
  active: boolean;
}

class FakeClock implements RevisionSignalClock {
  private now = 0;
  private readonly scheduled: Scheduled[] = [];

  schedule(callback: () => void, delayMs: number): RevisionSignalTimer {
    const entry: Scheduled = { at: this.now + delayMs, callback, active: true };
    this.scheduled.push(entry);
    return {
      cancel() {
        entry.active = false;
      },
    };
  }

  advanceBy(ms: number): void {
    const target = this.now + ms;
    while (true) {
      const next = this.scheduled
        .filter((entry) => entry.active && entry.at <= target)
        .sort((left, right) => left.at - right.at)[0];
      if (!next) break;
      this.now = next.at;
      next.active = false;
      next.callback();
    }
    this.now = target;
  }

  pendingTimers(): number {
    return this.scheduled.filter((entry) => entry.active).length;
  }
}

describe('revision signal', () => {
  test('one advance broadcasts the same revision to every waiter', async () => {
    const signal = createRevisionSignal({ maxWaiters: 2 });
    const first = signal.wait(0);
    const second = signal.wait(0);

    expect(signal.getSnapshot()).toMatchObject({ revision: 0, pending: 2 });
    expect(signal.advance()).toEqual({ outcome: 'advanced', revision: 1 });
    expect(await first).toEqual({ outcome: 'changed', revision: 1 });
    expect(await second).toEqual({ outcome: 'changed', revision: 1 });
    expect(signal.getSnapshot()).toMatchObject({ pending: 0, changed: 2, advances: 1 });
  });

  test('an old revision resolves immediately while the current revision waits', async () => {
    const signal = createRevisionSignal({ maxWaiters: 1 });
    signal.advance();

    expect(await signal.wait(0)).toEqual({ outcome: 'changed', revision: 1 });
    const current = signal.wait(1);
    expect(signal.getSnapshot().pending).toBe(1);

    signal.advance();
    expect(await current).toEqual({ outcome: 'changed', revision: 2 });
  });

  test('a future revision is rejected without creating a waiter', () => {
    const signal = createRevisionSignal({ maxWaiters: 1 });

    expect(() => signal.wait(1)).toThrow('cannot wait after future revision 1');
    expect(signal.getSnapshot()).toMatchObject({ revision: 0, pending: 0, waits: 0 });
  });

  test('maxWaiters refuses excess waits without retaining them', async () => {
    const signal = createRevisionSignal({ maxWaiters: 1 });
    const retained = signal.wait(0);

    expect(await signal.wait(0)).toEqual({ outcome: 'capacity', revision: 0 });
    expect(signal.getSnapshot()).toMatchObject({
      pending: 1,
      maxWaiters: 1,
      capacityRefusals: 1,
    });

    signal.close();
    expect(await retained).toEqual({ outcome: 'closed', revision: 0 });
  });

  test('timeoutMs settles only after the declared wait budget', async () => {
    const clock = new FakeClock();
    const signal = createRevisionSignal({ maxWaiters: 1, clock });
    let settled = false;
    const waiting = signal.wait(0, { timeoutMs: 10 }).then((result) => {
      settled = true;
      return result;
    });

    clock.advanceBy(9);
    await Promise.resolve();
    expect(settled).toBe(false);
    expect(signal.getSnapshot().pending).toBe(1);

    clock.advanceBy(1);
    expect(await waiting).toEqual({ outcome: 'timed-out', revision: 0 });
    expect(signal.getSnapshot()).toMatchObject({ pending: 0, timedOut: 1 });
  });

  test('the injected clock owns timeout scheduling and cancellation', async () => {
    const clock = new FakeClock();
    const signal = createRevisionSignal({ maxWaiters: 1, clock });
    const waiting = signal.wait(0, { timeoutMs: 10 });

    expect(clock.pendingTimers()).toBe(1);
    signal.advance();
    expect(await waiting).toEqual({ outcome: 'changed', revision: 1 });
    expect(clock.pendingTimers()).toBe(0);

    clock.advanceBy(10);
    expect(signal.getSnapshot()).toMatchObject({ changed: 1, timedOut: 0 });
  });

  test('an aborted signal ends a revision wait before and during it', async () => {
    const clock = new FakeClock();
    const signal = createRevisionSignal({ maxWaiters: 2, clock });

    expect(await signal.wait(0, { signal: AbortSignal.abort() })).toEqual({
      outcome: 'aborted',
      revision: 0,
    });

    const controller = new AbortController();
    const waiting = signal.wait(0, { signal: controller.signal, timeoutMs: 10 });
    expect(getEventListeners(controller.signal, 'abort')).toHaveLength(1);
    expect(clock.pendingTimers()).toBe(1);

    controller.abort();
    expect(await waiting).toEqual({ outcome: 'aborted', revision: 0 });
    expect(getEventListeners(controller.signal, 'abort')).toHaveLength(0);
    expect(clock.pendingTimers()).toBe(0);
    expect(signal.getSnapshot()).toMatchObject({ pending: 0, aborted: 2, timedOut: 0 });
  });

  test('close wins one race, clears every waiter and stays idempotent', async () => {
    const clock = new FakeClock();
    const controller = new AbortController();
    const signal = createRevisionSignal({ maxWaiters: 2, clock });
    const first = signal.wait(0, { timeoutMs: 10, signal: controller.signal });
    const second = signal.wait(0, { timeoutMs: 10 });

    const closed = signal.close();
    expect(closed).toMatchObject({ state: 'closed', revision: 0, pending: 0, closedWaits: 2 });
    expect(signal.close()).toEqual(closed);
    expect(await first).toEqual({ outcome: 'closed', revision: 0 });
    expect(await second).toEqual({ outcome: 'closed', revision: 0 });
    expect(clock.pendingTimers()).toBe(0);
    expect(getEventListeners(controller.signal, 'abort')).toHaveLength(0);

    controller.abort();
    clock.advanceBy(10);
    expect(signal.getSnapshot()).toMatchObject({ closedWaits: 2, aborted: 0, timedOut: 0 });
    expect(await signal.wait(0)).toEqual({ outcome: 'closed', revision: 0 });
    expect(signal.advance()).toEqual({ outcome: 'closed', revision: 0 });
    expect(signal.getSnapshot()).toMatchObject({
      revision: 0,
      closedWaits: 3,
      refusedAdvances: 1,
    });
  });

  test('invalid bounds fail before the signal retains state', () => {
    expect(() => createRevisionSignal({ maxWaiters: 0 })).toThrow();
    const signal = createRevisionSignal({ maxWaiters: 1 });
    expect(() => signal.wait(-1)).toThrow();
    expect(() => signal.wait(0, { timeoutMs: 0 })).toThrow();
    expect(() => signal.wait(0, { timeoutMs: 2_147_483_648 })).toThrow();
    expect(signal.getSnapshot()).toMatchObject({ pending: 0, waits: 0 });
  });

  test('a clock failure rejects the wait after releasing its listener and slot', async () => {
    const controller = new AbortController();
    const signal = createRevisionSignal({
      maxWaiters: 1,
      clock: {
        schedule() {
          throw new Error('clock unavailable');
        },
      },
    });

    await expect(signal.wait(0, { signal: controller.signal, timeoutMs: 1 })).rejects.toThrow(
      'clock unavailable',
    );
    expect(getEventListeners(controller.signal, 'abort')).toHaveLength(0);
    expect(signal.getSnapshot()).toMatchObject({ pending: 0, waits: 1, clockFailures: 1 });
  });
});
