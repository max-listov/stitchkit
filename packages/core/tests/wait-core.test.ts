/**
 * The shared poll-until-done engine (`pollUntil`) behind both the CLI `--wait`
 * and the native `mountWait` MCP tool. Locks in the backoff schedule (with the
 * last entry repeating), the poll-before-sleep ordering, the timeout boundary
 * and the `onTick` semantics — all driven by an injected `sleepFn` so the test
 * never waits real time.
 */
import { describe, expect, test } from 'bun:test';
import { pollUntil } from '../src/tools/wait-core';

describe('pollUntil — backoff & ordering', () => {
  test('done on the first poll → no sleep, one poll, not timed out', async () => {
    let calls = 0;
    const sleeps: number[] = [];
    const result = await pollUntil<number>({
      poll: async () => ++calls,
      done: () => true,
      sleepFn: async (ms) => void sleeps.push(ms),
    });
    expect(calls).toBe(1);
    expect(sleeps).toEqual([]);
    expect(result).toEqual({ state: 1, timedOut: false });
  });

  test('default backoff schedule is consumed, last entry repeats', async () => {
    let calls = 0;
    const sleeps: number[] = [];
    const result = await pollUntil<number>({
      poll: async () => ++calls,
      done: (n) => n >= 8,
      sleepFn: async (ms) => void sleeps.push(ms),
    });
    // 8 polls → 7 sleeps; [2,3,5,5,8,10] then 10 repeats for the 7th.
    expect(calls).toBe(8);
    expect(sleeps).toEqual([2000, 3000, 5000, 5000, 8000, 10000, 10000]);
    expect(result).toEqual({ state: 8, timedOut: false });
  });

  test('a custom backoff repeats its last entry', async () => {
    let calls = 0;
    const sleeps: number[] = [];
    await pollUntil<number>({
      poll: async () => ++calls,
      done: (n) => n >= 4,
      backoff: [1, 2],
      sleepFn: async (ms) => void sleeps.push(ms),
    });
    expect(sleeps).toEqual([1000, 2000, 2000]);
  });

  test('an empty backoff falls back to the default', async () => {
    let calls = 0;
    const sleeps: number[] = [];
    await pollUntil<number>({
      poll: async () => ++calls,
      done: (n) => n >= 2,
      backoff: [],
      sleepFn: async (ms) => void sleeps.push(ms),
    });
    expect(sleeps).toEqual([2000]);
  });

  test('timeout returns the last state, timedOut true', async () => {
    let calls = 0;
    const result = await pollUntil<number>({
      poll: async () => ++calls,
      done: () => false,
      timeoutSec: 0, // elapsed >= 0 after the first non-terminal poll
      sleepFn: async () => undefined,
    });
    expect(result.timedOut).toBe(true);
    expect(result.state).toBe(1);
    expect(calls).toBe(1);
  });

  test('onTick fires only after non-terminal polls, never after the terminal one', async () => {
    let calls = 0;
    const ticks: number[] = [];
    await pollUntil<number>({
      poll: async () => ++calls,
      done: (n) => n >= 3,
      sleepFn: async () => undefined,
      onTick: (attempt) => ticks.push(attempt),
    });
    expect(ticks).toEqual([1, 2]); // polls 1 & 2 non-terminal, poll 3 terminal
    expect(calls).toBe(3);
  });

  test('polls before it sleeps (a rejecting poll never reaches a sleep)', async () => {
    const order: string[] = [];
    await expect(
      pollUntil<number>({
        poll: async () => {
          order.push('poll');
          throw new Error('boom');
        },
        done: () => false,
        sleepFn: async () => void order.push('sleep'),
      }),
    ).rejects.toThrow('boom');
    expect(order).toEqual(['poll']); // threw on the first poll, before any sleep
  });
});
