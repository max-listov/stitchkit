import { expect, test } from 'bun:test';
import { getEventListeners } from 'node:events';
import { runNativeCommand } from '../src/process/command';
import { NativeCommandError } from '../src/process/contract';

test.skipIf(process.platform !== 'linux')(
  'real synchronous E2BIG settles once before rejecting and preserves the native cause',
  async () => {
    for (const oversized of [false, true]) {
      const controller = new AbortController();
      let calls = 0;
      let settled = false;
      let nativeCause: unknown;
      const pending = runNativeCommand({
        executable: process.execPath,
        args: ['-e', '', ...(oversized ? ['x'.repeat(200_000)] : [])],
        signal: controller.signal,
        timeoutMs: 1000,
        onLeaderSettled: async (event) => {
          calls++;
          if (event.kind === 'error') nativeCause = event.cause;
          await new Promise((resolve) => setTimeout(resolve, 10));
          settled = true;
        },
      });
      if (oversized) {
        const error = await pending.catch((cause: unknown) => cause);
        expect(error).toBeInstanceOf(NativeCommandError);
        if (!(error instanceof NativeCommandError)) throw error;
        expect(error.code).toBe('COMMAND_UNAVAILABLE');
        expect(error.cause).toBe(nativeCause);
        expect(nativeCause).toMatchObject({ code: 'E2BIG' });
      } else {
        expect((await pending).exitCode).toBe(0);
      }
      expect(calls).toBe(1);
      expect(settled).toBe(true);
      expect(getEventListeners(controller.signal, 'abort')).toHaveLength(0);
    }
  },
);

test('synchronous launch failure bounds a hanging hook and retains both failure causes', async () => {
  let calls = 0;
  const started = performance.now();
  const error = await runNativeCommand({
    executable: process.execPath,
    args: ['\u0000'],
    timeoutMs: 1000,
    cleanupTimeoutMs: 25,
    onLeaderSettled: () => {
      calls++;
      return new Promise(() => undefined);
    },
  }).catch((cause: unknown) => cause);
  expect(error).toBeInstanceOf(NativeCommandError);
  if (!(error instanceof NativeCommandError)) throw error;
  expect(error.code).toBe('COMMAND_CLEANUP');
  expect(error.cause).toBeInstanceOf(AggregateError);
  if (!(error.cause instanceof AggregateError)) throw error;
  expect(error.cause.errors[0]).toMatchObject({ code: 'COMMAND_UNAVAILABLE' });
  expect(error.cause.errors[1]).toMatchObject({ code: 'COMMAND_CLEANUP' });
  expect(calls).toBe(1);
  expect(performance.now() - started).toBeLessThan(500);
});

test('schema refusal and pre-abort do not acquire a native settlement obligation', () => {
  let calls = 0;
  const onLeaderSettled = () => {
    calls++;
  };
  expect(() => runNativeCommand({ executable: '', timeoutMs: 1, onLeaderSettled })).toThrow();
  const controller = new AbortController();
  controller.abort(new Error('pre-abort'));
  expect(() =>
    runNativeCommand({
      executable: process.execPath,
      signal: controller.signal,
      onLeaderSettled,
    }),
  ).toThrow('pre-abort');
  expect(calls).toBe(0);
});

test('a throwing start-failure hook retains its exact error alongside the original syscall', async () => {
  const cleanupFailure = new Error('external resource cleanup refused');
  let calls = 0;
  const failure = await runNativeCommand({
    executable: process.execPath,
    args: process.platform === 'linux' ? ['x'.repeat(200_000)] : ['\u0000'],
    timeoutMs: 1000,
    onLeaderSettled: () => {
      calls++;
      throw cleanupFailure;
    },
  }).catch((error: unknown) => error);
  expect(failure).toBeInstanceOf(NativeCommandError);
  if (!(failure instanceof NativeCommandError) || !(failure.cause instanceof AggregateError))
    throw failure;
  const [original, cleanup] = failure.cause.errors;
  expect(original).toBeInstanceOf(NativeCommandError);
  if (!(original instanceof NativeCommandError)) throw original;
  expect(original.code).toBe('COMMAND_UNAVAILABLE');
  if (process.platform === 'linux') expect(original.cause).toMatchObject({ code: 'E2BIG' });
  if (!(cleanup instanceof NativeCommandError) || !(cleanup.cause instanceof AggregateError))
    throw cleanup;
  expect(cleanup.cause.errors).toContain(cleanupFailure);
  expect(calls).toBe(1);
});
