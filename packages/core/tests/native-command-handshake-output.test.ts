import { expect, test } from 'bun:test';
import { PassThrough } from 'node:stream';
import { startNativeCommand } from '../src/process/command-owner';
import { spawnOwnedCommand } from '../src/process/owned-child';
import { attachOwnerLossControl } from '../src/process/owner-loss-control';
import { reapAfterEachTest, trackProcess } from './support/process-reaper';

reapAfterEachTest();

function targetBeforeHandshake() {
  const child = spawnOwnedCommand({
    executable: '/bin/echo',
    args: ['before-handshake'],
    group: true,
  });
  trackProcess(child.pid);
  const control = new PassThrough();
  attachOwnerLossControl(child, control);
  child.once('exit', () => {
    setTimeout(() => control.end(`{"kind":"started","pid":${child.pid}}\n`), 40);
  });
  return child;
}

test('a fast target retains stdout when process exit precedes the control handshake', async () => {
  const child = targetBeforeHandshake();
  const result = await startNativeCommand(
    { executable: '/bin/echo', capture: true, maxOutputBytes: 4096, timeoutMs: 2000 },
    undefined,
    { launch: () => child },
  ).result;
  expect(result.exitCode).toBe(0);
  expect(new TextDecoder().decode(result.stdout)).toBe('before-handshake\n');
});

test('captured output still obeys its budget after a delayed handshake', async () => {
  const child = targetBeforeHandshake();
  await expect(
    startNativeCommand(
      { executable: '/bin/echo', capture: true, maxOutputBytes: 2, timeoutMs: 2000 },
      undefined,
      { launch: () => child },
    ).result,
  ).rejects.toMatchObject({ code: 'COMMAND_LIMIT', reason: 'output-budget' });
});

test('a rejected start callback never delivers bytes to the output sink', async () => {
  for (const mode of ['throw', 'abort']) {
    const child = targetBeforeHandshake();
    const controller = new AbortController();
    const refusal = new Error(`start ${mode}`);
    const output: string[] = [];
    await expect(
      startNativeCommand(
        {
          executable: '/bin/echo',
          timeoutMs: 2000,
          signal: controller.signal,
          onLeaderStarted: () => {
            if (mode === 'throw') throw refusal;
            controller.abort(refusal);
          },
          onOutput: (chunk) => {
            output.push(new TextDecoder().decode(chunk));
          },
        },
        undefined,
        { launch: () => child },
      ).result,
    ).rejects.toBe(refusal);
    expect(output).toEqual([]);
  }
});
