/**
 * The runtime facts ADR 0244 stands on: Bun exposes no point where an
 * asynchronous continuation starts or ends, so CPU cannot be attributed to an
 * operation by synchronous segment, and stitchkit attributes none.
 *
 * These assertions describe Bun, not stitchkit. When one turns red, Bun has
 * gained the hook the decision says is missing: re-open ADR 0244 instead of
 * adjusting the expectation.
 */
import { describe, expect, test } from 'bun:test';
import { AsyncLocalStorage, createHook, executionAsyncId } from 'node:async_hooks';

const settleMacrotask = () => new Promise<void>((resolve) => setImmediate(resolve));

describe('ADR 0244 — Bun has no async segment boundary', () => {
  test('async_hooks.createHook accepts callbacks and delivers none', async () => {
    const delivered: string[] = [];
    const hook = createHook({
      init: (_id, type) => delivered.push(`init:${type}`),
      before: () => delivered.push('before'),
      after: () => delivered.push('after'),
      promiseResolve: () => delivered.push('promiseResolve'),
    });
    hook.enable();
    try {
      await settleMacrotask();
      await Promise.resolve();
      await new Promise<void>((resolve) => setTimeout(resolve, 0));
    } finally {
      hook.disable();
    }
    expect(delivered).toEqual([]);
  });

  test('executionAsyncId does not distinguish one continuation from another', async () => {
    const ids: number[] = [executionAsyncId()];
    await settleMacrotask();
    ids.push(executionAsyncId());
    await Promise.resolve();
    ids.push(executionAsyncId());
    expect(new Set(ids)).toEqual(new Set([0]));
  });

  test('AsyncLocalStorage carries the store across awaits without announcing the switch', async () => {
    const storage = new AsyncLocalStorage<string>();
    const seen = await storage.run('operation', async () => {
      await settleMacrotask();
      return storage.getStore();
    });
    // The store propagates — which is all AsyncLocalStorage promises — but
    // nothing runs when the continuation is entered or left, so it cannot
    // bracket a synchronous segment with a CPU reading.
    expect(seen).toBe('operation');
  });

  test('a native await never calls Promise.prototype.then, so a library cannot wrap it', async () => {
    const original = Promise.prototype.then;
    let calls = 0;
    Promise.prototype.then = function then<TResult1, TResult2 = never>(
      this: Promise<unknown>,
      onFulfilled?: ((value: unknown) => TResult1 | PromiseLike<TResult1>) | null,
      onRejected?: ((reason: unknown) => TResult2 | PromiseLike<TResult2>) | null,
    ): Promise<TResult1 | TResult2> {
      calls += 1;
      return original.call<
        Promise<unknown>,
        [typeof onFulfilled, typeof onRejected],
        Promise<TResult1 | TResult2>
      >(this, onFulfilled, onRejected);
    };
    try {
      const work = async () => {
        await settleMacrotask();
        await Promise.resolve(1);
      };
      calls = 0;
      await work();
    } finally {
      Promise.prototype.then = original;
    }
    expect(calls).toBe(0);
  });
});
