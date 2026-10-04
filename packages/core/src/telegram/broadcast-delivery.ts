import { z } from 'zod';
import { raceAbort } from '../internal/abort-race';
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

function pause(milliseconds: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    const done = (): void => {
      clearTimeout(timer);
      signal?.removeEventListener('abort', done);
      resolve();
    };
    const timer = setTimeout(done, milliseconds);
    signal?.addEventListener('abort', done, { once: true });
    if (signal?.aborted) done();
  });
}

export function broadcastLimits(config: TelegramBroadcastConfig) {
  const rate = z
    .number()
    .positive()
    .min(1_000 / 2_147_483_647)
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
      .max(2_147_483_647)
      .parse(config.maxRetryDelayMs ?? 60_000),
    progressEveryMs: z
      .int()
      .nonnegative()
      .max(2_147_483_647)
      .parse(config.progressEveryMs ?? 10_000),
  };
}

/** One recipient under the existing runner's pacing, journal and provider-injected policy. */
export function broadcastDelivery(
  config: TelegramBroadcastConfig,
  limits: ReturnType<typeof broadcastLimits>,
  assertHeld: () => Promise<void>,
) {
  const sleep = config.sleep ?? pause;
  const now = config.now ?? Date.now;
  const classify = config.classify ?? classifyBotBroadcastFailure;
  let lastSendAt = Number.NEGATIVE_INFINITY;
  const wait = async (milliseconds: number): Promise<boolean> => {
    if (config.signal?.aborted) return false;
    if (milliseconds > 0) {
      try {
        const pending = sleep(milliseconds, config.signal);
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
    for (let attempt = 1; attempt <= limits.maxAttempts; attempt += 1) {
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
        const delay =
          failure.kind === 'retry-after'
            ? failure.retryAfterMs
            : Math.min(60_000, 1_000 * 2 ** (attempt - 1));
        // Never shorten the provider's wait and send before its deadline.
        if (delay > limits.maxRetryDelayMs) return { kind: 'halted', failure };
        if (attempt >= limits.maxAttempts)
          return {
            kind: 'settled',
            outcome: 'failed',
            ...(failure.reason && { reason: failure.reason }),
          };
        if (!(await wait(delay))) return { kind: 'stopped' };
      }
    }
    throw new Error('Broadcast retry budget produced no outcome');
  };
}
