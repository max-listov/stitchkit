import { expect, test } from 'bun:test';
import { sandboxProcessOwner } from '../src/agent-runtime/sandbox-process-owner';
import { startNativeCommand } from '../src/process/command-owner';

test('Sandbox admission waits for both native close and successful owner settlement', async () => {
  const admission = sandboxProcessOwner(() => undefined, 1);
  const hook = Promise.withResolvers<void>();
  const entered = Promise.withResolvers<void>();
  const command = startNativeCommand(
    {
      executable: process.execPath,
      args: ['-e', ''],
      timeoutMs: 1000,
      onLeaderSettled: () => {
        entered.resolve();
        return hook.promise;
      },
    },
    (child) => admission.track(child),
  );
  await entered.promise;
  await new Promise((resolve) => setTimeout(resolve, 30));
  expect(admission.size).toBe(1);
  expect(() => admission.admit()).toThrow('concurrency limit');
  hook.resolve();
  await command.result;
  await admission.stop();
  expect(admission.size).toBe(0);
  expect(() => admission.admit()).not.toThrow();
});

test('Sandbox keeps refused settlement visible to shutdown and admission', async () => {
  const admission = sandboxProcessOwner(() => undefined, 1);
  const command = startNativeCommand(
    {
      executable: process.execPath,
      args: ['-e', ''],
      timeoutMs: 1000,
      onLeaderSettled: () => {
        throw new Error('settlement refused');
      },
    },
    (child) => admission.track(child),
  );
  await expect(command.result).rejects.toMatchObject({ code: 'COMMAND_CLEANUP' });
  await expect(admission.stop()).rejects.toMatchObject({ code: 'COMMAND_CLEANUP' });
  expect(admission.size).toBe(1);
  expect(() => admission.admit()).toThrow('concurrency limit');
});

test('stop after synchronous launch failure propagates cleanup refusal only', async () => {
  for (const refused of [false, true]) {
    const command = startNativeCommand({
      executable: process.execPath,
      args: ['\u0000'],
      timeoutMs: 1000,
      onLeaderSettled: () => {
        if (refused) throw new Error('settlement refused');
      },
    });
    await expect(command.result).rejects.toMatchObject({
      code: refused ? 'COMMAND_CLEANUP' : 'COMMAND_UNAVAILABLE',
    });
    if (refused)
      await expect(command.stop()).rejects.toMatchObject({ code: 'COMMAND_CLEANUP' });
    else await expect(command.stop()).resolves.toBeUndefined();
  }
});
