import { expect, test } from 'bun:test';
import { runNativeCommand } from '../src/entrypoints/process';
import { hasLiveGroupMember, waitForProcessGroupExit } from '../src/process/group-settlement';
import { reapAfterEachTest, trackGroupLeader } from './support/process-reaper';

reapAfterEachTest();

test('group settlement distinguishes running members, zombies and unrelated processes', () => {
  expect(hasLiveGroupMember(' 123 Z\n 123 Zs\n 456 R\n', 123)).toBe(false);
  expect(hasLiveGroupMember(' 123 Z\n 123 S+\n 456 R\n', 123)).toBe(true);
  expect(hasLiveGroupMember(' 123 X\n 456 S\n', 123)).toBe(false);
  expect(() => hasLiveGroupMember('ps observation failed', 123)).toThrow(
    'Invalid process group observation',
  );
});

test('an exhausted group cleanup deadline is refused, not reported as a completed stop', async () => {
  await expect(waitForProcessGroupExit(123, performance.now() - 1)).rejects.toThrow(
    'remained alive',
  );
});

test('force, killOn and early leader exit do not lend the skipped grace to cleanup', async () => {
  const result = await runNativeCommand({
    executable: process.execPath,
    args: [`${import.meta.dir}/fixtures/group-settlement-budget-probe.ts`],
    timeoutMs: 2000,
    capture: true,
    maxOutputBytes: 4096,
    onLeaderStarted: trackGroupLeader,
  });
  expect(result.exitCode).toBe(0);
  expect(new TextDecoder().decode(result.stdout)).toContain('bounded group settlement: ok');
});
