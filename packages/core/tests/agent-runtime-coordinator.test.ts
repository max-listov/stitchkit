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
});
