/**
 * What a config reloader is asked to do and what it reports: options, states, the status
 * snapshot and the shutdown result. The controller that implements it is `config-reloader.ts`.
 */
import type { ConfigReloaderClock, ConfigSource } from './config-reloader-source';

/** Default config poll interval in milliseconds (2 seconds). */
export const DEFAULT_CONFIG_POLL_INTERVAL_MS = 2_000;
/** Default timeout for starting a handle in milliseconds (30 seconds). */
export const DEFAULT_CONFIG_START_TIMEOUT_MS = 30_000;
/** Default timeout for stopping a handle in milliseconds (10 seconds). */
export const DEFAULT_CONFIG_STOP_TIMEOUT_MS = 10_000;

/** Lifecycle phase in which a config reloader error occurred. */
export type ConfigReloaderPhase =
  | 'read'
  | 'validate'
  | 'stop'
  | 'start'
  | 'rollback'
  | 'shutdown';
/** Current operational state of a config reloader controller. */
export type ConfigReloaderState = 'running' | 'reloading' | 'closing' | 'closed' | 'degraded';

/** Structured error event reported when a config reloader phase fails. */
export interface ConfigReloaderError {
  readonly phase: ConfigReloaderPhase;
  readonly error: unknown;
  readonly digest?: string;
}

/** Configuration options for creating a live-reloading service controller. */
export interface ConfigReloaderOptions<TConfig, THandle> {
  readonly source: ConfigSource<TConfig>;
  readonly validate?: (config: TConfig) => void | Promise<void>;
  readonly start: (config: TConfig, signal: AbortSignal) => THandle | Promise<THandle>;
  readonly stop: (handle: THandle, signal: AbortSignal) => void | Promise<void>;
  readonly pollIntervalMs?: number;
  readonly startTimeoutMs?: number;
  readonly stopTimeoutMs?: number;
  readonly rollbackOnStartFailure?: boolean;
  readonly clock?: ConfigReloaderClock;
  readonly onInvalidConfig?: (detail: string, failureKey: string) => void;
  readonly onReload?: (digest: string) => void;
  readonly onError?: (event: ConfigReloaderError) => void;
}

/** Structurally compatible with `ShutdownTarget` from `bindProcessSignals` (`gracePeriodMs: 0` allowed). */
export interface ConfigReloaderShutdownOptions {
  readonly signal?: AbortSignal;
  readonly gracePeriodMs?: number;
}

/** Outcome summary returned when a config reloader finishes shutting down. */
export interface ConfigReloaderShutdownResult {
  readonly outcome: 'clean' | 'forced';
  readonly reason?: 'deadline' | 'signal';
  readonly reloads: number;
  readonly failedReloads: number;
  readonly durationMs: number;
}

/** Point-in-time status snapshot of a config reloader controller. */
export interface ConfigReloaderStatus {
  readonly state: ConfigReloaderState;
  readonly activeDigest: string | null;
  readonly lastInvalidKey: string | null;
  readonly lastFailedStartDigest: string | null;
  readonly reloads: number;
  readonly failedReloads: number;
  readonly hasActiveHandle: boolean;
}

/** Controller interface for polling configuration changes, reloading handles, and shutting down. */
export interface ConfigReloader {
  status(): ConfigReloaderStatus;
  triggerReload(): Promise<void>;
  shutdown(options?: ConfigReloaderShutdownOptions): Promise<ConfigReloaderShutdownResult>;
}
