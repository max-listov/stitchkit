import { assertTimerMs } from '../internal/deadline';
import {
  type ConfigReloaderOptions,
  type ConfigReloaderShutdownOptions,
  DEFAULT_CONFIG_POLL_INTERVAL_MS,
  DEFAULT_CONFIG_START_TIMEOUT_MS,
  DEFAULT_CONFIG_STOP_TIMEOUT_MS,
} from './config-reloader-contract';
import {
  type ConfigReloaderClock,
  DEFAULT_CONFIG_RELOADER_CLOCK,
  runBoundedOperation,
  safeCallObserver,
  validateConfigValue,
} from './config-reloader-source';

/** Validated timing, rollback, and clock settings derived from {@link ConfigReloaderOptions}. */
export interface ResolvedReloaderSettings {
  readonly pollMs: number;
  readonly startMs: number;
  readonly stopMs: number;
  readonly rollback: boolean;
  readonly clock: ConfigReloaderClock;
}

/** Resolve and validate timing bounds and defaults for a config reloader. */
export function resolveReloaderSettings<TConfig, THandle>(
  options: ConfigReloaderOptions<TConfig, THandle>,
): ResolvedReloaderSettings {
  const settings: ResolvedReloaderSettings = {
    pollMs: options.pollIntervalMs ?? DEFAULT_CONFIG_POLL_INTERVAL_MS,
    startMs: options.startTimeoutMs ?? DEFAULT_CONFIG_START_TIMEOUT_MS,
    stopMs: options.stopTimeoutMs ?? DEFAULT_CONFIG_STOP_TIMEOUT_MS,
    rollback: options.rollbackOnStartFailure ?? true,
    clock: options.clock ?? DEFAULT_CONFIG_RELOADER_CLOCK,
  };
  assertTimerMs('pollIntervalMs', settings.pollMs);
  assertTimerMs('startTimeoutMs', settings.startMs);
  assertTimerMs('stopTimeoutMs', settings.stopMs);
  return settings;
}

/**
 * Read and validate the initial config snapshot and start the initial handle,
 * stopping any late-resolving handle if startup times out.
 */
export async function startInitialReloaderHandle<TConfig, THandle>(
  options: ConfigReloaderOptions<TConfig, THandle>,
  cfg: ResolvedReloaderSettings,
): Promise<{ handle: THandle; config: TConfig; digest: string }> {
  const initial = await options.source.read();
  if (initial.state !== 'valid') {
    if (initial.state === 'unchanged') throw new Error('Config source returned unchanged');
    const detail = initial.state === 'invalid' ? initial.detail : 'Config is missing';
    const key = initial.state === 'invalid' ? initial.failureKey : 'missing';
    safeCallObserver(() => options.onInvalidConfig?.(detail, key));
    throw new Error(`Startup config failed: ${detail}`);
  }
  const valid = await validateConfigValue(options.validate, initial.config, initial.digest);
  if (!valid.ok) {
    safeCallObserver(() => options.onInvalidConfig?.(valid.detail, valid.key));
    throw valid.error;
  }
  const handle = await runBoundedOperation(
    'start',
    (sig) => options.start(initial.config, sig),
    cfg.startMs,
    cfg.clock,
    undefined,
    (lateHandle) => {
      void runBoundedOperation(
        'stop',
        (sig) => options.stop(lateHandle, sig),
        cfg.stopMs,
        cfg.clock,
      ).catch((err: unknown) =>
        safeCallObserver(() =>
          options.onError?.({ phase: 'stop', error: err, digest: initial.digest }),
        ),
      );
    },
  );
  return { handle, config: initial.config, digest: initial.digest };
}

/** Narrow a sync-or-async return value to a thenable without wrapping sync values. */
export function isPromiseLike<T>(value: T | PromiseLike<T>): value is PromiseLike<T> {
  return (
    (typeof value === 'object' || typeof value === 'function') &&
    value !== null &&
    'then' in value &&
    typeof value.then === 'function'
  );
}

/**
 * Arm the deadline timer and external abort listener for a reloader shutdown,
 * aborting `shutdownAbort` at most once and returning a forced-reason reader and cleanup.
 */
export function armShutdownDeadline(
  shutdownAbort: AbortController,
  opts: ConfigReloaderShutdownOptions,
  defaultGraceMs: number,
  clock: ConfigReloaderClock,
): { forcedReason(): 'deadline' | 'signal' | undefined; disarm(): void } {
  let forced: 'deadline' | 'signal' | undefined;
  let cancelDeadline: (() => void) | null = null;
  const force = (reason: 'deadline' | 'signal') => {
    if (forced !== undefined) return;
    forced = reason;
    shutdownAbort.abort(new Error(`ConfigReloader shutdown forced by ${reason}`));
  };
  const onExternal = () => force('signal');
  const graceMs = opts.gracePeriodMs ?? defaultGraceMs;
  if (opts.signal?.aborted) force('signal');
  else if (graceMs === 0) force('deadline');
  else {
    opts.signal?.addEventListener('abort', onExternal, { once: true });
    cancelDeadline = clock.schedule(() => force('deadline'), graceMs);
  }
  return {
    forcedReason: () => forced,
    disarm() {
      cancelDeadline?.();
      opts.signal?.removeEventListener('abort', onExternal);
    },
  };
}
