/** A command talked to while it runs: stdin as a stream, written as it yields. */
import { describe, expect, test } from 'bun:test';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Writable } from 'node:stream';
import {
  NativeCommandError,
  runNativeCommand,
  streamNativeCommand,
} from '../src/entrypoints/process';
import { startNativeCommand } from '../src/process/command-owner';
import { reapAfterEachTest, trackGroupLeader } from './support/process-reaper';

reapAfterEachTest();
const encoder = new TextEncoder();
const decoder = new TextDecoder();

function writer() {
  let controller!: ReadableStreamDefaultController<Uint8Array>;
  const stream = new ReadableStream<Uint8Array>({
    start(c) {
      controller = c;
    },
  });
  return {
    stream,
    write: (text: string) => controller.enqueue(encoder.encode(text)),
    writeRaw: (bytes: Uint8Array) => controller.enqueue(bytes),
    close: () => controller.close(),
  };
}

const echo = ['-e', "process.stdin.on('data', (d) => process.stdout.write(d))"];

async function readUntil(
  reader: ReadableStreamDefaultReader<Uint8Array>,
  expected: string,
): Promise<string> {
  let received = '';
  while (received.length < expected.length) {
    const next = await reader.read();
    if (next.done) break;
    received += decoder.decode(next.value, { stream: true });
  }
  return received;
}

describe('a streamed stdin', () => {
  test('each write reaches the command while it runs, and the end of the stream ends its input', async () => {
    const input = writer();
    const command = streamNativeCommand({
      executable: process.execPath,
      args: echo,
      stdin: input.stream,
      timeoutMs: 10_000,
      onLeaderStarted: trackGroupLeader,
    });
    const reader = command.stdout.getReader();
    input.write('first\n');
    expect(decoder.decode((await reader.read()).value)).toBe('first\n');
    input.write('second\n');
    expect(decoder.decode((await reader.read()).value)).toBe('second\n');
    input.close();
    for (let next = await reader.read(); !next.done; next = await reader.read()) {
      // The rest of the output, read to the end so the command can settle.
    }
    expect((await command.result).exitCode).toBe(0);
  });

  test('a stream past maxStdinBytes ends the input with a failure', async () => {
    const input = writer();
    const command = streamNativeCommand({
      executable: process.execPath,
      args: echo,
      stdin: input.stream,
      maxStdinBytes: 8,
      timeoutMs: 10_000,
      onLeaderStarted: trackGroupLeader,
    });
    void command.stdout.cancel();
    void command.stderr.cancel();
    input.write('0123456789');
    let caught: unknown;
    try {
      await command.result;
    } catch (error) {
      caught = error;
    }
    expect(caught).toBeInstanceOf(NativeCommandError);
    expect(caught).toMatchObject({ code: 'COMMAND_LIMIT', reason: 'stdin-budget' });
  });

  test('exact maxStdinBytes boundary accepts 4 + 4 and rejects 4 + 4 + 1 before byte 9 reaches the child', async () => {
    const exactInput = writer();
    const exactCommand = streamNativeCommand({
      executable: process.execPath,
      args: echo,
      stdin: exactInput.stream,
      maxStdinBytes: 8,
      timeoutMs: 10_000,
      onLeaderStarted: trackGroupLeader,
    });
    void exactCommand.stderr.cancel();
    const exactReader = exactCommand.stdout.getReader();
    exactInput.write('0123');
    exactInput.write('4567');
    exactInput.close();
    let echoed = '';
    for (let next = await exactReader.read(); !next.done; next = await exactReader.read()) {
      echoed += decoder.decode(next.value, { stream: true });
    }
    expect(echoed).toBe('01234567');
    expect((await exactCommand.result).exitCode).toBe(0);

    const dir = mkdtempSync(join(tmpdir(), 'stitchkit-stdin-boundary-'));
    const logPath = join(dir, 'received.txt');
    try {
      const overInput = writer();
      const overCommand = streamNativeCommand({
        executable: process.execPath,
        args: [
          '-e',
          `const fs = require('node:fs');
           process.stdin.on('data', (d) => {
             fs.appendFileSync(${JSON.stringify(logPath)}, d);
             process.stdout.write(d);
           });`,
        ],
        stdin: overInput.stream,
        maxStdinBytes: 8,
        timeoutMs: 10_000,
        stop: { target: 'group', graceMs: 100 },
        onLeaderStarted: trackGroupLeader,
      });
      void overCommand.stderr.cancel();
      const overReader = overCommand.stdout.getReader();
      overInput.write('0123');
      expect(await readUntil(overReader, '0123')).toBe('0123');
      overInput.write('4567');
      expect(await readUntil(overReader, '4567')).toBe('4567');

      // Drain any remaining stdout until it closes or errors so we also observe stdout directly.
      let trailingStdout = '';
      const drainStdout = (async () => {
        try {
          for (
            let next = await overReader.read();
            !next.done;
            next = await overReader.read()
          ) {
            trailingStdout += decoder.decode(next.value, { stream: true });
          }
        } catch {
          // Expected: streamNativeCommand errors stdout on COMMAND_LIMIT.
        }
      })();

      overInput.write('8');
      let caught: unknown;
      try {
        await overCommand.result;
      } catch (error) {
        caught = error;
      }
      await drainStdout;

      expect(caught).toBeInstanceOf(NativeCommandError);
      expect(caught).toMatchObject({ code: 'COMMAND_LIMIT', reason: 'stdin-budget' });
      expect(trailingStdout).toBe('');
      expect(readFileSync(logPath, 'utf8')).toBe('01234567');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test('non-Uint8Array chunks reject with TypeError instead of bypassing maxStdinBytes', async () => {
    const invalidChunks: readonly unknown[] = [
      'x'.repeat(100),
      { byteLength: 1 },
      new ArrayBuffer(8),
    ];
    for (const chunk of invalidChunks) {
      const stream = new ReadableStream<Uint8Array>({
        start(controller) {
          Reflect.apply(controller.enqueue, controller, [chunk]);
          controller.close();
        },
      });
      const command = streamNativeCommand({
        executable: process.execPath,
        args: echo,
        stdin: stream,
        maxStdinBytes: 8,
        timeoutMs: 10_000,
        stop: { target: 'group', graceMs: 0 },
        onLeaderStarted: trackGroupLeader,
      });
      void command.stdout.cancel();
      void command.stderr.cancel();
      let caught: unknown;
      try {
        await command.result;
      } catch (error) {
        caught = error;
      }
      expect(caught).toBeInstanceOf(TypeError);
      expect(caught instanceof Error ? caught.message : '').toMatch(/Uint8Array/);
    }
  });

  test('Buffer chunks and empty Uint8Array chunks succeed', async () => {
    const input = writer();
    const command = streamNativeCommand({
      executable: process.execPath,
      args: echo,
      stdin: input.stream,
      maxStdinBytes: 2,
      timeoutMs: 10_000,
      onLeaderStarted: trackGroupLeader,
    });
    void command.stderr.cancel();
    const reader = command.stdout.getReader();
    input.writeRaw(new Uint8Array(0));
    input.writeRaw(Buffer.from('ok'));
    input.writeRaw(new Uint8Array(0));
    input.close();
    let echoed = '';
    for (let next = await reader.read(); !next.done; next = await reader.read()) {
      echoed += decoder.decode(next.value, { stream: true });
    }
    expect(echoed).toBe('ok');
    expect((await command.result).exitCode).toBe(0);
  });

  test('a pre-locked ReadableStream rejects cleanly with TypeError and emits zero unhandledRejections', async () => {
    const stream = new ReadableStream<Uint8Array>({});
    const heldReader = stream.getReader();
    const unhandled: unknown[] = [];
    const onUnhandled = (reason: unknown) => {
      unhandled.push(reason);
    };
    process.on('unhandledRejection', onUnhandled);
    try {
      const command = streamNativeCommand({
        executable: process.execPath,
        args: ['-e', 'setInterval(() => {}, 1000)'],
        stdin: stream,
        timeoutMs: 3_000,
        stop: { target: 'group', graceMs: 0 },
        onLeaderStarted: trackGroupLeader,
      });
      void command.stdout.cancel();
      void command.stderr.cancel();
      let caught: unknown;
      try {
        await command.result;
      } catch (error) {
        caught = error;
      }
      await Bun.sleep(20);
      expect(caught).toBeInstanceOf(TypeError);
      expect(unhandled).toEqual([]);
    } finally {
      process.off('unhandledRejection', onUnhandled);
      heldReader.releaseLock();
    }
  });

  test('aborting during stdin drain backpressure aborts promptly, unlocks the stream, kills the child, and leaves zero drain listeners', async () => {
    const controller = new AbortController();
    const abortReason = new Error('abort during drain');
    const chunk = new Uint8Array(64 * 1024);
    let pulledBytes = 0;
    const source = new ReadableStream<Uint8Array>({
      pull(streamController) {
        pulledBytes += chunk.byteLength;
        streamController.enqueue(chunk);
      },
    });
    let spawnedStdin: Writable | undefined;
    let leaderPid: number | undefined;
    const ready = Promise.withResolvers<void>();
    const command = startNativeCommand(
      {
        executable: process.execPath,
        args: [
          '-e',
          "process.stdin.pause(); process.stdout.write('ready\\n'); setInterval(() => {}, 1000);",
        ],
        stdin: source,
        maxStdinBytes: 4 * 1024 * 1024,
        signal: controller.signal,
        stop: { target: 'group', graceMs: 0 },
        onLeaderStarted(event) {
          leaderPid = event.pid;
          trackGroupLeader(event);
        },
        onOutput(bytes, channel) {
          if (channel === 'stdout' && decoder.decode(bytes).includes('ready')) ready.resolve();
        },
      },
      (child) => {
        spawnedStdin = child.stdin;
      },
    );

    await ready.promise;
    const waitDeadline = Date.now() + 5_000;
    while (Date.now() < waitDeadline) {
      if (
        spawnedStdin &&
        spawnedStdin.listenerCount('drain') > 0 &&
        pulledBytes > 256 * 1024
      ) {
        break;
      }
      await Bun.sleep(10);
    }
    expect(spawnedStdin).toBeDefined();
    expect(pulledBytes).toBeGreaterThan(256 * 1024);
    expect(spawnedStdin?.listenerCount('drain')).toBe(1);

    const abortStarted = Date.now();
    controller.abort(abortReason);
    let caught: unknown;
    try {
      await command.result;
    } catch (error) {
      caught = error;
    }
    const elapsedMs = Date.now() - abortStarted;
    expect(caught).toBe(abortReason);
    expect(elapsedMs).toBeLessThan(2_000);
    expect(source.locked).toBe(false);
    expect(spawnedStdin?.listenerCount('drain')).toBe(0);
    const pid = leaderPid;
    expect(pid).toBeDefined();
    if (pid !== undefined) {
      expect(() => process.kill(pid, 0)).toThrow();
    }
  });

  test('a command that exits while the stream is open does not hang the input', async () => {
    const input = writer();
    const command = streamNativeCommand({
      executable: process.execPath,
      args: ['-e', 'process.exit(0)'],
      stdin: input.stream,
      timeoutMs: 10_000,
      onLeaderStarted: trackGroupLeader,
    });
    void command.stdout.cancel();
    void command.stderr.cancel();
    expect((await command.result).exitCode).toBe(0);
    expect(input.stream.locked).toBe(false);
    expect(() => input.write('late')).toThrow(TypeError);
  });

  test('a captured command whose stdin never ends returns when the command exits', async () => {
    const endless = new ReadableStream<Uint8Array>({});
    const result = await runNativeCommand({
      executable: process.execPath,
      args: ['-e', 'process.stdout.write("done")'],
      timeoutMs: 5_000,
      capture: true,
      maxOutputBytes: 4096,
      stdin: endless,
      onLeaderStarted: trackGroupLeader,
    });
    expect(result.exitCode).toBe(0);
    expect(decoder.decode(result.stdout)).toBe('done');
    expect(endless.locked).toBe(false);
  });

  test('canceling a pending stdin read triggers source.cancel() and unlocks the stream on early exit and abort', async () => {
    // 1. Child exits early while pull() is suspended
    let exitCancelCalls = 0;
    const exitPulled = Promise.withResolvers<void>();
    const exitSource = new ReadableStream<Uint8Array>({
      pull() {
        exitPulled.resolve();
        return new Promise<void>(() => undefined);
      },
      cancel() {
        exitCancelCalls += 1;
      },
    });
    const exitCmd = streamNativeCommand({
      executable: process.execPath,
      args: ['-e', 'setTimeout(() => process.exit(0), 60)'],
      stdin: exitSource,
      timeoutMs: 10_000,
      onLeaderStarted: trackGroupLeader,
    });
    void exitCmd.stdout.cancel();
    void exitCmd.stderr.cancel();
    await exitPulled.promise;
    expect((await exitCmd.result).exitCode).toBe(0);
    await Bun.sleep(20);
    expect(exitCancelCalls).toBe(1);
    expect(exitSource.locked).toBe(false);

    // 2. Abort signal fires while pull() is suspended
    let abortCancelCalls = 0;
    const abortPulled = Promise.withResolvers<void>();
    const abortSource = new ReadableStream<Uint8Array>({
      pull() {
        abortPulled.resolve();
        return new Promise<void>(() => undefined);
      },
      cancel() {
        abortCancelCalls += 1;
      },
    });
    const ac = new AbortController();
    const abortReason = new Error('abort-while-pull-suspended');
    const abortCmd = streamNativeCommand({
      executable: process.execPath,
      args: ['-e', 'setInterval(() => {}, 1000)'],
      stdin: abortSource,
      signal: ac.signal,
      timeoutMs: 10_000,
      stop: { target: 'group', graceMs: 0 },
      onLeaderStarted: trackGroupLeader,
    });
    void abortCmd.stdout.cancel();
    void abortCmd.stderr.cancel();
    await abortPulled.promise;
    ac.abort(abortReason);
    let caught: unknown;
    try {
      await abortCmd.result;
    } catch (error) {
      caught = error;
    }
    expect(caught).toBe(abortReason);
    await Bun.sleep(20);
    expect(abortCancelCalls).toBe(1);
    expect(abortSource.locked).toBe(false);
  });
});
