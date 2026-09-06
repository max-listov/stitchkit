import type { ReleaseMarker } from '../release/marker';
import type { SignalSource } from './process-signals';

/**
 * The one signal a deploy may borrow: user-defined, and the only such one the
 * process-signal vocabulary knows — anything else would take a termination
 * away from `bindProcessSignals`.
 */
export type ReleaseRefreshSignal = 'SIGUSR2';

export interface ReleaseRefreshSignalOptions {
  /** `SIGUSR2` — the signal a frontend-only deploy sends. Never a termination signal. */
  signal?: ReleaseRefreshSignal;
  /** `process` by default; a test passes its own. */
  source?: Pick<SignalSource, 'on' | 'off'>;
  /** Hear each refresh — to log "build id → X". */
  onRefresh?: (result: { changed: boolean; buildId: string | null }) => void;
  /** Hear a refresh or `onRefresh` that threw. The handler itself never does: an exception in a signal handler ends the process. */
  onError?: (error: unknown) => void;
}

/**
 * A deploy that replaced the frontend without restarting the backend has to
 * tell the backend; a process signal is that message. This binds it to
 * `marker.refresh()`, whose subscribers (the socket binding) do the telling.
 *
 * The signal's sender is a **release step of the application** — `kill -USR2
 * <pid>` or `pm2 sendSignal SIGUSR2 <name>` after the frontend is active —
 * and belongs in its deploy script, named, not in a comment. Bind early: a
 * signal with no listener kills the process by default. Do not also list the
 * same signal in `bindProcessSignals`, which would shut the server down on
 * every deploy.
 */
export function bindReleaseRefreshSignal(
  marker: ReleaseMarker,
  options: ReleaseRefreshSignalOptions = {},
): () => void {
  const signal = options.signal ?? 'SIGUSR2';
  const source: Pick<SignalSource, 'on' | 'off'> = options.source ?? process;
  const handler = () => {
    try {
      options.onRefresh?.(marker.refresh());
    } catch (error) {
      try {
        options.onError?.(error);
      } catch {
        // Nowhere further to report.
      }
    }
  };
  source.on(signal, handler);
  return () => source.off(signal, handler);
}
