import { expect, test } from 'bun:test';
import { spawnSync } from 'node:child_process';
import type { Readable } from 'node:stream';
import { startNativeCommand } from '../src/process/command-owner';
import { NativeCommandError } from '../src/process/contract';
import { waitForCommandClose } from '../src/process/group';
import { nativeCommandOwner } from '../src/process/launch';
import { spawnOwnedCommand } from '../src/process/owned-child';

function output(source: Readable, failure?: Error, destroyFailure?: Error) {
  return {
    get destroyed() {
      return source.destroyed;
    },
    on(event: 'data', listener: (chunk: Uint8Array) => void) {
      if (failure) throw failure;
      source.on(event, listener);
    },
    destroy() {
      if (destroyFailure) throw destroyFailure;
      source.destroy();
    },
  };
}

function contains(actual: unknown, expected: unknown): boolean {
  if (actual === expected) return true;
  if (
    actual instanceof AggregateError &&
    actual.errors.some((item) => contains(item, expected))
  )
    return true;
  return actual instanceof Error && contains(actual.cause, expected);
}

for (const channel of ['stdout', 'stderr']) {
  test.skipIf(process.platform === 'win32')(
    `post-spawn ${channel} subscription refusal closes its owned group before result`,
    async () => {
      const child = spawnOwnedCommand({
        executable: process.execPath,
        args: ['-e', 'setInterval(()=>{},1000)'],
        group: true,
      });
      const closed = new Promise<void>((resolve) => child.once('close', () => resolve()));
      let observedClose = false;
      void closed.then(() => {
        observedClose = true;
      });
      const source = channel === 'stdout' ? child.stdout : child.stderr;
      const cause = new Error(`${channel} subscription refused`);
      Object.defineProperty(child, channel, { value: output(source, cause) });
      let calls = 0;
      try {
        const command = startNativeCommand(
          {
            executable: 'owned-launcher',
            timeoutMs: 1000,
            cleanupTimeoutMs: 200,
            onLeaderSettled: () => {
              calls++;
            },
          },
          undefined,
          { launch: () => child },
        );
        expect(nativeCommandOwner(child)).toBe(command);
        const error = await command.result.catch((failure: unknown) => failure);
        expect(error).toBeInstanceOf(NativeCommandError);
        if (!(error instanceof NativeCommandError)) throw error;
        expect(error.code).toBe('COMMAND_UNAVAILABLE');
        expect(error.cause).toBe(cause);
        expect(observedClose).toBe(true);
        expect(calls).toBe(1);
        await command.stop();
        await command.terminate();
        expect(() => process.kill(child.pid ?? 0, 0)).toThrow();
      } finally {
        child.kill('SIGKILL');
        source.destroy();
        await waitForCommandClose(closed, 1000);
      }
    },
  );
}

test.skipIf(process.platform === 'win32')(
  'post-spawn teardown and termination refusals retain both original and cleanup causes',
  async () => {
    for (const refusal of ['destroy', 'kill', 'close']) {
      const child = spawnOwnedCommand({
        executable: process.execPath,
        args: ['-e', 'setInterval(()=>{},1000)'],
        group: false,
      });
      const kill = child.kill.bind(child);
      const closed = new Promise<void>((resolve) => child.once('close', () => resolve()));
      const source = child.stdout;
      const cause = new Error('subscription refused');
      const cleanupCause = new Error('destroy refused');
      Object.defineProperty(child, 'stdout', {
        value: output(source, cause, refusal === 'destroy' ? cleanupCause : undefined),
      });
      if (refusal === 'kill') Object.defineProperty(child, 'kill', { value: () => false });
      if (refusal === 'close') {
        const on = child.on.bind(child);
        Object.defineProperty(child, 'on', {
          value: (event: string, listener: (...args: unknown[]) => void) =>
            event === 'close' ? child : on(event, listener),
        });
      }
      try {
        const command = startNativeCommand(
          {
            executable: 'structural-launcher',
            timeoutMs: 1000,
            cleanupTimeoutMs: 40,
          },
          undefined,
          { group: false, launch: () => child },
        );
        const failure = await command.result.catch((error: unknown) => error);
        expect(failure).toBeInstanceOf(NativeCommandError);
        if (!(failure instanceof NativeCommandError)) throw failure;
        expect(failure.code).toBe('COMMAND_CLEANUP');
        expect(contains(failure, cause)).toBe(true);
        if (refusal === 'destroy') expect(contains(failure, cleanupCause)).toBe(true);
        if (refusal === 'kill')
          expect(String(failure.cause)).toContain('Command failed and cleanup failed');
        await expect(command.stop()).rejects.toBe(failure);
      } finally {
        kill('SIGKILL');
        source.destroy();
        await waitForCommandClose(closed, 1000);
      }
    }
  },
);

test('a structural PID without group ownership never becomes permission to signal a group', () => {
  const entry = new URL('../src/process/command-owner.ts', import.meta.url).href;
  const script = `
    import assert from 'node:assert/strict';
    import { EventEmitter } from 'node:events';
    import { startNativeCommand } from ${JSON.stringify(entry)};
    const events = new EventEmitter();
    const cause = new Error('stdout refused');
    let killed = 0;
    let groupSignals = 0;
    process.kill = (pid) => { if (pid < 0) groupSignals++; throw new Error('foreign group'); };
    const child = {
      pid: 12345, exitCode: null, signalCode: null,
      stdout: { destroyed: false, on() { throw cause; }, destroy() {} },
      stderr: { destroyed: false, on() {}, destroy() {} },
      on(event, listener) { events.on(event, listener); },
      kill() { killed++; queueMicrotask(() => { events.emit('exit', null, 'SIGKILL'); events.emit('close', null, 'SIGKILL'); }); return true; },
    };
    const owner = startNativeCommand({ executable: 'structural', timeoutMs: 1000, cleanupTimeoutMs: 40 }, undefined, { group: true, launch: () => child });
    await assert.rejects(owner.result, (error) => error.code === 'COMMAND_UNAVAILABLE' && error.cause === cause);
    assert.equal(killed, 1);
    assert.equal(groupSignals, 0);
    console.log('structural PID ownership control: ok');
  `;
  const result = spawnSync(process.execPath, ['--eval', script], {
    encoding: 'utf8',
    timeout: 3000,
    maxBuffer: 4096,
  });
  expect(result.error).toBeUndefined();
  expect(result.status).toBe(0);
  expect(result.stderr).toBe('');
  expect(result.stdout.trim()).toBe('structural PID ownership control: ok');
});
