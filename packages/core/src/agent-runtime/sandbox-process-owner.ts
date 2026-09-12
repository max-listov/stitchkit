import { type ChildProcessWithoutNullStreams, spawn } from 'node:child_process';
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
    const closed = new Promise<void>((resolve) => {
      child.once('close', () => {
        children.delete(child);
        resolve();
      });
    });
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
      for (const [child] of pending) {
        if (child.pid === undefined) continue;
        try {
          process.kill(-child.pid, 'SIGKILL');
        } catch (error) {
          if (!(error instanceof Error && 'code' in error && error.code === 'ESRCH'))
            throw error;
        }
      }
      await Promise.all(pending.map(([, closed]) => closed));
    },
  };
}
