import { type ChildProcessWithoutNullStreams, spawn } from 'node:child_process';
import { SandboxError, type SandboxProcess, type SandboxRunOptions } from './sandbox-contract';

/** Owns the host wrapper through close, including bounded collection and process-group kill. */
export function spawnSandboxProcess(
  executable: string,
  args: string[],
  limits: { timeoutMs: number; maxOutputBytes: number },
  options: SandboxRunOptions = {},
  onSpawn?: (child: ChildProcessWithoutNullStreams) => void,
): SandboxProcess {
  options.signal?.throwIfAborted();
  const child = spawn(executable, args, {
    env: {},
    detached: true,
    stdio: ['pipe', 'pipe', 'pipe'],
  });
  onSpawn?.(child);
  const stdout: Buffer[] = [];
  const stderr: Buffer[] = [];
  let bytes = 0;
  let failure: unknown;
  let finished = false;
  const kill = () => {
    if (finished || child.pid === undefined) return;
    try {
      process.kill(-child.pid, 'SIGKILL');
    } catch (error) {
      if (!(error instanceof Error && 'code' in error && error.code === 'ESRCH'))
        failure ??= error;
    }
  };
  const abort = () => {
    failure ??= options.signal?.reason ?? new Error('Sandbox command aborted');
    kill();
  };
  const timer = setTimeout(() => {
    failure ??= new SandboxError('SANDBOX_LIMIT', 'Sandbox command deadline exceeded');
    kill();
  }, limits.timeoutMs);
  timer.unref();
  const result = new Promise<{ exitCode: number; stdout: Uint8Array; stderr: Uint8Array }>(
    (resolve, reject) => {
      const collect = (target: Buffer[]) => (chunk: Buffer) => {
        bytes += chunk.byteLength;
        if (bytes > limits.maxOutputBytes) {
          failure ??= new SandboxError('SANDBOX_LIMIT', 'Sandbox output limit exceeded');
          kill();
        } else target.push(chunk);
      };
      child.stdout.on('data', collect(stdout));
      child.stderr.on('data', collect(stderr));
      child.on('error', (error) => {
        failure ??= new SandboxError(
          'SANDBOX_UNAVAILABLE',
          'Sandbox process could not start',
          { cause: error },
        );
      });
      child.stdin.on('error', (error) => {
        if (!('code' in error && error.code === 'EPIPE')) {
          failure ??= error;
          kill();
        }
      });
      child.on('close', (code) => {
        finished = true;
        clearTimeout(timer);
        options.signal?.removeEventListener('abort', abort);
        if (failure !== undefined) reject(failure);
        else
          resolve({
            exitCode: code ?? 137,
            stdout: Buffer.concat(stdout),
            stderr: Buffer.concat(stderr),
          });
      });
    },
  );
  // The handle may be stopped before its caller starts awaiting result.
  void result.catch(() => undefined);
  options.signal?.addEventListener('abort', abort, { once: true });
  if (options.signal?.aborted) abort();
  child.stdin.end(options.stdin);
  return {
    result,
    async stop() {
      kill();
      await result.then(
        () => undefined,
        () => undefined,
      );
    },
  };
}
