import { z } from 'zod';
import { MAX_TIMER_MS } from '../internal/timers';
import { classifyTelegramSendFailure } from './send-failure';

const reason = z.string().max(64).optional();

/**
 * Retry variants certify that the failed attempt did not apply the external effect.
 */
export const TelegramBroadcastFailureSchema = z.discriminatedUnion('kind', [
  z
    .object({
      kind: z.literal('retry-after'),
      retryAfterMs: z.int().nonnegative().max(MAX_TIMER_MS),
      reason,
    })
    .strict(),
  z.object({ kind: z.literal('transient'), reason }).strict(),
  z
    .object({
      kind: z.literal('permanent'),
      recipientUnreachable: z.boolean().optional(),
      stopBroadcast: z.boolean().optional(),
      reason,
    })
    .strict(),
  z.object({ kind: z.literal('ambiguous'), reason }).strict(),
]);
/**
 * How a broadcast send failed: `retry-after`, `transient`, `permanent` or `ambiguous`; the
 * retry kinds assert the message was not delivered.
 */
export type TelegramBroadcastFailure = z.infer<typeof TelegramBroadcastFailureSchema>;

/**
 * Bot refusals retain their known policy; an unknown send outcome never certifies a retry.
 */
export function classifyBotBroadcastFailure(error: unknown): TelegramBroadcastFailure {
  const failure = classifyTelegramSendFailure(error);
  if (failure.recipientUnreachable)
    return { kind: 'permanent', recipientUnreachable: true, reason: failure.reason };
  if (failure.reason === 'message-invalid')
    return { kind: 'permanent', stopBroadcast: true, reason: failure.reason };
  if (failure.retryAfterSeconds !== undefined)
    return {
      kind: 'retry-after',
      retryAfterMs: failure.retryAfterSeconds * 1_000,
      reason: failure.reason,
    };
  if (failure.retryable) return { kind: 'transient', reason: failure.reason };
  if (failure.reason === 'unknown' && failure.status === undefined)
    return { kind: 'ambiguous', reason: failure.reason };
  return { kind: 'permanent', reason: failure.reason };
}
