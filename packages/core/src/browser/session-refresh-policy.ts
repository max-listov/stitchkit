import { type Backoff, type BackoffPolicy, createBackoff } from '../internal/backoff';
import type { SessionOperation } from './session';

/** Default lead before token expiry at which proactive refresh starts (60 s). */
export const DEFAULT_REFRESH_LEAD_MS = 60_000;
/** Default minimum monotonic pause between proactive refreshes (30 s). */
export const DEFAULT_REFRESH_COOLDOWN_MS = 30_000;
/** Default refresh request deadline (30 s). */
export const DEFAULT_REFRESH_TIMEOUT_MS = 30_000;
/** Default pause before retrying a failed post-rotation credential write (5 s). */
export const DEFAULT_STORAGE_RETRY_MS = 5_000;
/** Default exponential backoff with jitter for unavailable refresh endpoints. */
export const DEFAULT_REFRESH_RETRY_POLICY: BackoffPolicy = {
  minDelayMs: 30_000,
  maxDelayMs: 300_000,
  jitter: 0.5,
};

/**
 * Outcome of classifying a refresh-endpoint failure:
 * - `'rejected'` — the refresh credential is no longer accepted (default: HTTP 401 or 403).
 * - `'unavailable'` — network, timeout, 5xx or any other transient failure.
 */
export type SessionRefreshFailure = 'rejected' | 'unavailable';

/** The refresh endpoint rejected the credential. Proactive refresh stops for this generation; the host decides whether to sign out. */
export class SessionRefreshRejectedError extends Error {
  constructor(options?: { cause?: unknown }) {
    super('Session refresh was rejected', options);
    this.name = 'SessionRefreshRejectedError';
  }
}

/** Wall-clock, monotonic-clock and timer port for session refresh scheduling. */
export interface SessionClock {
  /** Wall-clock time in epoch milliseconds (compared against token `expiresAt`). */
  now(): number;
  /** Monotonic time in milliseconds (used for cooldowns and retry pauses). */
  monotonic(): number;
  /** Schedule `run` after `delayMs` milliseconds; returns a handle that cancels it. */
  schedule(run: () => void, delayMs: number): { cancel(): void };
}

/** Proactive refresh configuration: how to read expiry and how early/often to refresh. */
export interface SessionRefreshAhead<TCredentials> {
  /** Token expiry in wall-clock epoch milliseconds, or `null` when unknown (no proactive refresh). */
  expiresAt(credentials: TCredentials): number | null;
  /** How long before `expiresAt` to start refreshing (default 60_000 ms, capped at half the token lifetime). */
  readonly leadMs?: number;
  /** Minimum monotonic interval between proactive refreshes (default 30_000 ms, capped at half the token lifetime). */
  readonly cooldownMs?: number;
}

/** Result of restoring a persisted session on startup. */
export type SessionRestoreResult<TSession> =
  | { readonly status: 'present'; readonly operation: SessionOperation<TSession> }
  | { readonly status: 'absent' }
  | { readonly status: 'unreadable'; readonly error: unknown };

/** Options for an explicit `refresh(operation, options)` call. */
export interface SessionRefreshOptions<TCredentials> {
  /** Credentials the server rejected; if memory already holds newer ones, refresh returns them without rotating again. */
  readonly rejected?: TCredentials;
}

/** Lifecycle events emitted by `createSessionCredentials` (never `SessionExpiredError`). */
export type SessionCredentialsEvent<TSession> =
  | {
      readonly type: 'refreshed';
      readonly operation: SessionOperation<TSession>;
      readonly expiresAt: number | null;
    }
  | {
      readonly type: 'refresh-unavailable';
      readonly operation: SessionOperation<TSession>;
      readonly error: unknown;
      readonly retryInMs: number | null;
      readonly expiresAt: number | null;
    }
  | {
      readonly type: 'refresh-rejected';
      readonly operation: SessionOperation<TSession>;
      readonly error: unknown;
    }
  | {
      readonly type: 'storage-failed';
      readonly operation: SessionOperation<TSession>;
      readonly error: unknown;
      readonly retryInMs: number;
    };

/** Default clock backed by `Date.now`, `performance.now` and unref'd `setTimeout`. */
export function createDefaultSessionClock(): SessionClock {
  return {
    now: () => Date.now(),
    monotonic: () => performance.now(),
    schedule(run, delayMs) {
      const handle = setTimeout(run, delayMs);
      handle.unref?.();
      return {
        cancel() {
          clearTimeout(handle);
        },
      };
    },
  };
}

function effectiveRefreshLeadMs(
  expiresAt: number,
  receivedAt: number,
  leadMs: number,
): number {
  const lifetime = Math.max(0, expiresAt - receivedAt);
  return Math.min(leadMs, Math.floor(lifetime / 2));
}

/**
 * Delay in milliseconds before starting proactive refresh for a token expiring at `expiresAt`.
 * When `receivedAt` is known (from `login` or `refresh`), lead is capped at half the token
 * lifetime so short tokens refresh halfway through their life instead of immediately.
 * When `receivedAt` is omitted (e.g. restored from storage), the full `leadMs` applies.
 */
export function refreshDelayMs(
  expiresAt: number,
  receivedAt: number | undefined,
  now: number,
  leadMs = DEFAULT_REFRESH_LEAD_MS,
): number {
  const effectiveLead =
    receivedAt === undefined ? leadMs : effectiveRefreshLeadMs(expiresAt, receivedAt, leadMs);
  return Math.max(0, expiresAt - now - effectiveLead);
}

/**
 * Whether a token is due for refresh on wakeup (tab visible, app foregrounded, network back).
 * A token without a finite `expiresAt` (`null`) is never due proactively.
 */
export function refreshDue(
  expiresAt: number | null,
  now: number,
  leadMs = DEFAULT_REFRESH_LEAD_MS,
  receivedAt?: number,
): boolean {
  if (expiresAt === null || !Number.isFinite(expiresAt)) return false;
  const effectiveLead =
    receivedAt === undefined ? leadMs : effectiveRefreshLeadMs(expiresAt, receivedAt, leadMs);
  return expiresAt - now <= effectiveLead;
}

/**
 * Default refresh-endpoint failure classifier: any object carrying numeric `status` `401` or `403`
 * (including `ApiError` and `AppError`) is `'rejected'`; every other failure is `'unavailable'`.
 */
export function defaultClassifyRefreshFailure(error: unknown): SessionRefreshFailure {
  if (typeof error === 'object' && error !== null && 'status' in error) {
    const { status } = error;
    if (status === 401 || status === 403) return 'rejected';
  }
  return 'unavailable';
}

/** Validate an integer option within `[min, max]`, throwing `RangeError` naming the option. */
export function assertOptionInRange(
  name: string,
  value: number,
  min: number,
  max: number,
): void {
  if (!Number.isInteger(value) || value < min || value > max) {
    throw new RangeError(`${name} must be between ${min} and ${max}`);
  }
}

export interface ParsedSessionOptions {
  readonly capacity: number;
  readonly timeout: number;
  readonly storageTimeout: number;
  readonly storageRetryMs: number;
  readonly leadMs: number;
  readonly cooldownMs: number;
  readonly backoff: Backoff;
  readonly clock: SessionClock;
  readonly classify: (error: unknown) => SessionRefreshFailure;
}

/** Validate and resolve defaults for `createSessionCredentials` options. */
export function parseSessionCredentialsOptions<TCredentials>(config: {
  readonly maxPendingWrites?: number;
  readonly refreshTimeoutMs?: number;
  readonly storageTimeoutMs?: number;
  readonly storageRetryMs?: number;
  readonly refreshAhead?: SessionRefreshAhead<TCredentials>;
  readonly retry?: BackoffPolicy;
  readonly clock?: SessionClock;
  readonly classifyRefreshFailure?: (error: unknown) => SessionRefreshFailure;
}): ParsedSessionOptions {
  const capacity = config.maxPendingWrites ?? 128;
  assertOptionInRange('maxPendingWrites', capacity, 1, 65_536);
  const timeout = config.refreshTimeoutMs ?? DEFAULT_REFRESH_TIMEOUT_MS;
  assertOptionInRange('refreshTimeoutMs', timeout, 1, 3_600_000);
  const storageTimeout = config.storageTimeoutMs ?? 30_000;
  assertOptionInRange('storageTimeoutMs', storageTimeout, 1, 3_600_000);
  const storageRetryMs = config.storageRetryMs ?? DEFAULT_STORAGE_RETRY_MS;
  assertOptionInRange('storageRetryMs', storageRetryMs, 1, 3_600_000);
  const leadMs = config.refreshAhead?.leadMs ?? DEFAULT_REFRESH_LEAD_MS;
  assertOptionInRange('refreshAhead.leadMs', leadMs, 1, 86_400_000);
  const cooldownMs = config.refreshAhead?.cooldownMs ?? DEFAULT_REFRESH_COOLDOWN_MS;
  assertOptionInRange('refreshAhead.cooldownMs', cooldownMs, 1, 3_600_000);
  return {
    capacity,
    timeout,
    storageTimeout,
    storageRetryMs,
    leadMs,
    cooldownMs,
    backoff: createBackoff(config.retry ?? DEFAULT_REFRESH_RETRY_POLICY),
    clock: config.clock ?? createDefaultSessionClock(),
    classify: config.classifyRefreshFailure ?? defaultClassifyRefreshFailure,
  };
}
