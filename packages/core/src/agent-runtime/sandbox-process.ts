import type { ChildProcessWithoutNullStreams } from 'node:child_process';
import { startNativeCommand } from '../process/command-owner';
import { NativeCommandError } from '../process/contract';
import { SandboxError, type SandboxProcess, type SandboxRunOptions } from './sandbox-contract';

/** Sandbox admission and mandatory caps adapt the shared native command owner. */
export function spawnSandboxProcess(
  executable: string,
  args: string[],
  limits: { timeoutMs: number; maxOutputBytes: number },
  options: SandboxRunOptions = {},
  onSpawn?: (child: ChildProcessWithoutNullStreams) => void,
): SandboxProcess {
  const command = startNativeCommand(
    {
      executable,
      args,
      timeoutMs: limits.timeoutMs,
      maxOutputBytes: limits.maxOutputBytes,
      signal: options.signal,
      capture: true,
      envPolicy: 'declared-only',
      env: {},
      stop: { target: 'group', graceMs: 0 },
      ...(options.stdin !== undefined
        ? {
            stdin:
              typeof options.stdin === 'string'
                ? new TextEncoder().encode(options.stdin)
                : options.stdin,
            maxStdinBytes: Math.max(
              1,
              typeof options.stdin === 'string'
                ? Buffer.byteLength(options.stdin)
                : options.stdin.byteLength,
            ),
          }
        : {}),
    },
    onSpawn,
  );
  const result = command.result
    .then((result) => ({
      exitCode: result.exitCode ?? 137,
      stdout: result.stdout,
      stderr: result.stderr,
    }))
    .catch((error) => {
      if (error instanceof NativeCommandError)
        throw new SandboxError(
          error.code === 'COMMAND_LIMIT' ? 'SANDBOX_LIMIT' : 'SANDBOX_UNAVAILABLE',
          error.message,
          { cause: error },
        );
      throw error;
    });
  void result.catch(() => undefined);
  return { result, stop: command.stop };
}
