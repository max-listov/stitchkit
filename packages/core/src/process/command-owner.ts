import type { ChildProcessWithoutNullStreams } from 'node:child_process';
import { raceAbort } from '../internal/abort-race';
import {
  NativeCommandError,
  type NativeCommandOptions,
  NativeCommandOptionsSchema,
  type NativeCommandResult,
} from './contract';
import {
  commandCleanupError,
  createCommandDeadline,
  stopCommandGroup,
  waitForCommandClose,
} from './group';
import {
  launchNativeCommand,
  type NativeCommandLaunchDriver,
  nativeCommandBudgets,
  registerNativeCommandOwner,
} from './launch';
import { createLeaderCloseDeadline, createLeaderSettlement } from './leader-settlement';
import { failedCommandStart } from './start-failure';

/** One-shot native execution; sandbox policy/admission is composed above this owner. */
export function startNativeCommand(
  input: NativeCommandOptions,
  onSpawn?: (child: ChildProcessWithoutNullStreams) => void,
  driver?: NativeCommandLaunchDriver,
) {
  const options = NativeCommandOptionsSchema.parse(input);
  options.signal?.throwIfAborted();
  if (process.platform === 'win32' && driver?.group !== false)
    throw new NativeCommandError('COMMAND_UNAVAILABLE', 'POSIX process groups are required');
  const { cleanupTimeoutMs, timeoutMs } = nativeCommandBudgets(options, driver);
  const controller = new AbortController();
  const abort = () => controller.abort(options.signal?.reason);
  options.signal?.addEventListener('abort', abort, { once: true });
  if (options.signal?.aborted) abort();
  const deadline =
    timeoutMs === undefined
      ? undefined
      : createCommandDeadline(
          timeoutMs,
          new NativeCommandError('COMMAND_LIMIT', 'Command deadline exceeded', {
            reason: 'deadline',
          }),
        );
  const expired = () => controller.abort(deadline?.signal.reason);
  if (deadline?.signal.aborted) expired();
  else deadline?.signal.addEventListener('abort', expired, { once: true });
  const settle = createLeaderSettlement({ ...options, cleanupTimeoutMs }, controller.signal);
  let spawnFailure: unknown;
  let launched: ReturnType<typeof launchNativeCommand>;
  try {
    launched = launchNativeCommand(
      options,
      driver,
      onSpawn,
      (error) => {
        spawnFailure = new NativeCommandError(
          'COMMAND_UNAVAILABLE',
          'Command could not start',
          {
            cause: error,
          },
        );
        controller.abort(spawnFailure);
      },
      (error) => controller.abort(error),
    );
  } catch (cause) {
    deadline?.cancel();
    deadline?.signal.removeEventListener('abort', expired);
    options.signal?.removeEventListener('abort', abort);
    controller.abort(cause);
    return failedCommandStart(cause, settle);
  }
  const stdout: Uint8Array[] = [];
  const stderr: Uint8Array[] = [];
  let total = 0;
  let finished = false;
  const {
    child,
    stdout: output,
    stderr: errorOutput,
    leader,
    closed,
    released,
    pendingHandles,
  } = launched;
  const cancelCloseDeadline = createLeaderCloseDeadline(
    leader,
    driver?.closeTimeoutMs,
    controller,
  );
  const signalOwned = (force = driver?.force) =>
    driver?.group === false || (driver?.launch && child.pid === undefined)
      ? Promise.resolve().then(() => {
          if (child.exitCode === null && child.signalCode === null && !child.kill('SIGKILL'))
            throw new Error('Command leader termination was refused');
        })
      : stopCommandGroup(child.pid, options.killGraceMs, cleanupTimeoutMs, force);
  const drain = async (
    stream: AsyncIterable<Uint8Array>,
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
        throw new NativeCommandError('COMMAND_LIMIT', 'Command output budget exceeded', {
          reason: 'output-budget',
        });
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
      launched.start();
      const drains = Promise.all([
        drain(output, 'stdout', stdout),
        drain(errorOutput, 'stderr', stderr),
      ]);
      await raceAbort(Promise.all([drains, leader.then(settle)]), controller.signal);
      const status = await raceAbort(closed, controller.signal);
      if (spawnFailure !== undefined) throw spawnFailure;
      return { ...status, stdout: Buffer.concat(stdout), stderr: Buffer.concat(stderr) };
    } catch (error) {
      controller.abort(error);
      const cleanup = await Promise.allSettled([
        settle({ kind: 'error', cause: error }),
        Promise.resolve().then(() => launched.destroy()),
        signalOwned().then(async () => {
          try {
            await waitForCommandClose(released, cleanupTimeoutMs);
          } catch (cause) {
            throw new Error(
              `Command handles remained open: ${[...pendingHandles].join(', ')}`,
              {
                cause,
              },
            );
          }
        }),
      ]);
      const failures = cleanup.flatMap((item) =>
        item.status === 'rejected' && item.reason !== error ? [item.reason] : [],
      );
      if (failures.length) {
        throw commandCleanupError(
          new AggregateError([error, ...failures], 'Command failed and cleanup failed'),
        );
      }
      throw error;
    } finally {
      finished = true;
      cancelCloseDeadline();
      deadline?.cancel();
      deadline?.signal.removeEventListener('abort', expired);
      options.signal?.removeEventListener('abort', abort);
      // Releases the sink lifetime also after a successful complete drain.
      controller.abort(new Error('Command completed'));
    }
  })();
  void result.catch(() => undefined);
  const owner = {
    result,
    async terminate() {
      let refused = false;
      let refusal: unknown;
      if (!finished) {
        try {
          await signalOwned(true);
        } catch (error) {
          refused = true;
          refusal = error;
          controller.abort(error);
        }
        try {
          await waitForCommandClose(result, cleanupTimeoutMs);
        } catch (error) {
          if (!finished) controller.abort(error);
        }
      }
      await result.then(
        () => undefined,
        (error) => {
          if (error instanceof NativeCommandError && error.code === 'COMMAND_CLEANUP')
            throw error;
        },
      );
      if (refused) throw commandCleanupError(refusal);
    },
    async stop() {
      if (!finished) controller.abort(new DOMException('Command stopped', 'AbortError'));
      await result.then(
        () => undefined,
        (error) => {
          if (error instanceof NativeCommandError && error.code === 'COMMAND_CLEANUP')
            throw error;
        },
      );
    },
  };
  registerNativeCommandOwner(child, owner);
  return owner;
}
