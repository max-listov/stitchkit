/**
 * Webhook updates received durably: recorded before Telegram is answered,
 * handled after, and never lost to a restart or a slow handler.
 *
 * Answering Telegram only after an update is handled breaks twice. A long
 * handler — a file of gigabytes arriving from a local Bot API server — holds
 * the connection past Telegram's patience, it gives up and sends the update
 * again while the first attempt still runs; and a process that dies after
 * handling but before answering loses nothing Telegram knows about, while one
 * that dies before handling loses the update for good once it has answered.
 * So the body is written first and Telegram answered at once; handling runs
 * here, outside the request.
 *
 * Updates of one chat run one after another, in `update_id` order; different
 * chats run side by side up to `maxConcurrent`. An attempt holds a lease that
 * is renewed while its handler lives; a sweep takes over what was left —
 * `pending` whose process never got to it, `failed` whose retry is due,
 * `processing` whose lease nobody renewed. Delivery is at least once: a
 * handler that finished but could not be recorded as finished runs again.
 */

import { isRecord, transportResult } from '../internal/typed';
import { classifyTelegramSendFailure } from './send-failure';
import type { TelegramUpdateStore } from './update-store';
import type { TelegramUpdateAcceptance } from './webhook';

/** An update as Telegram sends it; name grammY's `Update` to get its full type. */
export interface TelegramUpdateEnvelope {
  readonly update_id: number;
}

export interface TelegramUpdateFailure {
  readonly updateId: number;
  readonly attempt: number;
  readonly error: unknown;
  /** `false` when the update was abandoned — no attempt follows. */
  readonly retrying: boolean;
}

export type TelegramUpdateStoreStep = 'claim' | 'renew' | 'settle' | 'sweep';

export interface TelegramUpdateIntakeConfig<TUpdate extends TelegramUpdateEnvelope> {
  readonly store: TelegramUpdateStore;
  /**
   * Handle one update — with grammY, `(update) => bot.handleUpdate(update)`.
   * A grammY `BotError` is unwrapped: `retry`, `onFailure` and the stored
   * error see what the middleware threw.
   */
  readonly handle: (update: TUpdate) => unknown;
  /**
   * After a failed attempt: milliseconds until the next, or `false` to
   * abandon the update. Default: abandon what Telegram said repeating cannot
   * fix (a refused message, a blocked user), wait Telegram's `retry_after`
   * when it gave one, otherwise back off 5 s, 20 s, 80 s … up to 15 minutes.
   */
  readonly retry?: (error: unknown, attempt: number) => number | false;
  /** Default 5. */
  readonly maxAttempts?: number;
  /** How long an attempt holds its update without renewing. Default 120 000; renewed every quarter. */
  readonly leaseMs?: number;
  /** How long a `pending` update waits for this process before a sweep takes it. Default 60 000. */
  readonly pendingGraceMs?: number;
  /** Default 30 000. */
  readonly sweepEveryMs?: number;
  /** How long finished updates are remembered to refuse Telegram's repeats. Default 24 h. */
  readonly retainMs?: number;
  /** Chats handled at once. Default 32. */
  readonly maxConcurrent?: number;
  /** Every failed attempt. */
  readonly onFailure?: (failure: TelegramUpdateFailure) => void;
  /** The store refused a step; the update is retried when its lease lapses. */
  readonly onStoreError?: (error: unknown, step: TelegramUpdateStoreStep) => void;
  /** Default `Date.now`. */
  readonly now?: () => number;
}

export interface TelegramUpdateIntake {
  /** Record one webhook body; handling starts after, once the intake is started. */
  accept(body: string): Promise<TelegramUpdateAcceptance>;
  /** Start handling, beginning with everything recorded before. */
  start(): Promise<void>;
  /** Take over what is due now; how many updates were scheduled. */
  sweep(): Promise<number>;
  /** Resolves once nothing is scheduled. */
  idle(): Promise<void>;
  /** Stop scheduling and wait for the handlers in flight. */
  close(): Promise<void>;
}

const SWEEP_BATCH = 100;

function defaultRetry(error: unknown, attempt: number): number | false {
  const failure = classifyTelegramSendFailure(error);
  if (failure.evidence !== 'none' && !failure.retryable) return false;
  const backoff = Math.min(5_000 * 4 ** (attempt - 1), 15 * 60_000);
  return Math.max(backoff, (failure.retryAfterSeconds ?? 0) * 1_000);
}

/** Updates of one chat keep their order; an update without a chat is its own line. */
function lineOf(update: Record<string, unknown>): string {
  for (const [key, payload] of Object.entries(update)) {
    if (key === 'update_id' || !isRecord(payload)) continue;
    const message = isRecord(payload.message) ? payload.message : undefined;
    for (const holder of [
      payload.chat,
      message?.chat,
      payload.from,
      payload.user,
      payload.voter_chat,
    ]) {
      if (
        isRecord(holder) &&
        (typeof holder.id === 'number' || typeof holder.id === 'string')
      ) {
        return `chat:${holder.id}`;
      }
    }
  }
  return `update:${String(update.update_id)}`;
}

function parsed(body: string): Record<string, unknown> | undefined {
  try {
    const value: unknown = JSON.parse(body);
    return isRecord(value) &&
      Number.isSafeInteger(value.update_id) &&
      Number(value.update_id) >= 0
      ? value
      : undefined;
  } catch {
    return undefined;
  }
}

/**
 * The handler's own error. grammY's `bot.handleUpdate` wraps whatever a
 * middleware threw in a `BotError` — "Error in middleware: …", the original on
 * `.error` — so a retry policy asking "is this my terminal error?" and the
 * error recorded with the update would see the wrapper instead. Matched by
 * shape: this module does not import grammY.
 */
function handlerError(error: unknown): unknown {
  return error instanceof Error &&
    error.name === 'BotError' &&
    'ctx' in error &&
    'error' in error
    ? error.error
    : error;
}

function positive(name: string, value: number): number {
  if (!Number.isSafeInteger(value) || value < 1) {
    throw new RangeError(`[stitchkit] telegram update intake: ${name} is a positive integer`);
  }
  return value;
}

export function createTelegramUpdateIntake<TUpdate extends TelegramUpdateEnvelope>(
  config: TelegramUpdateIntakeConfig<TUpdate>,
): TelegramUpdateIntake {
  const { store } = config;
  const now = config.now ?? Date.now;
  const retry = config.retry ?? defaultRetry;
  const maxAttempts = positive('maxAttempts', config.maxAttempts ?? 5);
  const leaseMs = positive('leaseMs', config.leaseMs ?? 120_000);
  const pendingGraceMs = config.pendingGraceMs ?? 60_000;
  const sweepEveryMs = positive('sweepEveryMs', config.sweepEveryMs ?? 30_000);
  const retainMs = config.retainMs ?? 86_400_000;
  const maxConcurrent = positive('maxConcurrent', config.maxConcurrent ?? 32);
  const lines = new Map<string, Promise<void>>();
  const scheduled = new Set<number>();
  const waiting: (() => void)[] = [];
  let running = 0;
  let started = false;
  let timer: ReturnType<typeof setInterval> | undefined;

  const storeError = (error: unknown, step: TelegramUpdateStoreStep): void => {
    try {
      config.onStoreError?.(error, step);
    } catch {
      // An observer cannot turn a store failure into a lost update.
    }
  };

  const slot = async (): Promise<void> => {
    if (running < maxConcurrent) {
      running += 1;
      return;
    }
    await new Promise<void>((resolve) => waiting.push(resolve));
  };
  const release = (): void => {
    const next = waiting.shift();
    if (next) next();
    else running -= 1;
  };

  const attempt = async (update: Record<string, unknown>, updateId: number): Promise<void> => {
    const taken = now();
    const number = await store
      .claim(updateId, { now: taken, leaseUntil: taken + leaseMs, maxAttempts })
      .catch((error: unknown) => storeError(error, 'claim'));
    if (number === undefined) return;
    const renewal = setInterval(
      () => {
        store
          .renew(updateId, number, now() + leaseMs)
          .catch((error: unknown) => storeError(error, 'renew'));
      },
      Math.max(1, Math.floor(leaseMs / 4)),
    );
    let settlement: Parameters<TelegramUpdateStore['settle']>[2];
    try {
      // The body passed the secret check and carries an `update_id`; its full
      // shape is the Bot API's, named by the caller's type argument.
      await config.handle(transportResult<TUpdate>(update));
      settlement = { state: 'completed', at: now() };
    } catch (thrown) {
      const error = handlerError(thrown);
      const delay = number >= maxAttempts ? false : retry(error, number);
      const message = error instanceof Error ? error.message : String(error);
      settlement =
        delay === false
          ? { state: 'abandoned', at: now(), error: message }
          : { state: 'failed', at: now(), retryAt: now() + delay, error: message };
      try {
        config.onFailure?.({ updateId, attempt: number, error, retrying: delay !== false });
      } catch {
        // Reporting a failure cannot become a second one.
      }
    } finally {
      clearInterval(renewal);
    }
    await store
      .settle(updateId, number, settlement)
      .catch((error: unknown) => storeError(error, 'settle'));
  };

  const schedule = (update: Record<string, unknown>): void => {
    const updateId = Number(update.update_id);
    if (!started || scheduled.has(updateId)) return;
    scheduled.add(updateId);
    const line = lineOf(update);
    const next = (lines.get(line) ?? Promise.resolve())
      .then(async () => {
        await slot();
        try {
          await attempt(update, updateId);
        } finally {
          release();
        }
      })
      .finally(() => {
        scheduled.delete(updateId);
        if (lines.get(line) === next) lines.delete(line);
      });
    lines.set(line, next);
  };

  const sweep = async (pendingBefore: number): Promise<number> => {
    const at = now();
    const due = await store.due({ now: at, pendingBefore, limit: SWEEP_BATCH });
    let count = 0;
    for (const row of due) {
      const update = parsed(row.body);
      if (update && !scheduled.has(row.updateId)) {
        schedule(update);
        count += 1;
      }
    }
    await store.prune(at - retainMs);
    return count;
  };

  return {
    async accept(body) {
      const update = parsed(body);
      if (!update) return 'invalid';
      const updateId = Number(update.update_id);
      const added = await store.add({ updateId, body, receivedAt: now() });
      if (!added) return 'duplicate';
      schedule(update);
      return 'accepted';
    },
    async start() {
      if (started) return;
      started = true;
      await sweep(now());
      timer = setInterval(() => {
        sweep(now() - pendingGraceMs).catch((error: unknown) => storeError(error, 'sweep'));
      }, sweepEveryMs);
      timer.unref?.();
    },
    sweep: () => sweep(now() - pendingGraceMs),
    async idle() {
      while (lines.size > 0) await Promise.all(lines.values());
    },
    async close() {
      started = false;
      if (timer) clearInterval(timer);
      timer = undefined;
      while (lines.size > 0) await Promise.all(lines.values());
    },
  };
}
