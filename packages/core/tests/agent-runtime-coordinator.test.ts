import { describe, expect, test } from 'bun:test';
import { createAgentSessionCoordinator } from '../src/agent-runtime';

describe('agent session coordinator', () => {
  test('preserves pending input order without overlapping the active lane', async () => {
    const coordinator = createAgentSessionCoordinator();
    const release = Promise.withResolvers<void>();
    const order: string[] = [];
    const submit = (runId: string, wait = false) =>
      coordinator.submit({
        key: 'ordered-conversation',
        policy: 'queue',
        create: () => ({
          runId,
          async execute() {
            order.push(`${runId}:start`);
            if (wait) await release.promise;
            order.push(`${runId}:end`);
            return runId;
          },
        }),
      });
    const first = submit('run-1', true);
    await first.accepted;
    const second = submit('run-2');
    const third = submit('run-3');
    expect(order).toEqual(['run-1:start']);
    release.resolve();
    await Promise.all([first.result, second.result, third.result]);
    expect(order).toEqual([
      'run-1:start',
      'run-1:end',
      'run-2:start',
      'run-2:end',
      'run-3:start',
      'run-3:end',
    ]);
  });

  test('interrupt requests abort but successor waits for actual settlement', async () => {
    const coordinator = createAgentSessionCoordinator();
    const firstRelease = Promise.withResolvers<void>();
    let firstSignal: AbortSignal | undefined;
    let secondStarted = false;

    const first = coordinator.submit({
      key: 'conversation-1',
      policy: 'queue',
      create(signal) {
        firstSignal = signal;
        return {
          runId: 'run-1',
          async execute() {
            await firstRelease.promise;
            return 'first';
          },
        };
      },
    });
    await first.accepted;

    const second = coordinator.submit({
      key: 'conversation-1',
      policy: 'interrupt',
      create() {
        secondStarted = true;
        return { runId: 'run-2', execute: async () => 'second' };
      },
    });
    expect(firstSignal?.aborted).toBeTrue();
    expect(secondStarted).toBeFalse();

    firstRelease.resolve();
    await first.result;
    await second.accepted;
    expect(secondStarted).toBeTrue();
    expect(await second.result).toBe('second');
  });

  test('interrupt-next settles the active run then precedes ordinary pending work', async () => {
    const coordinator = createAgentSessionCoordinator();
    const release = Promise.withResolvers<void>();
    const aborted = Promise.withResolvers<void>();
    const order: string[] = [];
    const first = coordinator.submit({
      key: 'priority-conversation',
      policy: 'queue',
      create: (signal) => ({
        runId: 'A',
        async execute() {
          order.push('A');
          signal.addEventListener('abort', () => aborted.resolve(), { once: true });
          await release.promise;
        },
      }),
    });
    await first.accepted;
    const ordinary = coordinator.submit({
      key: 'priority-conversation',
      policy: 'queue',
      create: () => ({ runId: 'B', execute: async () => void order.push('B') }),
    });
    const urgent = coordinator.submit({
      key: 'priority-conversation',
      policy: 'interrupt-next',
      create: () => ({ runId: 'C', execute: async () => void order.push('C') }),
    });

    await aborted.promise;
    expect(order).toEqual(['A']);
    release.resolve();
    await Promise.all([first.result, ordinary.result, urgent.result]);
    expect(order).toEqual(['A', 'C', 'B']);
    await coordinator.close();
  });

  test('interrupt-next preserves FIFO among urgent submissions', async () => {
    const coordinator = createAgentSessionCoordinator();
    const release = Promise.withResolvers<void>();
    const order: string[] = [];
    const first = coordinator.submit({
      key: 'priority-fifo',
      policy: 'queue',
      create: () => ({
        runId: 'A',
        async execute() {
          order.push('A');
          await release.promise;
        },
      }),
    });
    await first.accepted;
    const ordinary = coordinator.submit({
      key: 'priority-fifo',
      policy: 'queue',
      create: () => ({ runId: 'B', execute: async () => void order.push('B') }),
    });
    const firstUrgent = coordinator.submit({
      key: 'priority-fifo',
      policy: 'interrupt-next',
      create: () => ({ runId: 'C', execute: async () => void order.push('C') }),
    });
    const secondUrgent = coordinator.submit({
      key: 'priority-fifo',
      policy: 'interrupt-next',
      create: () => ({ runId: 'D', execute: async () => void order.push('D') }),
    });

    release.resolve();
    await Promise.all([
      first.result,
      ordinary.result,
      firstUrgent.result,
      secondUrgent.result,
    ]);
    expect(order).toEqual(['A', 'C', 'D', 'B']);
    await coordinator.close();
  });

  test('close drains an active run before using the shutdown abort', async () => {
    const coordinator = createAgentSessionCoordinator();
    const release = Promise.withResolvers<void>();
    let signal: AbortSignal | undefined;
    const ticket = coordinator.submit({
      key: 'conversation-drain',
      policy: 'queue',
      create(runSignal) {
        signal = runSignal;
        return {
          runId: 'run-drain',
          async execute() {
            await release.promise;
            return 'completed';
          },
        };
      },
    });
    await ticket.accepted;

    const closing = coordinator.close({ gracePeriodMs: 1_000, forceTimeoutMs: 1_000 });
    await Promise.resolve();
    expect(signal?.aborted).toBeFalse();
    release.resolve();

    await closing;
    expect(await ticket.result).toBe('completed');
    expect(signal?.aborted).toBeFalse();
  });

  test('close aborts with shutdown only after the drain budget expires', async () => {
    const coordinator = createAgentSessionCoordinator();
    let abortReason: unknown;
    const ticket = coordinator.submit({
      key: 'conversation-force',
      policy: 'queue',
      create(signal) {
        return {
          runId: 'run-force',
          execute: () =>
            new Promise<string>((resolve) => {
              signal.addEventListener(
                'abort',
                () => {
                  abortReason = signal.reason;
                  resolve('settled-after-abort');
                },
                { once: true },
              );
            }),
        };
      },
    });
    await ticket.accepted;

    await coordinator.close({ gracePeriodMs: 0, forceTimeoutMs: 1_000 });

    expect(abortReason).toBe('shutdown');
    expect(await ticket.result).toBe('settled-after-abort');
  });

  test('force timeout bounds a non-cooperative active run and closes admission', async () => {
    const coordinator = createAgentSessionCoordinator();
    const ticket = coordinator.submit({
      key: 'conversation-hung',
      policy: 'queue',
      create: () => ({
        runId: 'run-hung',
        execute: () => new Promise<string>(() => undefined),
      }),
    });
    await ticket.accepted;

    await coordinator.close({ gracePeriodMs: 0, forceTimeoutMs: 0 });
    const rejected = coordinator.submit({
      key: 'conversation-after-close',
      policy: 'queue',
      create: () => ({ runId: 'run-never', execute: async () => 'never' }),
    });
    void rejected.result.catch(() => undefined);

    await expect(rejected.accepted).rejects.toThrow('coordinator is closed');
  });
});

describe('close() bounds itself in every combination of budgets', () => {
  test('a force budget alone is honoured — no branch used to read it', async () => {
    const coordinator = createAgentSessionCoordinator();
    const ticket = coordinator.submit({
      key: 'force-only',
      policy: 'queue',
      create() {
        return {
          runId: 'run-force-only',
          // Ignores the abort entirely: only the force budget can end the wait.
          execute: () => new Promise<string>(() => undefined),
        };
      },
    });
    await ticket.accepted;

    const started = performance.now();
    await coordinator.close({ forceTimeoutMs: 40 });
    const elapsed = performance.now() - started;

    expect(elapsed).toBeGreaterThanOrEqual(20);
    expect(elapsed).toBeLessThan(2_000);
  });

  test('naming a grace budget never returns earlier than naming none', async () => {
    // The trap: `close({ drainTimeoutMs })` aborted and returned without
    // awaiting settlement, so asking for a budget gave a weaker guarantee than
    // asking for nothing at all. Both forms must settle before returning.
    for (const options of [{}, { gracePeriodMs: 10 }]) {
      const coordinator = createAgentSessionCoordinator();
      let settled = false;
      const ticket = coordinator.submit({
        key: 'grace-vs-none',
        policy: 'queue',
        create(signal) {
          return {
            runId: 'run-grace-vs-none',
            execute: () =>
              new Promise<string>((resolve) => {
                // Settles a tick AFTER the abort on purpose: a `close()` that
                // returns as soon as it has aborted would observe `settled ===
                // false`, which is exactly the guarantee being pinned.
                signal.addEventListener(
                  'abort',
                  () => {
                    setTimeout(() => {
                      settled = true;
                      resolve('settled-after-abort');
                    }, 15);
                  },
                  { once: true },
                );
              }),
          };
        },
      });
      await ticket.accepted;

      await coordinator.close(options);
      expect(settled).toBe(true);
      expect(await ticket.result).toBe('settled-after-abort');
    }
  });
});

describe('close() reports what it achieved', () => {
  /**
   * The contract used to be three sentences that cannot all hold: "every
   * combination is bounded", "omit `forceTimeoutMs` and it waits for
   * settlement", and "`close()` never returns while a run is still in flight".
   * The table below is the contract now — one row per combination of budgets,
   * each saying exactly what the caller gets back.
   */
  function stubbornRun(coordinator: ReturnType<typeof createAgentSessionCoordinator>) {
    return coordinator.submit({
      key: 'stubborn',
      policy: 'queue',
      create() {
        return {
          runId: 'run-stubborn',
          // Ignores the abort: whether close() waits or gives up is then the
          // only thing that decides what it returns.
          execute: () => new Promise<string>(() => undefined),
        };
      },
    });
  }

  test('a force budget that expires returns timedOut with a count, not a promise of settlement', async () => {
    const coordinator = createAgentSessionCoordinator();
    await stubbornRun(coordinator).accepted;

    const result = await coordinator.close({ forceTimeoutMs: 20 });

    expect(result).toEqual({ settled: false, timedOut: true, remaining: 1 });
  });

  test('the count is the number of runs still in flight, not a boolean in disguise', async () => {
    const coordinator = createAgentSessionCoordinator();
    for (const key of ['one', 'two', 'three']) {
      const ticket = coordinator.submit({
        key,
        policy: 'queue',
        create: () => ({
          runId: `run-${key}`,
          execute: () => new Promise<string>(() => undefined),
        }),
      });
      await ticket.accepted;
    }

    expect(await coordinator.close({ forceTimeoutMs: 20 })).toEqual({
      settled: false,
      timedOut: true,
      remaining: 3,
    });
  });

  test('a run that settles inside the grace budget is settled, and nothing is forced', async () => {
    const coordinator = createAgentSessionCoordinator();
    const ticket = coordinator.submit({
      key: 'quick',
      policy: 'queue',
      create: () => ({
        runId: 'run-quick',
        execute: async () => {
          await Bun.sleep(5);
          return 'done';
        },
      }),
    });
    await ticket.accepted;

    expect(await coordinator.close({ gracePeriodMs: 500, forceTimeoutMs: 500 })).toEqual({
      settled: true,
      timedOut: false,
      remaining: 0,
    });
    expect(await ticket.result).toBe('done');
  });

  test('a cooperative run aborted after the grace budget still settles', async () => {
    const coordinator = createAgentSessionCoordinator();
    const ticket = coordinator.submit({
      key: 'cooperative',
      policy: 'queue',
      create: (signal) => ({
        runId: 'run-cooperative',
        execute: () =>
          new Promise<string>((resolve) => {
            signal.addEventListener('abort', () => resolve('aborted'), { once: true });
          }),
      }),
    });
    await ticket.accepted;

    expect(await coordinator.close({ gracePeriodMs: 10, forceTimeoutMs: 500 })).toEqual({
      settled: true,
      timedOut: false,
      remaining: 0,
    });
  });

  test('with no force budget the wait is unbounded — the one case that cannot time out', async () => {
    const coordinator = createAgentSessionCoordinator();
    const ticket = coordinator.submit({
      key: 'slow-but-cooperative',
      policy: 'queue',
      create: (signal) => ({
        runId: 'run-slow',
        execute: () =>
          new Promise<string>((resolve) => {
            signal.addEventListener('abort', () => setTimeout(() => resolve('late'), 30), {
              once: true,
            });
          }),
      }),
    });
    await ticket.accepted;

    expect(await coordinator.close()).toEqual({
      settled: true,
      timedOut: false,
      remaining: 0,
    });
    expect(await ticket.result).toBe('late');
  });

  test('closing an idle coordinator is settled with nothing remaining', async () => {
    const coordinator = createAgentSessionCoordinator();
    expect(await coordinator.close({ forceTimeoutMs: 0 })).toEqual({
      settled: true,
      timedOut: false,
      remaining: 0,
    });
  });
});
