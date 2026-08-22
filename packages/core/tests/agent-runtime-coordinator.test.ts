import { describe, expect, test } from 'bun:test';
import { createAgentSessionCoordinator } from '../src/agent-runtime';

describe('agent session coordinator', () => {
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

    const closing = coordinator.close({ drainTimeoutMs: 1_000, forceTimeoutMs: 1_000 });
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

    await coordinator.close({ drainTimeoutMs: 0, forceTimeoutMs: 1_000 });

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

    await coordinator.close({ drainTimeoutMs: 0, forceTimeoutMs: 0 });
    const rejected = coordinator.submit({
      key: 'conversation-after-close',
      policy: 'queue',
      create: () => ({ runId: 'run-never', execute: async () => 'never' }),
    });
    void rejected.result.catch(() => undefined);

    await expect(rejected.accepted).rejects.toThrow('coordinator is closed');
  });
});
