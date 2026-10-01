import { raceAbort } from '../internal/abort-race';
import { NativeCommandError } from './contract';

export function signalGroup(pid: number | undefined, signal: NodeJS.Signals): void {
  if (pid === undefined) return;
  try {
    process.kill(-pid, signal);
  } catch (error) {
    if (!(error instanceof Error && 'code' in error && error.code === 'ESRCH')) throw error;
  }
}
function exists(pid: number | undefined): boolean {
  if (pid === undefined) return false;
  try {
    process.kill(-pid, 0);
    return true;
  } catch (error) {
    if (error instanceof Error && 'code' in error && error.code === 'ESRCH') return false;
    throw error;
  }
}

export async function stopCommandGroup(
  pid: number | undefined,
  graceMs: number,
): Promise<void> {
  signalGroup(pid, 'SIGTERM');
  const until = Date.now() + graceMs;
  while (Date.now() < until && exists(pid))
    await new Promise((resolve) => setTimeout(resolve, Math.min(10, until - Date.now())));
  // Includes members holding a pipe after the leader already exited. A zombie
  // group can remain visible until the OS reaper runs, so ESRCH is not a success gate.
  signalGroup(pid, 'SIGKILL');
}

export function commandCleanupError(cause: unknown): NativeCommandError {
  return new NativeCommandError('COMMAND_CLEANUP', 'Command cleanup did not complete', {
    cause,
  });
}

export function waitForCommandClose<T>(closed: Promise<T>, timeoutMs: number): Promise<T> {
  return raceAbort(closed, AbortSignal.timeout(timeoutMs));
}
