import { z } from 'zod';
import { raceAbort } from '../internal/abort-race';
import { backoffDelay } from '../internal/backoff';
import { MAX_TIMER_MS, sleep } from '../internal/timers';
import type { TelegramBroadcastConfig } from './broadcast';
import {
  classifyBotBroadcastFailure,
  type TelegramBroadcastFailure,
  TelegramBroadcastFailureSchema,
} from './broadcast-failure';
import type { TelegramBroadcastOutcome, TelegramBroadcastRecipient } from './broadcast-state';

export type RecipientOutcome =
  | {
      kind: 'settled';
      outcome: TelegramBroadcastOutcome;
      reason?: string;
      halt?: TelegramBroadcastFailure;
    }
  | { kind: 'halted'; failure: TelegramBroadcastFailure }
  | { kind: 'stopped' };

export function broadcastLimits(config: TelegramBroadcastConfig) {
  const rate = z
    .number()
    .positive()
    .min(1_000 / MAX_TIMER_MS)
    .parse(config.ratePerSecond ?? 25);
  return {
    intervalMs: 1_000 / rate,
    maxAttempts: z
      .int()
      .min(1)
      .max(100)
      .parse(config.maxAttempts ?? 5),
    maxRetryDelayMs: z
      .int()
      .nonnegative()
      .max(MAX_TIMER_MS)
      .parse(config.maxRetryDelayMs ?? 60_000),
    progressEveryMs: z
      .int()
      .nonnegative()
      .max(MAX_TIMER_MS)
      .parse(config.progressEveryMs ?? 10_000),
  };
}

/** One recipient under the existing runner's pacing, journal and provider-injected policy. */
export function broadcastDelivery(
  config: TelegramBroadcastConfig,
  limits: ReturnType<typeof broadcastLimits>,
  assertHeld: () => Promise<void>,
) {
  const pause = config.sleep ?? sleep;
  const now = config.now ?? Date.now;
  const classify = config.classify ?? classifyBotBroadcastFailure;
  let lastSendAt = Number.NEGATIVE_INFINITY;
  const transientCeiling = Math.max(1, Math.min(60_000, limits.maxRetryDelayMs));
  const transientBackoff = {
    minDelayMs: Math.min(1_000, transientCeiling),
    maxDelayMs: transientCeiling,
    jitter: 0,
  };
  const wait = async (milliseconds: number): Promise<boolean> => {
    if (config.signal?.aborted) return false;
    if (milliseconds > 0) {
      try {
        const pending = pause(milliseconds, config.signal);
        if (config.signal) await raceAbort(pending, config.signal);
        else await pending;
      } catch (error) {
        if (config.signal?.aborted) return false;
        throw error;
      }
    }
    return !config.signal?.aborted;
  };
  return async (recipient: TelegramBroadcastRecipient): Promise<RecipientOutcome> => {
    for (let attempt = 1; ; attempt += 1) {
      if (!(await wait(lastSendAt + limits.intervalMs - now()))) return { kind: 'stopped' };
      await assertHeld();
      if (config.signal?.aborted) return { kind: 'stopped' };
      lastSendAt = now();
      try {
        await config.send({ recipient, attempt });
        return { kind: 'settled', outcome: 'delivered' };
      } catch (error) {
        const failure = TelegramBroadcastFailureSchema.parse(classify(error));
        if (failure.kind === 'ambiguous')
          return {
            kind: 'settled',
            outcome: 'uncertain',
            ...(failure.reason && { reason: failure.reason }),
            halt: failure,
          };
        if (failure.kind === 'permanent') {
          if (failure.stopBroadcast) return { kind: 'halted', failure };
          return {
            kind: 'settled',
            outcome: failure.recipientUnreachable ? 'unreachable' : 'failed',
            ...(failure.reason && { reason: failure.reason }),
          };
        }
        // Never shorten the provider's wait and send before its deadline: a wait the
        // provider demands that exceeds the limit stops the broadcast. Our own
        // backoff between transient failures is ours to bound, so it is capped at
        // the limit instead.
        if (failure.kind === 'retry-after' && failure.retryAfterMs > limits.maxRetryDelayMs)
          return { kind: 'halted', failure };
        const delay =
          failure.kind === 'retry-after'
            ? failure.retryAfterMs
            : backoffDelay(transientBackoff, attempt);
        if (attempt >= limits.maxAttempts)
          return {
            kind: 'settled',
            outcome: 'failed',
            ...(failure.reason && { reason: failure.reason }),
          };
        if (!(await wait(delay))) return { kind: 'stopped' };
      }
    }
  };
}
