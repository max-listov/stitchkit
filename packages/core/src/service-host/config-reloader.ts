import { untilAborted } from '../internal/abort-race';
import { assertTimerMs } from '../internal/deadline';
import type {
  ConfigReloader,
  ConfigReloaderOptions,
  ConfigReloaderPhase,
  ConfigReloaderShutdownOptions,
  ConfigReloaderShutdownResult,
  ConfigReloaderState,
  ConfigReloaderStatus,
} from './config-reloader-contract';
import {
  armShutdownDeadline,
  isPromiseLike,
  type ResolvedReloaderSettings,
  resolveReloaderSettings,
  startInitialReloaderHandle,
} from './config-reloader-helpers';
import {
  type ConfigSourceReading,
  runBoundedOperation,
  safeCallObserver,
  validateConfigValue,
} from './config-reloader-source';

export {
  type ConfigReloader,
  type ConfigReloaderError,
  type ConfigReloaderOptions,
  type ConfigReloaderPhase,
  type ConfigReloaderShutdownOptions,
  type ConfigReloaderShutdownResult,
  type ConfigReloaderState,
  type ConfigReloaderStatus,
  DEFAULT_CONFIG_POLL_INTERVAL_MS,
  DEFAULT_CONFIG_START_TIMEOUT_MS,
  DEFAULT_CONFIG_STOP_TIMEOUT_MS,
} from './config-reloader-contract';
export {
  type ConfigReloaderClock,
  type ConfigSource,
  type ConfigSourceReading,
  createPolledJsonConfigSource,
  type PolledJsonConfigSourceOptions,
} from './config-reloader-source';

class ReloaderController<TConfig, THandle> implements ConfigReloader {
  private state: ConfigReloaderState = 'running';
  private lastInvalidKey: string | null = null;
  private lastFailedStartDigest: string | null = null;
  private reloads = 0;
  private failedReloads = 0;
  private pollCancel: (() => void) | null = null;
  private inFlight: Promise<void> | null = null;
  private pending: { promise: Promise<void>; resolve: () => void } | null = null;
  private shutdownPromise: Promise<ConfigReloaderShutdownResult> | null = null;
  private readonly shutdownAbort = new AbortController();
  /** The config to start again on the next poll while nothing is running. */
  private retry: { config: TConfig; digest: string } | null = null;
  /** A stop that outlived its timeout: the handle is neither running nor stopped until it settles. */
  private stopInFlight: { handle: THandle; settled: Promise<'stopped' | 'failed'> } | null =
    null;

  constructor(
    private readonly options: ConfigReloaderOptions<TConfig, THandle>,
    private readonly cfg: ResolvedReloaderSettings,
    private active: { handle: THandle | null; config: TConfig; digest: string | null },
  ) {
    this.schedulePoll();
  }

  private stopping = (): boolean => this.state === 'closing' || this.state === 'closed';

  status = (): ConfigReloaderStatus => ({
    state: this.state,
    activeDigest: this.active.digest,
    lastInvalidKey: this.lastInvalidKey,
    lastFailedStartDigest: this.lastFailedStartDigest,
    reloads: this.reloads,
    failedReloads: this.failedReloads,
    hasActiveHandle: this.active.handle !== null,
  });

  triggerReload(): Promise<void> {
    if (this.stopping()) return Promise.resolve();
    this.pollCancel?.();
    this.pollCancel = null;
    if (this.inFlight === null) {
      this.inFlight = this.drainLoop();
      return this.inFlight;
    }
    this.pending ??= Promise.withResolvers<void>();
    return this.pending.promise;
  }

  shutdown(opts: ConfigReloaderShutdownOptions = {}): Promise<ConfigReloaderShutdownResult> {
    if (this.shutdownPromise !== null) return this.shutdownPromise;
    try {
      assertTimerMs('gracePeriodMs', opts.gracePeriodMs, { min: 0 });
    } catch (error) {
      return Promise.reject(error);
    }
    const startedAt = this.cfg.clock.now();
    this.state = 'closing';
    this.pollCancel?.();
    this.pollCancel = null;
    this.pending?.resolve();
    this.pending = null;

    const deadline = armShutdownDeadline(
      this.shutdownAbort,
      opts,
      this.cfg.stopMs,
      this.cfg.clock,
    );

    this.shutdownPromise = (async (): Promise<ConfigReloaderShutdownResult> => {
      try {
        if (this.inFlight !== null)
          await untilAborted(this.inFlight, this.shutdownAbort.signal);
        if (this.active.handle !== null) {
          const handle = this.active.handle;
          this.active.handle = null;
          let reported = false;
          const reportStopError = (error: unknown) => {
            if (reported) return;
            reported = true;
            this.emitError('shutdown', error, this.active.digest ?? undefined);
          };
          // A stop already running for this handle is the stop: wait for it. Only one that
          // failed leaves the handle for another attempt, and that attempt comes after it.
          const earlier =
            this.stopInFlight?.handle === handle ? this.stopInFlight.settled : undefined;
          const task = Promise.resolve(earlier ?? ('failed' as const)).then((outcome) =>
            outcome === 'stopped'
              ? undefined
              : this.options.stop(handle, this.shutdownAbort.signal),
          );
          void task.catch((error: unknown) => {
            if (deadline.forcedReason() !== undefined) reportStopError(error);
          });
          if (deadline.forcedReason() === undefined) {
            try {
              await untilAborted(task, this.shutdownAbort.signal);
            } catch (error) {
              reportStopError(error);
              throw error;
            }
          }
        }
        const forced = deadline.forcedReason();
        return {
          outcome: forced !== undefined ? 'forced' : 'clean',
          ...(forced !== undefined && { reason: forced }),
          reloads: this.reloads,
          failedReloads: this.failedReloads,
          durationMs: Math.max(0, this.cfg.clock.now() - startedAt),
        };
      } finally {
        deadline.disarm();
        this.state = 'closed';
      }
    })();
    return this.shutdownPromise;
  }

  private schedulePoll(): void {
    if (this.stopping() || this.pollCancel !== null) return;
    this.pollCancel = this.cfg.clock.schedule(() => {
      this.pollCancel = null;
      if (!this.stopping()) void this.triggerReload();
    }, this.cfg.pollMs);
  }

  private emitError(phase: ConfigReloaderPhase, error: unknown, digest?: string): void {
    safeCallObserver(() =>
      this.options.onError?.({ phase, error, ...(digest !== undefined && { digest }) }),
    );
  }

  private emitInvalid(detail: string, key: string): boolean {
    if (this.lastInvalidKey === key) return false;
    this.lastInvalidKey = key;
    safeCallObserver(() => this.options.onInvalidConfig?.(detail, key));
    return true;
  }

  private async waitForClosingStop(stopTask: Promise<void>, digest?: string): Promise<void> {
    const guarded = stopTask.catch((error: unknown) => {
      this.emitError('shutdown', error, digest);
    });
    await untilAborted(guarded, this.shutdownAbort.signal);
  }

  private stopLate(handle: THandle, digest: string): Promise<void> {
    // Runs in its own stopTimeoutMs budget without parent shutdownAbort so late handles
    // are still stopped cleanly even after a forced shutdown or start() timeout.
    return runBoundedOperation(
      'stop',
      (sig) => this.options.stop(handle, sig),
      this.cfg.stopMs,
      this.cfg.clock,
    ).catch((err: unknown) =>
      this.emitError(this.stopping() ? 'shutdown' : 'stop', err, digest),
    );
  }

  private async stopHandleOnClose(handle: THandle, digest: string): Promise<void> {
    if (this.shutdownAbort.signal.aborted) {
      void this.stopLate(handle, digest);
      return;
    }
    const stopTask = Promise.resolve().then(() =>
      this.options.stop(handle, this.shutdownAbort.signal),
    );
    await this.waitForClosingStop(stopTask, digest);
  }

  private async startCandidate(
    config: TConfig,
    digest: string,
  ): Promise<{ ok: true; handle: THandle } | { ok: false; closed: boolean; error?: unknown }> {
    const startState: {
      task: Promise<THandle> | null;
      outcome: 'pending' | 'resolved' | 'rejected';
    } = { task: null, outcome: 'pending' };
    let lateCleanup: Promise<void> | null = null;
    const cleanupLate = (late: THandle): Promise<void> => {
      if (lateCleanup !== null) return lateCleanup;
      lateCleanup =
        this.stopping() && !this.shutdownAbort.signal.aborted
          ? this.stopHandleOnClose(late, digest)
          : this.stopLate(late, digest);
      return lateCleanup;
    };
    try {
      const handle = await runBoundedOperation(
        'start',
        (sig) => {
          let result: THandle | Promise<THandle>;
          try {
            result = this.options.start(config, sig);
          } catch (syncError) {
            startState.outcome = 'rejected';
            throw syncError;
          }
          if (isPromiseLike(result)) {
            const task = Promise.resolve(result);
            startState.task = task;
            task.then(
              () => {
                startState.outcome = 'resolved';
              },
              () => {
                startState.outcome = 'rejected';
              },
            );
          } else {
            startState.outcome = 'resolved';
          }
          return result;
        },
        this.cfg.startMs,
        this.cfg.clock,
        this.shutdownAbort.signal,
        (late) => {
          void cleanupLate(late);
        },
      );
      if (this.stopping()) {
        await this.stopHandleOnClose(handle, digest);
        return { ok: false, closed: true };
      }
      return { ok: true, handle };
    } catch (error) {
      if (!this.stopping()) return { ok: false, closed: false, error };
      // Symmetric with applyValidated: when startTimeoutMs < gracePeriodMs, do not let
      // shutdown() resolve 'clean' while start() or stopping its late handle is still running.
      if (
        startState.outcome !== 'rejected' &&
        startState.task !== null &&
        !this.shutdownAbort.signal.aborted
      ) {
        const settledStart = startState.task.then(cleanupLate, () => undefined);
        await untilAborted(settledStart, this.shutdownAbort.signal);
      }
      return { ok: false, closed: true };
    }
  }

  private async drainLoop(): Promise<void> {
    try {
      await this.checkOnce();
      while (this.pending !== null && !this.stopping()) {
        const slot = this.pending;
        this.pending = null;
        try {
          await this.checkOnce();
        } finally {
          slot.resolve();
        }
      }
    } finally {
      this.inFlight = null;
      this.pending?.resolve();
      this.pending = null;
      if (!this.stopping()) this.schedulePoll();
    }
  }

  private async checkOnce(): Promise<void> {
    if (this.stopping() || this.stopInFlight !== null) return;
    let reading: ConfigSourceReading<TConfig>;
    try {
      reading = await this.options.source.read();
    } catch (error) {
      return this.emitError('read', error);
    }
    // Only a shutdown can start while the source is read: a late stop is set by
    // `applyValidated`, which runs in this same drain after the read.
    if (this.stopping()) return;
    if (reading.state === 'unchanged') {
      // Nothing is running and the source has nothing new: the last config that failed to
      // start is tried again, so a port still held by the previous process heals by itself.
      if (this.active.handle === null && this.retry !== null) {
        await this.applyValidated(this.retry.config, this.retry.digest);
      }
      return;
    }
    if (reading.state === 'missing') {
      this.retry = null;
      this.emitInvalid('Config is missing', 'missing');
      return;
    }
    if (reading.state === 'invalid') {
      this.retry = null;
      this.emitInvalid(reading.detail, reading.failureKey);
      return;
    }
    if (reading.digest === this.active.digest && this.active.handle !== null) {
      this.lastInvalidKey = null;
      this.lastFailedStartDigest = null;
      return;
    }
    // A config that failed while the previous one kept running is not restarted in a loop.
    // With nothing running there is no previous one to protect, and the poll is the retry.
    if (reading.digest === this.lastFailedStartDigest && this.active.handle !== null) return;
    const valid = await validateConfigValue(
      this.options.validate,
      reading.config,
      reading.digest,
    );
    if (!valid.ok) {
      this.retry = null;
      if (this.emitInvalid(valid.detail, valid.key)) {
        this.emitError('validate', valid.error, reading.digest);
      }
      return;
    }
    this.lastInvalidKey = null;
    if (!this.stopping()) await this.applyValidated(reading.config, reading.digest);
  }

  private async applyValidated(config: TConfig, digest: string): Promise<void> {
    this.state = 'reloading';
    const prev = { ...this.active };
    if (prev.handle !== null) {
      const oldHandle = prev.handle;
      // Cleared before stop runs, so a shutdown() arriving meanwhile finds no handle to stop.
      this.active.handle = null;
      let stopTask: Promise<void> = Promise.resolve();
      let stopSettled = false;
      try {
        await runBoundedOperation(
          'stop',
          (sig) => {
            stopTask = Promise.resolve().then(() => this.options.stop(oldHandle, sig));
            const settle = () => {
              stopSettled = true;
            };
            stopTask.then(settle, settle);
            return stopTask;
          },
          this.cfg.stopMs,
          this.cfg.clock,
          this.shutdownAbort.signal,
        );
      } catch (error) {
        if (this.stopping()) {
          if (stopSettled) {
            if (!this.shutdownAbort.signal.aborted) {
              this.emitError('shutdown', error, prev.digest ?? undefined);
            }
          } else {
            await this.waitForClosingStop(stopTask, prev.digest ?? undefined);
          }
          return;
        }
        this.active.handle = oldHandle;
        this.failedReloads += 1;
        this.lastFailedStartDigest = digest;
        this.state = 'degraded';
        if (!stopSettled) this.followLateStop(oldHandle, stopTask, config, digest);
        return this.emitError('stop', error, digest);
      }
    }
    if (this.stopping()) return;

    const started = await this.startCandidate(config, digest);
    if (started.ok) {
      this.active = { handle: started.handle, config, digest };
      this.retry = null;
      this.lastFailedStartDigest = null;
      this.reloads += 1;
      this.state = 'running';
      return safeCallObserver(() => this.options.onReload?.(digest));
    }
    if (started.closed) return;

    this.failedReloads += 1;
    this.lastFailedStartDigest = digest;
    this.emitError('start', started.error, digest);
    if (this.cfg.rollback && prev.digest !== null) {
      const rolled = await this.startCandidate(prev.config, prev.digest);
      if (rolled.ok) {
        this.active = { handle: rolled.handle, config: prev.config, digest: prev.digest };
        this.retry = null;
        this.state = 'running';
        return;
      }
      if (rolled.closed) return;
      this.emitError('rollback', rolled.error, prev.digest);
    }
    this.active.handle = null;
    this.active.digest = null;
    this.retry = { config, digest };
    this.state = 'degraded';
  }

  /**
   * Keep one stop per handle after its timeout. The timed-out stop is still running, so
   * until it settles no reload and no shutdown may start another for the same handle; when
   * it does stop the handle, the config that waited behind it is started.
   */
  private followLateStop(
    handle: THandle,
    stopTask: Promise<void>,
    config: TConfig,
    digest: string,
  ): void {
    const settled = stopTask.then(
      () => 'stopped' as const,
      () => 'failed' as const,
    );
    this.stopInFlight = { handle, settled };
    void settled.then((outcome) => {
      if (this.stopInFlight?.handle !== handle) return;
      this.stopInFlight = null;
      if (outcome !== 'stopped' || this.active.handle !== handle) return;
      this.active.handle = null;
      this.active.digest = null;
      this.lastFailedStartDigest = null;
      this.retry = { config, digest };
      if (!this.stopping()) void this.triggerReload();
    });
  }
}

/** Start a supervised in-process config reloader with pre-stop validation, rollback, and `ShutdownTarget` support. */
export async function startConfigReloader<TConfig, THandle>(
  options: ConfigReloaderOptions<TConfig, THandle>,
): Promise<ConfigReloader> {
  const cfg = resolveReloaderSettings(options);
  const initial = await startInitialReloaderHandle(options, cfg);
  return new ReloaderController(options, cfg, initial);
}
