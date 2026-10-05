import type { ChildProcessWithoutNullStreams } from 'node:child_process';
import { COMMAND_CLEANUP_TIMEOUT_MS, NativeCommandError } from '../process/contract';
import { nativeCommandOwner } from '../process/launch';
import { spawnOwnedCommand } from '../process/owned-child';
import { terminateOwnedGroup } from '../process/terminate';
import type { AgentProcessSandbox } from './sandbox';
import { SandboxError } from './sandbox-contract';

/**
 * All entry paths share one command admission limit and one shutdown barrier.
 *
 * A slot is released once the child's pipes closed and its command owner settled. A
 * `COMMAND_CLEANUP` outcome means the death of the child's group was not proven, so its
 * slot stays occupied: `size` keeps counting it, `admit` keeps refusing at the limit and
 * `stop` keeps rejecting with the cleanup error. Admitting new work beside processes that
 * may still run would defeat the limit; the sandbox session is recreated to recover.
 */
export function sandboxProcessOwner(assertActive: () => void, maximum: number) {
  const children = new Map<
    ChildProcessWithoutNullStreams,
    { closed: Promise<void>; closeEvent: Promise<void> }
  >();
  const admit = () => {
    assertActive();
    if (children.size >= maximum)
      throw new SandboxError('SANDBOX_BUSY', 'Sandbox command concurrency limit reached');
  };
  const terminate = (child: ChildProcessWithoutNullStreams, closeEvent: Promise<void>) =>
    nativeCommandOwner(child)?.terminate() ??
    terminateOwnedGroup(child, closeEvent, COMMAND_CLEANUP_TIMEOUT_MS);
  const track = (child: ChildProcessWithoutNullStreams) => {
    const closeEvent = new Promise<void>((resolve) => {
      child.once('close', () => resolve());
    });
    const settleDirect = () => {
      // The group must be stopped and its pipes closed before the raw launcher releases its handles.
      if (!nativeCommandOwner(child)) void terminate(child, closeEvent).catch(() => undefined);
    };
    child.once('exit', settleDirect);
    child.once('error', settleDirect);
    const closed = new Promise<void>((resolve, reject) => {
      child.once('close', () => {
        const settled = nativeCommandOwner(child)?.result ?? Promise.resolve();
        void settled.then(
          () => {
            children.delete(child);
            resolve();
          },
          (error) => {
            if (error instanceof NativeCommandError && error.code === 'COMMAND_CLEANUP')
              reject(error);
            else {
              children.delete(child);
              resolve();
            }
          },
        );
      });
    });
    void closed.catch(() => undefined);
    children.set(child, { closed, closeEvent });
  };
  return {
    admit,
    track,
    get size() {
      return children.size;
    },
    spawn(input: Parameters<AgentProcessSandbox['prepare']>[0]) {
      admit();
      const child = spawnOwnedCommand({
        executable: input.executable,
        args: input.args,
        cwd: input.cwd,
        env: input.environment,
        group: process.platform !== 'win32',
      });
      child.stdin.end();
      track(child);
      return child;
    },
    async stop() {
      const pending = [...children];
      await Promise.all(
        pending.map(([child, { closeEvent }]) => terminate(child, closeEvent)),
      );
      await Promise.all(pending.map(([, { closed }]) => closed));
    },
  };
}
