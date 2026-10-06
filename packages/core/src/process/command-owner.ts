import type { ChildProcessWithoutNullStreams } from 'node:child_process';
import { raceAbort } from '../internal/abort-race';
import { cleanupNativeCommand } from './cleanup';
import { createCommandLifetime } from './command-lifetime';
import {
  NativeCommandError,
  type NativeCommandOptions,
  NativeCommandOptionsSchema,
  type NativeCommandResult,
  type NativeCommandSettlement,
} from './contract';
import { commandCleanupError, createCommandDeadline } from './group';
import {
  launchNativeCommand,
  type NativeCommandLaunchDriver,
  nativeCommandBudgets,
  registerNativeCommandOwner,
} from './launch';
import { createLeaderCloseDeadline, createLeaderSettlement } from './leader-settlement';
import { createOutputDrain } from './output-drain';
import { failedCommandStart } from './start-failure';
import { signalCommandChild } from './terminate';
import type { NativeCommandTransport } from './transport';

/** One-shot native execution; sandbox policy/admission is composed above this owner. */
export function startNativeCommand(
  input: NativeCommandOptions,
  onSpawn?: (child: ChildProcessWithoutNullStreams) => void,
  driver?: NativeCommandLaunchDriver,
) {
  const options = NativeCommandOptionsSchema.parse(input);
  options.signal?.throwIfAborted();
  const { killOn } = options.stop;
  killOn?.throwIfAborted();
  if (process.platform === 'win32' && driver?.group !== false)
    throw new NativeCommandError('COMMAND_UNAVAILABLE', 'POSIX process groups are required');
  const { cleanupTimeoutMs, timeoutMs } = nativeCommandBudgets(options, driver);
  const controller = new AbortController();
  const abort = () => controller.abort(options.signal?.reason);
  options.signal?.addEventListener('abort', abort, { once: true });
  if (options.signal?.aborted) abort();
  // An abort of `killOn` stops the command too; the stop sees it aborted and skips the grace.
  const kill = () => controller.abort(killOn?.reason);
  killOn?.addEventListener('abort', kill, { once: true });
  const release = () => {
    options.signal?.removeEventListener('abort', abort);
    killOn?.removeEventListener('abort', kill);
  };
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
    if (!acquired) return Promise.resolve(false);
    return signalCommandChild(acquired.child, {
      group: driver?.group !== false && options.group === 'own',
      callerGroup: options.group === 'caller',
      policy: options.stop,
      leaderExit: acquired.leader,
      cleanupTimeoutMs,
      force: force === true,
    });
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
    launched = launchNativeCommand({
      options,
      driver,
      onSpawn,
      onFailure: (error) => {
        spawnFailure = new NativeCommandError(
          'COMMAND_UNAVAILABLE',
          'Command could not start',
          {
            cause: error,
          },
        );
        controller.abort(spawnFailure);
      },
      onInputFailure: (error) => controller.abort(error),
      onAcquired: (transport) => {
        acquired = transport;
        registerNativeCommandOwner(transport.child, owner);
      },
    });
  } catch (cause) {
    deadline?.cancel();
    deadline?.signal.removeEventListener('abort', expired);
    release();
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
  const output = createOutputDrain(options, controller.signal);
  const { stdout, stderr, leader, closed } = launched;
  const cancelCloseDeadline = createLeaderCloseDeadline(
    leader,
    driver?.closeTimeoutMs ?? options.drainTimeoutMs,
    controller,
  );
  // After an observed leader exit the descendants are stopped (unless the caller declared
  // `descendants: 'leave'`) before the pipes drain: a member holding an inherited pipe would otherwise hold the drain.
  let descendantsStopped = false;
  const settleLeader = async (event: NativeCommandSettlement) => {
    // A command that is already stopping settles through its stop, with the cause, once the
    // stop has observed the leader's exit; it also has its group handled by that stop.
    if (controller.signal.aborted) return;
    await settle(event);
    if (controller.signal.aborted) return;
    // In the caller's group there is no group of the command's own to clean up.
    if (options.group === 'caller') return;
    if (options.descendants !== 'terminate-after-leader' || event.kind !== 'exit') return;
    try {
      descendantsStopped = await signalOwned();
    } catch (cause) {
      throw commandCleanupError(cause);
    }
  };
  const run = (async (): Promise<NativeCommandResult> => {
    try {
      launched.start();
      const pid = acquired?.child.pid;
      if (pid !== undefined) options.onLeaderStarted?.({ pid });
      const drains = Promise.all([
        output.drain(stdout, 'stdout'),
        output.drain(stderr, 'stderr'),
      ]);
      await raceAbort(Promise.all([drains, leader.then(settleLeader)]), controller.signal);
      const status = await raceAbort(closed, controller.signal);
      if (spawnFailure !== undefined) throw spawnFailure;
      return {
        ...status,
        descendantsStopped,
        ...output.captured(),
      };
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
      release();
      // Releases the sink lifetime also after a successful complete drain.
      controller.abort(new Error('Command completed'));
    }
  })();
  void run.then(completion.resolve, completion.reject);
  return owner;
}
