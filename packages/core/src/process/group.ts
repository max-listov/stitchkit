import { raceAbort } from '../internal/abort-race';
import { NativeCommandError } from './contract';

function deniedOnDarwin(error: unknown): boolean {
  return (
    process.platform === 'darwin' &&
    error instanceof Error &&
    'code' in error &&
    error.code === 'EPERM'
  );
}

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
    // Darwin filters zombies out of killpg and can report EPERM until they
    // are reaped. It is still an existing/unknown group, never proof of death.
    if (deniedOnDarwin(error)) return true;
    throw error;
  }
}

async function signalUntilSettled(
  pid: number | undefined,
  signal: NodeJS.Signals,
  deadline: number,
): Promise<void> {
  for (;;) {
    try {
      signalGroup(pid, signal);
      return;
    } catch (error) {
      // Do not suppress permission failures. Success requires an actual
      // delivered signal or ESRCH; a persistent refusal keeps its own cause.
      if (!deniedOnDarwin(error) || Date.now() >= deadline) throw error;
      await new Promise((resolve) => setTimeout(resolve, Math.min(10, deadline - Date.now())));
    }
  }
}

export async function stopCommandGroup(
  pid: number | undefined,
  graceMs: number,
  cleanupTimeoutMs = 2000,
): Promise<void> {
  const deadline = Date.now() + graceMs + cleanupTimeoutMs;
  await signalUntilSettled(pid, 'SIGTERM', deadline);
  const until = Date.now() + graceMs;
  while (Date.now() < until && exists(pid))
    await new Promise((resolve) => setTimeout(resolve, Math.min(10, until - Date.now())));
  // Includes members holding a pipe after the leader already exited. A zombie
  // group can remain visible until the OS reaper runs, so ESRCH is not a success gate.
  await signalUntilSettled(pid, 'SIGKILL', deadline);
}

export function commandCleanupError(cause: unknown): NativeCommandError {
  return new NativeCommandError('COMMAND_CLEANUP', 'Command cleanup did not complete', {
    cause,
  });
}

export function waitForCommandClose<T>(closed: Promise<T>, timeoutMs: number): Promise<T> {
  return raceAbort(closed, AbortSignal.timeout(timeoutMs));
}
