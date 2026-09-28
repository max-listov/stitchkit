import { z } from 'zod';
import { measureSize } from '../observability/sanitize';
import type {
  DroppedNotification,
  NotificationFailureClassification,
  NotificationOutboxConfig,
  NotificationOutboxItem,
  NotificationOutboxState,
} from './notification-outbox';

const sizeOf = (value: unknown): number => measureSize(value).responseBytes;

/** One second doubling to a minute, no jitter — a single durable queue, not a fleet. */
export const DEFAULT_OUTBOX_BACKOFF = {
  minDelayMs: 1_000,
  maxDelayMs: 60_000,
  jitter: 0,
} as const;

/** Every bound of the outbox, validated once at construction. */
export function resolveOutboxLimits<TPayload>(config: NotificationOutboxConfig<TPayload>) {
  const pollIntervalMs = z
    .number()
    .int()
    .min(10)
    .parse(config.pollIntervalMs ?? 1_000);
  const leaseMs = z
    .number()
    .int()
    .min(100)
    .parse(config.leaseMs ?? 30_000);
  // Under the default backoff the 99 waits between 100 attempts sum to
  // 1+2+4+8+16+32 s plus 93 × 60 s ≈ 94 minutes — a transport outage an owner
  // notification must outlive.
  const maxAttempts = z
    .number()
    .int()
    .min(1)
    .max(10_000)
    .parse(config.maxAttempts ?? 100);
  const maxQueue = z
    .number()
    .int()
    .min(1)
    .max(100_000)
    .parse(config.maxQueue ?? 1_000);
  const maxStateBytes = z
    .number()
    .int()
    .min(1_024)
    .parse(config.maxStateBytes ?? 1024 * 1024);
  const retainReceipts = z
    .number()
    .int()
    .min(0)
    .max(100_000)
    .parse(config.retainReceipts ?? 1_000);
  return { pollIntervalMs, leaseMs, maxAttempts, maxQueue, maxStateBytes, retainReceipts };
}

/**
 * The state a transition may write: the queue within its limit, and receipts
 * dropped oldest-first until the whole state fits its byte budget.
 */
export function boundedOutboxState<TPayload>(
  parsed: NotificationOutboxState<TPayload>,
  maxQueue: number,
  retainReceipts: number,
  maxStateBytes: number,
): NotificationOutboxState<TPayload> {
  if (parsed.queue.length > maxQueue) {
    throw new Error(`[stitchkit] notification outbox queue limit (${maxQueue}) exceeded`);
  }
  let receipts = parsed.receipts.slice(0, retainReceipts);
  let next: NotificationOutboxState<TPayload> = { ...parsed, receipts };
  while (sizeOf(next) > maxStateBytes && receipts.length > 0) {
    receipts = receipts.slice(0, -1);
    next = { ...parsed, receipts };
  }
  if (sizeOf(next) > maxStateBytes) {
    throw new Error(
      `[stitchkit] notification outbox state limit (${maxStateBytes} bytes) exceeded`,
    );
  }
  return next;
}

/** Why a failed send is dropped rather than retried, or `null` to retry it. */
export function dropReason(
  classification: NotificationFailureClassification,
  attempts: number,
  maxAttempts: number,
): DroppedNotification<unknown>['reason'] | null {
  if (classification.recipientUnreachable === true) return 'recipient-unreachable';
  if (!classification.retryable) return 'terminal';
  return attempts >= maxAttempts ? 'attempt-limit' : null;
}

/** A backoff delay, bounded at a day: a retry later than that is a lost notification. */
export const RetryDelaySchema = z
  .number()
  .nonnegative()
  .max(24 * 60 * 60 * 1_000);

export const NO_LEASE = { leaseOwner: null, leaseId: null, leaseUntil: null } as const;

/**
 * The oldest item that is due and not leased by a live owner, leased now to
 * `ownerId` — or `null` when nothing is ready.
 */
export function claimDue<TPayload>(
  queue: readonly NotificationOutboxItem<TPayload>[],
  now: Date,
  ownerId: string,
  leaseMs: number,
): NotificationOutboxItem<TPayload> | null {
  const candidate = [...queue]
    .sort((left, right) => Date.parse(left.createdAt) - Date.parse(right.createdAt))
    .find(
      (item) =>
        Date.parse(item.nextAttemptAt) <= now.getTime() &&
        (item.leaseUntil === null || Date.parse(item.leaseUntil) <= now.getTime()),
    );
  if (!candidate) return null;
  return {
    ...candidate,
    attempts: candidate.attempts + 1,
    leaseOwner: ownerId,
    leaseId: crypto.randomUUID(),
    leaseUntil: new Date(now.getTime() + leaseMs).toISOString(),
  };
}
