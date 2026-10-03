import type { ChildProcessWithoutNullStreams } from 'node:child_process';
import { startNativeCommand } from '../process/command-owner';
import { NativeCommandError } from '../process/contract';
import { nativeCommandOwner } from '../process/launch';
import { spawnOwnedCommand } from '../process/owned-child';
import type { AgentProcessSandbox } from './sandbox';
import { SandboxError } from './sandbox-contract';

/** All entry paths share one command admission limit and one shutdown barrier. */
export function sandboxProcessOwner(assertActive: () => void, maximum: number) {
  const children = new Map<ChildProcessWithoutNullStreams, Promise<void>>();
  const admit = () => {
    assertActive();
    if (children.size >= maximum)
      throw new SandboxError('SANDBOX_BUSY', 'Sandbox command concurrency limit reached');
  };
  const terminate = (child: ChildProcessWithoutNullStreams) => {
    const owner =
      nativeCommandOwner(child) ??
      startNativeCommand(
        { executable: 'host-owned-command', signal: new AbortController().signal },
        undefined,
        { launch: () => child, group: process.platform !== 'win32', force: true },
      );
    return owner.terminate();
  };
  const track = (child: ChildProcessWithoutNullStreams) => {
    const settleDirect = () => {
      // The execution owner must observe close before the raw launcher releases its handles.
      if (!nativeCommandOwner(child)) void terminate(child).catch(() => undefined);
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
    children.set(child, closed);
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
      await Promise.all(pending.map(([child]) => terminate(child)));
      await Promise.all(pending.map(([, closed]) => closed));
    },
  };
}
