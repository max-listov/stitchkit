import { type ChildProcessWithoutNullStreams, spawn } from 'node:child_process';
import type { Readable } from 'node:stream';
import { raceAbort } from '../internal/abort-race';
import {
  NativeCommandError,
  type NativeCommandOptions,
  NativeCommandOptionsSchema,
  type NativeCommandResult,
} from './contract';
import { commandCleanupError, stopCommandGroup, waitForCommandClose } from './group';

/** One-shot native execution; sandbox policy/admission is composed above this owner. */
export function startNativeCommand(
  input: NativeCommandOptions,
  onSpawn?: (child: ChildProcessWithoutNullStreams) => void,
) {
  const options = NativeCommandOptionsSchema.parse(input);
  options.signal?.throwIfAborted();
  if (process.platform === 'win32')
    throw new NativeCommandError('COMMAND_UNAVAILABLE', 'POSIX process groups are required');
  const controller = new AbortController();
  const abort = () => controller.abort(options.signal?.reason);
  options.signal?.addEventListener('abort', abort, { once: true });
  if (options.signal?.aborted) abort();
  const timer =
    options.timeoutMs === undefined
      ? undefined
      : setTimeout(
          () =>
            controller.abort(
              new NativeCommandError('COMMAND_LIMIT', 'Command deadline exceeded'),
            ),
          options.timeoutMs,
        );
  let child: ChildProcessWithoutNullStreams;
  try {
    child = spawn(options.executable, options.args, {
      cwd: options.cwd,
      env:
        options.envPolicy === 'ambient'
          ? { ...process.env, ...options.env }
          : (options.env ?? {}),
      detached: true,
      stdio: ['pipe', 'pipe', 'pipe'],
    });
  } catch (cause) {
    if (timer !== undefined) clearTimeout(timer);
    options.signal?.removeEventListener('abort', abort);
    throw new NativeCommandError('COMMAND_UNAVAILABLE', 'Command could not start', { cause });
  }
  const stdout: Uint8Array[] = [];
  const stderr: Uint8Array[] = [];
  let total = 0;
  let finished = false;
  let spawnFailure: unknown;
  const closed = new Promise<{ exitCode: number | null; signal: string | null }>((resolve) => {
    child.once('error', (error) => {
      spawnFailure = new NativeCommandError('COMMAND_UNAVAILABLE', 'Command could not start', {
        cause: error,
      });
      controller.abort(spawnFailure);
    });
    child.once('close', (exitCode, signal) => resolve({ exitCode, signal }));
  });
  child.stdin.on('error', (error) => {
    if (!('code' in error && error.code === 'EPIPE')) controller.abort(error);
  });
  const drain = async (
    stream: Readable,
    channel: 'stdout' | 'stderr',
    captured: Uint8Array[],
  ) => {
    for await (const chunk of stream) {
      controller.signal.throwIfAborted();
      // Node's binary Readable boundary; reject an unexpected text-mode adapter.
      if (!(chunk instanceof Uint8Array))
        throw new TypeError('Expected binary command output');
      total += chunk.byteLength;
      if (options.maxOutputBytes !== undefined && total > options.maxOutputBytes)
        throw new NativeCommandError('COMMAND_LIMIT', 'Command output budget exceeded');
      if (options.capture) captured.push(Uint8Array.from(chunk));
      if (options.onOutput)
        await raceAbort(
          Promise.resolve().then(() => {
            controller.signal.throwIfAborted();
            return options.onOutput?.(chunk, channel, controller.signal);
          }),
          controller.signal,
        );
    }
  };
  const result = (async (): Promise<NativeCommandResult> => {
    try {
      onSpawn?.(child);
      child.stdin.end(options.stdin);
      const drains = Promise.all([
        drain(child.stdout, 'stdout', stdout),
        drain(child.stderr, 'stderr', stderr),
      ]);
      await raceAbort(drains, controller.signal);
      const status = await raceAbort(closed, controller.signal);
      if (spawnFailure !== undefined) throw spawnFailure;
      return { ...status, stdout: Buffer.concat(stdout), stderr: Buffer.concat(stderr) };
    } catch (error) {
      controller.abort(error);
      child.stdin.destroy();
      child.stdout.destroy();
      child.stderr.destroy();
      try {
        await stopCommandGroup(child.pid, options.killGraceMs);
        await waitForCommandClose(closed, options.cleanupTimeoutMs);
      } catch (cleanup) {
        throw commandCleanupError(
          new AggregateError([error, cleanup], 'Command failed and cleanup failed'),
        );
      }
      throw error;
    } finally {
      finished = true;
      if (timer !== undefined) clearTimeout(timer);
      options.signal?.removeEventListener('abort', abort);
      // Releases the sink lifetime also after a successful complete drain.
      controller.abort(new Error('Command completed'));
    }
  })();
  void result.catch(() => undefined);
  return {
    result,
    async stop() {
      if (!finished) controller.abort(new DOMException('Command stopped', 'AbortError'));
      await result.then(
        () => undefined,
        () => undefined,
      );
    },
  };
}
