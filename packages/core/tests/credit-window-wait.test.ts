import { describe, expect, test } from 'bun:test';
import { createCreditWindow } from '../src/application/channel';

/**
 * Await a waiter, but never longer than the assertion is worth.
 *
 * Every regression this file guards — a waiter that is never woken, a close that parks one —
 * makes its promise settle never rather than wrongly. Awaiting that directly turns a red test
 * into a hung CI job, so the wait is bounded and the sentinel is what fails the assertion.
 */
const PENDING = Symbol('still pending');
async function within<T>(promise: Promise<T>, ms = 250): Promise<T | typeof PENDING> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<typeof PENDING>((resolve) => {
        timer = setTimeout(() => resolve(PENDING), ms);
      }),
    ]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}

describe('waiting acquire on a credit window', () => {
  test('resumes when the consumer replenishes, in arrival order', async () => {
    const window = createCreditWindow({ capacityBytes: 100 });
    const held = window.acquire(100);
    if (held.outcome !== 'leased') throw new Error('expected the first acquire to lease');

    const order: string[] = [];
    const big = window.acquire(80, {}).then((result) => {
      order.push('big');
      return result;
    });
    const small = window.acquire(10, {}).then((result) => {
      order.push('small');
      return result;
    });

    // Nothing resolves while the window is empty.
    await Promise.resolve();
    expect(order).toEqual([]);
    expect(window.getSnapshot()).toMatchObject({ availableBytes: 0, leasedBytes: 100 });

    held.lease.release();
    expect(await within(big)).toMatchObject({ outcome: 'leased' });
    expect(await within(small)).toMatchObject({ outcome: 'leased' });
    // The 10-byte request could have been served first; arrival order is what was promised.
    expect(order).toEqual(['big', 'small']);
  });

  test('a waiter served out of a partial release does not overtake the one ahead of it', async () => {
    const window = createCreditWindow({ capacityBytes: 100 });
    const first = window.acquire(60);
    const second = window.acquire(40);
    if (first.outcome !== 'leased' || second.outcome !== 'leased') {
      throw new Error('expected both acquires to lease');
    }

    let smallSettled = false;
    const big = window.acquire(70, {});
    const small = window.acquire(20, {}).then((result) => {
      smallSettled = true;
      return result;
    });

    // 40 bytes back is not enough for the 70-byte waiter, and the 20-byte one is behind it.
    second.lease.release();
    await Promise.resolve();
    expect(smallSettled).toBe(false);

    first.lease.release();
    expect(await within(big)).toMatchObject({ outcome: 'leased' });
    expect(await within(small)).toMatchObject({ outcome: 'leased' });
  });

  test('refuses with a distinguishable reason when the wait budget runs out', async () => {
    const window = createCreditWindow({ capacityBytes: 10 });
    const held = window.acquire(10);
    if (held.outcome !== 'leased') throw new Error('expected the first acquire to lease');

    expect(await within(window.acquire(10, { timeoutMs: 5 }))).toEqual({
      outcome: 'refused',
      reason: 'timed-out',
    });
    expect(window.getSnapshot()).toMatchObject({ refused: 1 });

    // The expired waiter is gone: a later release does not try to settle it again.
    held.lease.release();
    expect(window.getSnapshot()).toMatchObject({ availableBytes: 10 });
  });

  test('an aborted signal ends the wait, before and during it', async () => {
    const window = createCreditWindow({ capacityBytes: 10 });
    const held = window.acquire(10);
    if (held.outcome !== 'leased') throw new Error('expected the first acquire to lease');

    const controller = new AbortController();
    const waiting = window.acquire(10, { signal: controller.signal });
    controller.abort();
    expect(await within(waiting)).toEqual({ outcome: 'refused', reason: 'aborted' });

    // An already-aborted signal never creates a waiter at all.
    expect(await within(window.acquire(10, { signal: AbortSignal.abort() }))).toEqual({
      outcome: 'refused',
      reason: 'aborted',
    });

    held.lease.release();
    expect(window.getSnapshot()).toMatchObject({ availableBytes: 10 });
  });

  test('a parked producer is visible, and one wait is one refusal however it ends', async () => {
    const window = createCreditWindow({ capacityBytes: 10 });
    const held = window.acquire(10);
    if (held.outcome !== 'leased') throw new Error('expected the first acquire to lease');

    const controller = new AbortController();
    const waiting = window.acquire(10, { signal: controller.signal, timeoutMs: 20 });
    expect(window.getSnapshot()).toMatchObject({ waiting: 1, refused: 0 });

    controller.abort();
    expect(await within(waiting)).toEqual({ outcome: 'refused', reason: 'aborted' });
    expect(window.getSnapshot()).toMatchObject({ waiting: 0, refused: 1 });

    // The budget it was given expires while nobody is waiting on it any more. An ending that
    // still counts here is a second refusal charged for one wait.
    await new Promise((resolve) => setTimeout(resolve, 40));
    expect(window.getSnapshot()).toMatchObject({ waiting: 0, refused: 1 });
  });

  test('close resolves every pending waiter instead of parking it', async () => {
    const window = createCreditWindow({ capacityBytes: 10 });
    const held = window.acquire(10);
    if (held.outcome !== 'leased') throw new Error('expected the first acquire to lease');

    const first = window.acquire(10, {});
    const second = window.acquire(5, {});
    window.close();

    expect(await within(first)).toEqual({ outcome: 'refused', reason: 'closed' });
    expect(await within(second)).toEqual({ outcome: 'refused', reason: 'closed' });
  });

  test('answers immediately whatever no amount of waiting can change', async () => {
    const window = createCreditWindow({ capacityBytes: 10 });

    // Available credit needs no wait.
    const leased = await window.acquire(4, { timeoutMs: 1 });
    expect(leased.outcome).toBe('leased');

    // A request larger than the window never becomes servable.
    expect(await within(window.acquire(11, {}))).toEqual({
      outcome: 'refused',
      reason: 'larger-than-window',
    });

    window.close();
    expect(await within(window.acquire(1, {}))).toEqual({
      outcome: 'refused',
      reason: 'closed',
    });

    // The non-blocking form is untouched by any of this.
    expect(createCreditWindow({ capacityBytes: 4 }).acquire(8)).toEqual({
      outcome: 'refused',
      reason: 'larger-than-window',
    });
  });
});
