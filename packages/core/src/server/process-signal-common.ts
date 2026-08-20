import type { ProcessSignalName, SignalSource } from './process-signals';

export const DEFAULT_PROCESS_SIGNALS: readonly ProcessSignalName[] = ['SIGINT', 'SIGTERM'];

export const defaultSignalSource: SignalSource = {
  on: (signal, handler) => {
    process.on(signal, handler);
  },
  off: (signal, handler) => {
    process.off(signal, handler);
  },
  raiseDefault: (signal) => {
    if (process.listenerCount(signal) > 0) return false;
    process.kill(process.pid, signal);
    return true;
  },
};

export function reportSignalError<TPhase extends string>(
  phase: TPhase,
  error: unknown,
  onError: ((phase: TPhase, error: unknown) => void) | undefined,
): void {
  try {
    onError?.(phase, error);
  } catch {
    // An error reporter has no further safe reporting path.
  }
}

export function guardSignalCallback<TPhase extends string>(
  run: () => void,
  phase: TPhase,
  onError: ((phase: TPhase, error: unknown) => void) | undefined,
): void {
  try {
    run();
  } catch (error) {
    reportSignalError(phase, error, onError);
  }
}
