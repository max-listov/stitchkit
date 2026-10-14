import { mock } from 'bun:test';

const budgets: number[] = [];
mock.module('../../src/process/group-settlement', () => ({
  waitForProcessGroupExit: async (_pid: number, deadline: number) => {
    budgets.push(deadline - performance.now());
  },
}));
const { stopCommandGroup, stopCommandLeader } = await import('../../src/process/group');
const realKill = process.kill;
process.kill = () => true;
try {
  const policy = { target: 'group', signal: 'SIGTERM', graceMs: 3_600_000 } satisfies {
    target: 'group';
    signal: 'SIGTERM';
    graceMs: number;
  };
  await stopCommandGroup({ pid: 123, policy, cleanupTimeoutMs: 2000, force: true });
  const controller = new AbortController();
  controller.abort();
  await stopCommandGroup({
    pid: 123,
    policy: { ...policy, killOn: controller.signal },
    cleanupTimeoutMs: 2000,
    force: false,
  });
  await stopCommandLeader({
    pid: 123,
    policy: { ...policy, target: 'leader' },
    cleanupTimeoutMs: 2000,
    force: false,
    leader: { pid: 123, exitCode: null, signalCode: null },
    leaderExit: Promise.resolve(),
  });
  if (budgets.length !== 3 || budgets.some((budget) => budget <= 0 || budget > 2000))
    throw new Error(`Invalid cleanup budgets: ${JSON.stringify(budgets)}`);
  console.log('bounded group settlement: ok');
} finally {
  process.kill = realKill;
}
