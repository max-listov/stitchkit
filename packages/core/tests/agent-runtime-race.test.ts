import { describe, expect, test } from 'bun:test';
import { createAgentSessionCoordinator } from '../src/agent-runtime';
import { createAgentRaceDriver, createAgentRaceTrace } from '../src/testing';

describe('deterministic agent race harness', () => {
  test('proves abort request, actual settlement and successor admission order', async () => {
    const driver = createAgentRaceDriver();
    const predecessor = driver.barrier('predecessor');
    const coordinator = createAgentSessionCoordinator();
    const first = coordinator.submit({
      key: 'conversation-1',
      policy: 'queue',
      create: (signal) => ({
        runId: 'run-1',
        async execute() {
          driver.trace.record('predecessor-started');
          await predecessor.wait();
          driver.trace.record(
            signal.aborted ? 'predecessor-aborted' : 'predecessor-completed',
          );
          return 'first';
        },
      }),
    });
    await first.accepted;
    const second = coordinator.submit({
      key: 'conversation-1',
      policy: 'interrupt',
      create: () => ({
        runId: 'run-2',
        execute: async () => {
          driver.trace.record('successor-started');
          return 'second';
        },
      }),
    });
    await predecessor.reached;
    expect(driver.trace.count('successor-started')).toBe(0);
    predecessor.release();
    await Promise.all([first.result, second.result]);

    driver.trace.assertSequence([
      'predecessor-started',
      'predecessor-aborted',
      'successor-started',
    ]);
  });

  test('broken partial orders fail with the intended diagnostic', () => {
    const trace = createAgentRaceTrace();
    trace.record('terminal-commit');
    trace.record('tool-effect');
    expect(() => trace.assertBefore('tool-effect', 'terminal-commit')).toThrow(
      'Expected tool-effect before terminal-commit',
    );
    expect(() => trace.assertSequence(['tool-effect', 'terminal-commit'])).toThrow(
      'received terminal-commit -> tool-effect',
    );
  });

  test('never-settling barriers have bounded teardown', async () => {
    const driver = createAgentRaceDriver(5);
    await expect(driver.barrier('never').wait()).rejects.toThrow('teardown bound');
    driver.releaseAll();
  });
});
