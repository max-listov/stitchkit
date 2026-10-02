import assert from 'node:assert/strict';
import { getEventListeners } from 'node:events';
import { NativeCommandError, runNativeCommand } from 'stitchkit/process';

export async function verifyNativeStartFailure() {
  if (process.platform === 'linux') {
    for (const oversized of [false, true]) {
      const controller = new AbortController();
      let calls = 0;
      let completed = false;
      let nativeCause;
      const pending = runNativeCommand({
        executable: process.execPath,
        args: ['-e', '', ...(oversized ? ['x'.repeat(200_000)] : [])],
        timeoutMs: 2000,
        signal: controller.signal,
        onLeaderSettled: async (event) => {
          calls++;
          if (event.kind === 'error') nativeCause = event.cause;
          await new Promise((resolve) => setTimeout(resolve, 10));
          completed = true;
        },
      });
      if (oversized) {
        await assert.rejects(
          pending,
          (error) =>
            error instanceof NativeCommandError &&
            error.code === 'COMMAND_UNAVAILABLE' &&
            error.cause === nativeCause &&
            nativeCause.code === 'E2BIG',
        );
      } else assert.equal((await pending).exitCode, 0);
      assert.equal(calls, 1);
      assert.equal(completed, true);
      assert.equal(getEventListeners(controller.signal, 'abort').length, 0);
    }
  }
  let hanging = 0;
  await assert.rejects(
    runNativeCommand({
      executable: process.execPath,
      args: ['\0'],
      timeoutMs: 2000,
      cleanupTimeoutMs: 25,
      onLeaderSettled: () => {
        hanging++;
        return new Promise(() => undefined);
      },
    }),
    (error) =>
      error instanceof NativeCommandError &&
      error.code === 'COMMAND_CLEANUP' &&
      error.cause instanceof AggregateError &&
      error.cause.errors[0].code === 'COMMAND_UNAVAILABLE' &&
      error.cause.errors[1].code === 'COMMAND_CLEANUP',
  );
  assert.equal(hanging, 1);
  let calls = 0;
  const onLeaderSettled = () => {
    calls++;
  };
  assert.throws(() => runNativeCommand({ executable: '', timeoutMs: 1, onLeaderSettled }));
  const controller = new AbortController();
  const cause = new Error('pre-abort');
  controller.abort(cause);
  assert.throws(
    () =>
      runNativeCommand({
        executable: process.execPath,
        signal: controller.signal,
        onLeaderSettled,
      }),
    (error) => error === cause,
  );
  assert.equal(calls, 0);
}
