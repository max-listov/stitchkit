import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { existsSync } from 'node:fs';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { type NativeCommandOptions, runNativeCommand } from '../src/entrypoints/process';
import { NativeCommandOptionsSchema } from '../src/process/contract';
import { reapAfterEachTest, trackGroupLeader } from './support/process-reaper';
import { processAlive } from './support/process-state';
import { until } from './support/until';

const LEADER = fileURLToPath(
  new URL('./fixtures/native-cooperative-leader.mjs', import.meta.url),
);

let dir: string;
reapAfterEachTest();
beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'stitchkit-stop-policy-'));
});
afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

type LeaderMode = 'exit-on-signal' | 'write-on-signal' | 'ignore-signal';

/** Signals recorded by the leader or its member; an absent file means none arrived. */
async function received(who: 'leader' | 'member'): Promise<string[]> {
  const file = join(dir, `${who}-signals`);
  if (!existsSync(file)) return [];
  return (await readFile(file, 'utf8')).split('\n').filter(Boolean);
}

async function memberPid(): Promise<number> {
  return Number(await readFile(join(dir, 'member-pid'), 'utf8'));
}

/** Runs the fixture leader and aborts it once its member is ready, unless it exits by itself. */
async function stopped(mode: LeaderMode, options: Pick<NativeCommandOptions, 'stop'>) {
  const controller = new AbortController();
  const began = { at: 0 };
  const outcome = await runNativeCommand({
    executable: process.execPath,
    args: [LEADER, dir, mode],
    signal: controller.signal,
    onLeaderStarted: trackGroupLeader,
    ...options,
    onOutput: () => {
      began.at = performance.now();
      controller.abort(new Error('stop requested'));
    },
  }).then(
    (result) => ({ result, error: undefined }),
    (error: unknown) => ({ result: undefined, error }),
  );
  return { ...outcome, elapsedMs: performance.now() - began.at };
}

describe('stop policy of a native command', () => {
  test("stop target 'leader' signals only the leader, ends the grace when it exits and kills the member left behind", async () => {
    const { error, elapsedMs } = await stopped('exit-on-signal', {
      stop: { target: 'leader', signal: 'SIGINT', graceMs: 60_000 },
    });
    expect(error).toMatchObject({ message: 'stop requested' });
    expect(await received('leader')).toEqual(['SIGINT']);
    expect(await received('member')).toEqual([]);
    const member = await memberPid();
    await until(() => !processAlive(member), 'the member to be killed with the group');
    // The leader's exit ended a one-minute grace.
    expect(elapsedMs).toBeLessThan(10_000);
  }, 20_000);

  test('a leader writing through its grace keeps an open output pipe and exits on its own', async () => {
    const { error, elapsedMs } = await stopped('write-on-signal', {
      stop: { target: 'leader', signal: 'SIGTERM', graceMs: 60_000 },
    });
    expect(error).toMatchObject({ message: 'stop requested' });
    expect(await received('leader')).toEqual(['SIGTERM', 'flushed']);
    expect(elapsedMs).toBeLessThan(10_000);
  }, 20_000);

  test("stop target 'group' signals every member, the control for the leader-only case", async () => {
    const { error } = await stopped('exit-on-signal', {
      stop: { target: 'group', signal: 'SIGINT', graceMs: 200 },
    });
    expect(error).toMatchObject({ message: 'stop requested' });
    expect(await received('leader')).toEqual(['SIGINT']);
    await until(
      async () => (await received('member')).length > 0,
      'the member to record SIGINT',
    );
    expect(await received('member')).toEqual(['SIGINT']);
    const member = await memberPid();
    await until(() => !processAlive(member), 'the member to be killed after the grace');
  }, 20_000);

  test('a leader that ignores the signal is killed with its group once the grace ends', async () => {
    const { error, elapsedMs } = await stopped('ignore-signal', {
      stop: { target: 'leader', signal: 'SIGTERM', graceMs: 300 },
    });
    expect(error).toMatchObject({ message: 'stop requested' });
    expect(await received('leader')).toEqual(['SIGTERM']);
    expect(await received('member')).toEqual([]);
    expect(elapsedMs).toBeGreaterThanOrEqual(280);
    const member = await memberPid();
    await until(() => !processAlive(member), 'the member to be killed after the grace');
  }, 20_000);

  test('an abort of killOn ends a running one-hour grace at once with KILL to the whole group', async () => {
    const controller = new AbortController();
    const kill = new AbortController();
    const command = runNativeCommand({
      executable: process.execPath,
      args: [LEADER, dir, 'ignore-signal'],
      signal: controller.signal,
      onLeaderStarted: trackGroupLeader,
      stop: { target: 'leader', graceMs: 3_600_000, killOn: kill.signal },
      onOutput: () => controller.abort(new Error('stop requested')),
    }).catch((error: unknown) => error);
    // The grace is running: the leader has its signal and is still alive.
    await until(
      async () => (await received('leader')).length > 0,
      'the leader to get SIGTERM',
    );
    kill.abort(new Error('shutdown budget spent'));
    expect(await command).toMatchObject({ message: 'stop requested' });
    expect(await received('member')).toEqual([]);
    const member = await memberPid();
    await until(() => !processAlive(member), 'the member to be killed at once');
  }, 20_000);

  test("terminate-after-leader with stop target 'leader' kills a member with closed stdio, without asking it first", async () => {
    const result = await runNativeCommand({
      executable: process.execPath,
      args: [LEADER, dir, 'exit-when-ready'],
      timeoutMs: 10_000,
      onLeaderStarted: trackGroupLeader,
      descendants: 'terminate-after-leader',
      stop: { target: 'leader', signal: 'SIGTERM', graceMs: 60_000 },
    });
    expect(result.exitCode).toBe(0);
    const member = await memberPid();
    await until(() => !processAlive(member), 'the member left behind to be killed');
    expect(await received('member')).toEqual([]);
  }, 20_000);

  test('the policy refuses a signal that is not cooperative and a grace past one hour', () => {
    const base = { executable: process.execPath, timeoutMs: 1000 };
    for (const stop of [
      { target: 'leader', signal: 'SIGKILL', graceMs: 10 },
      { target: 'leader', graceMs: 3_600_001 },
      { target: 'everyone', graceMs: 10 },
      { graceMs: 10 },
    ])
      expect(NativeCommandOptionsSchema.safeParse({ ...base, stop }).success).toBe(false);
    expect(NativeCommandOptionsSchema.parse(base).stop).toEqual({
      target: 'group',
      signal: 'SIGTERM',
      graceMs: 100,
    });
    expect(
      NativeCommandOptionsSchema.parse({
        ...base,
        stop: { target: 'leader', graceMs: 900_000 },
      }).stop,
    ).toEqual({ target: 'leader', signal: 'SIGTERM', graceMs: 900_000 });
  });

  test('an already aborted killOn refuses to start the command', () => {
    const kill = new AbortController();
    kill.abort(new Error('shutting down'));
    expect(() =>
      runNativeCommand({
        executable: process.execPath,
        args: [LEADER, dir, 'exit-when-ready'],
        timeoutMs: 1000,
        stop: { target: 'leader', graceMs: 10, killOn: kill.signal },
      }),
    ).toThrow('shutting down');
    expect(existsSync(join(dir, 'member-pid'))).toBe(false);
  });
});
