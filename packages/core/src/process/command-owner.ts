import type { ChildProcessWithoutNullStreams } from 'node:child_process';
import { raceAbort } from '../internal/abort-race';
import { cleanupNativeCommand } from './cleanup';
import { createCommandLifetime } from './command-lifetime';
import {
  NativeCommandError,
  type NativeCommandOptions,
  NativeCommandOptionsSchema,
  type NativeCommandResult,
} from './contract';
import { createCommandDeadline, stopCommandGroup } from './group';
import {
  launchNativeCommand,
  type NativeCommandLaunchDriver,
  nativeCommandBudgets,
  registerNativeCommandOwner,
} from './launch';
import { createLeaderCloseDeadline, createLeaderSettlement } from './leader-settlement';
import { ownsCommandGroup } from './owned-child';
import { failedCommandStart } from './start-failure';
import type { NativeCommandTransport } from './transport';

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
  let acquired: NativeCommandTransport | undefined;
  let finished = false;
  const completion = Promise.withResolvers<NativeCommandResult>();
  const result = completion.promise.finally(() => {
    finished = true;
  });
  void result.catch(() => undefined);
  const signalOwned = (force = driver?.force) => {
    const child = acquired?.child;
    if (!child) return Promise.resolve();
    return driver?.group === false || !ownsCommandGroup(child)
      ? Promise.resolve().then(() => {
          if (child.exitCode === null && child.signalCode === null && !child.kill('SIGKILL'))
            throw new Error('Command leader termination was refused');
        })
      : stopCommandGroup(child.pid, options.killGraceMs, cleanupTimeoutMs, force);
  };
  const owner = createCommandLifetime({
    result,
    controller,
    finished: () => finished,
    signal: () => signalOwned(true),
    cleanupTimeoutMs,
  });
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
      (transport) => {
        acquired = transport;
        registerNativeCommandOwner(transport.child, owner);
      },
    );
  } catch (cause) {
    deadline?.cancel();
    deadline?.signal.removeEventListener('abort', expired);
    options.signal?.removeEventListener('abort', abort);
    controller.abort(cause);
    void failedCommandStart(cause, (error) =>
      cleanupNativeCommand({
        error,
        transport: acquired,
        settle,
        event: { kind: 'error', cause },
        signal: () => signalOwned(),
        timeoutMs: cleanupTimeoutMs,
      }),
    ).then(completion.resolve, completion.reject);
    return owner;
  }
  const stdout: Uint8Array[] = [];
  const stderr: Uint8Array[] = [];
  let total = 0;
  const { stdout: output, stderr: errorOutput, leader, closed } = launched;
  const cancelCloseDeadline = createLeaderCloseDeadline(
    leader,
    driver?.closeTimeoutMs,
    controller,
  );
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
  const run = (async (): Promise<NativeCommandResult> => {
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
      await cleanupNativeCommand({
        error,
        transport: acquired,
        settle,
        signal: () => signalOwned(),
        timeoutMs: cleanupTimeoutMs,
      });
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
  void run.then(completion.resolve, completion.reject);
  return owner;
}
