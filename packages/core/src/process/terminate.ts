import type { ParsedNativeCommandStopPolicy } from './contract';
import {
  type CommandLeader,
  commandCleanupError,
  stopCommandGroup,
  stopCommandLeader,
  waitForCommandClose,
} from './group';
import { ownsCommandGroup } from './owned-child';

/** What stopping a launched child needs: its pid, exit state and a leader kill. */
interface SignalableChild extends CommandLeader {
  kill(signal: 'SIGKILL'): boolean;
}

/**
 * Deliver the stop signals to `child` by its stop policy. A child this package spawned as a
 * group leader is stopped as a group (`target: 'group'`) or leader first (`'leader'`); any
 * other child is only a leader, killed while it still runs.
 */
export function signalCommandChild(
  child: SignalableChild,
  input: {
    group: boolean;
    policy: ParsedNativeCommandStopPolicy;
    /** Settles when the leader's exit is observed; ends a leader-first grace early. */
    leaderExit: Promise<unknown>;
    cleanupTimeoutMs: number;
    force: boolean;
  },
): Promise<void> {
  if (input.group && ownsCommandGroup(child)) {
    const stop = {
      pid: child.pid,
      policy: input.policy,
      cleanupTimeoutMs: input.cleanupTimeoutMs,
      force: input.force,
    };
    return input.policy.target === 'leader'
      ? stopCommandLeader({ ...stop, leader: child, leaderExit: input.leaderExit })
      : stopCommandGroup(stop);
  }
  return Promise.resolve().then(() => {
    if (child.exitCode === null && child.signalCode === null && !child.kill('SIGKILL'))
      throw new Error('Command leader termination was refused');
  });
}

interface ClosableChild extends SignalableChild {
  readonly stdin: { destroy(): unknown };
  readonly stdout: { destroy(): unknown };
  readonly stderr: { destroy(): unknown };
}

/**
 * Kill the process group of a child that no command owner supervises, then wait for it
 * to close. `closed` settles when the child's `close` event fires; a child whose pipes
 * stay open past `cleanupTimeoutMs` has them destroyed and is reported as `COMMAND_CLEANUP`.
 * The caller keeps reading the child's own streams: this adds no consumer of them.
 */
export async function terminateOwnedGroup(
  child: ClosableChild,
  closed: Promise<unknown>,
  cleanupTimeoutMs: number,
): Promise<void> {
  try {
    await signalCommandChild(child, {
      group: true,
      policy: { target: 'group', signal: 'SIGTERM', graceMs: 0 },
      leaderExit: closed,
      cleanupTimeoutMs,
      force: true,
    });
    await waitForCommandClose(closed, cleanupTimeoutMs);
  } catch (cause) {
    for (const pipe of [child.stdin, child.stdout, child.stderr]) pipe.destroy();
    throw commandCleanupError(cause);
  }
}
