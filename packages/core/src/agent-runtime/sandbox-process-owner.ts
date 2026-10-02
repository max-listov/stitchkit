import { type ChildProcessWithoutNullStreams, spawn } from 'node:child_process';
import { startNativeCommand } from '../process/command-owner';
import { NativeCommandError } from '../process/contract';
import { nativeCommandOwner } from '../process/launch';
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
  const track = (child: ChildProcessWithoutNullStreams) => {
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
      const child = spawn(input.executable, [...input.args], {
        cwd: input.cwd,
        env: input.environment,
        detached: true,
        stdio: ['pipe', 'pipe', 'pipe'],
      });
      child.stdin.end();
      track(child);
      return child;
    },
    async stop() {
      const pending = [...children];
      await Promise.all(
        pending.map(([child]) => {
          // A direct host launcher has no execution owner until coding adopts it.
          // Shutdown adopts that same transport before cancelling, rather than owning a second kill path.
          let owner = nativeCommandOwner(child);
          if (!owner) {
            const adopted = startNativeCommand(
              { executable: 'host-owned-command', signal: new AbortController().signal },
              undefined,
              { launch: () => child, group: process.platform !== 'win32', force: true },
            );
            owner = nativeCommandOwner(child);
            if (!owner) return adopted.stop();
          }
          return owner.terminate();
        }),
      );
      await Promise.all(pending.map(([, closed]) => closed));
    },
  };
}
