/**
 * What a refused Telegram send was, as a fact rather than as a sentence.
 *
 * Two consuming applications carry the same broadcast subsystem — three of its
 * files byte-identical — and inside it the same list of substrings: *bot was
 * blocked*, *user is deactivated*, *chat not found*. The list exists because
 * the Bot API answers a permanently unreachable recipient and a temporarily
 * throttled one with the same shape, and a sender that cannot tell them apart
 * either retries a user who will never receive anything or drops one who would
 * have.
 *
 * The two questions are separate on purpose. `retryable` asks whether *this
 * send* could work if repeated; `recipientUnreachable` asks whether *this
 * recipient* should be addressed again at all. A rate limit is the first
 * without the second; a blocked user is the second without the first; a
 * message Telegram could not parse is neither — the recipient is fine and it is
 * our payload that is wrong, which is exactly the case a substring list marks
 * as a delivery failure and quietly counts against the wrong party.
 *
 * **This classifies; it does not act.** Whether to retry, how long to wait,
 * whether a blocked user is deleted or merely flagged — the application's,
 * along with every sentence a human reads. → ADR 0141.
 */

import { isRecord } from '../internal/typed';

/**
 * Why a send did not arrive.
 *
 * Each member earns its name by implying a different next move. The four that
 * mean "not this recipient" are not folded together: a deactivated account is
 * gone and its row can be closed, a block can be lifted and the row is kept, a
 * user who never pressed Start needs an invitation rather than a retry, and a
 * chat Telegram does not know is usually a bad identifier on our side — a
 * defect in our data, not a fact about a person.
 */
export type TelegramSendFailureReason =
  | 'blocked-by-user'
  | 'user-deactivated'
  | 'chat-not-found'
  | 'not-started'
  | 'rate-limited'
  | 'message-invalid'
  | 'server-error'
  | 'unknown';

export interface TelegramSendFailure {
  reason: TelegramSendFailureReason;
  /** Telegram's `error_code`, when the failure carried one. */
  status?: number;
  /**
   * How long Telegram asked us to wait, from its own `parameters.retry_after`.
   *
   * Only ever present when Telegram said it. A sender that needs a number
   * anyway picks its own backoff; inventing one here would put a guess and a
   * statement in the same field.
   */
  retryAfterSeconds?: number;
  /** Repeating this same send could plausibly succeed. */
  retryable: boolean;
  /**
   * This recipient will not receive this or any later message until something
   * outside our control changes, so a broadcast should stop addressing them.
   *
   * Asserted only for the reasons that actually establish it. An unrecognised
   * refusal leaves it `false`: marking a recipient unreachable on a guess is
   * how a working subscriber is silently dropped forever, and that error is
   * far more expensive than one wasted send.
   */
  recipientUnreachable: boolean;
  /**
   * How the reason was reached. `parameters` and `status` are Telegram stating
   * its own answer in a structured field; `description` is us reading its
   * prose, which changes without notice.
   */
  evidence: 'parameters' | 'status' | 'description' | 'none';
}

/**
 * The prose Telegram actually emits. First match wins, so narrower phrases come
 * first.
 */
const BY_DESCRIPTION: readonly (readonly [RegExp, TelegramSendFailureReason])[] = [
  [/bot was blocked by the user|bot was kicked/i, 'blocked-by-user'],
  [/user is deactivated|account is deactivated/i, 'user-deactivated'],
  [/can'?t initiate conversation|need to start a conversation/i, 'not-started'],
  [/chat not found|peer_id_invalid|user not found/i, 'chat-not-found'],
  [/too many requests|retry later|flood/i, 'rate-limited'],
  [
    /message is too long|can'?t parse entities|message text is empty|wrong file identifier|button_url_invalid/i,
    'message-invalid',
  ],
];

/** Repeating the same send unchanged could work. */
const RETRYABLE: ReadonlySet<TelegramSendFailureReason> = new Set([
  'rate-limited',
  'server-error',
]);

/** The recipient, not the request, is the reason nothing arrived. */
const UNREACHABLE: ReadonlySet<TelegramSendFailureReason> = new Set([
  'blocked-by-user',
  'user-deactivated',
  'chat-not-found',
  'not-started',
]);

function numberAt(value: unknown, keys: readonly string[]): number | undefined {
  if (!isRecord(value)) return undefined;
  for (const key of keys) {
    const candidate = value[key];
    if (typeof candidate === 'number' && Number.isFinite(candidate)) return candidate;
  }
  return undefined;
}

function statusOf(value: unknown, depth = 0): number | undefined {
  if (!isRecord(value) || depth > 4) return undefined;
  const direct = numberAt(value, ['error_code', 'statusCode', 'status']);
  if (direct !== undefined && direct >= 400 && direct < 600) return direct;
  // grammY throws its own error; a raw Bot API body may arrive nested instead.
  const nested = value.cause ?? value.response ?? value.error;
  return nested === value ? undefined : statusOf(nested, depth + 1);
}

function retryAfterOf(value: unknown, depth = 0): number | undefined {
  if (!isRecord(value) || depth > 4) return undefined;
  const direct = numberAt(value.parameters, ['retry_after']);
  if (direct !== undefined) return direct;
  const nested = value.cause ?? value.response ?? value.error;
  return nested === value ? undefined : retryAfterOf(nested, depth + 1);
}

function descriptionOf(value: unknown, depth = 0): string {
  if (typeof value === 'string') return value;
  if (value instanceof Error) {
    const nested = isRecord(value) ? descriptionOf(value.cause, depth + 1) : '';
    return `${value.message} ${nested}`.trim();
  }
  if (!isRecord(value) || depth > 4) return '';
  const own = typeof value.description === 'string' ? value.description : '';
  const message = typeof value.message === 'string' ? value.message : '';
  const nested = descriptionOf(value.cause ?? value.response ?? value.error, depth + 1);
  return [own, message, nested].filter(Boolean).join(' ');
}

/**
 * Classify one refused send.
 *
 * Never throws and never guesses: a refusal it does not recognise is `unknown`,
 * which asserts nothing about the recipient and permits no retry.
 */
export function classifyTelegramSendFailure(error: unknown): TelegramSendFailure {
  const status = statusOf(error);
  const retryAfterSeconds = retryAfterOf(error);
  const description = descriptionOf(error);

  // Telegram's own structured answer outranks its prose and its status code:
  // `retry_after` is a number it chose to send, and it means exactly one thing.
  if (retryAfterSeconds !== undefined) {
    return {
      reason: 'rate-limited',
      ...(status !== undefined && { status }),
      retryAfterSeconds,
      retryable: true,
      recipientUnreachable: false,
      evidence: 'parameters',
    };
  }

  for (const [pattern, reason] of BY_DESCRIPTION) {
    if (pattern.test(description)) {
      return {
        reason,
        ...(status !== undefined && { status }),
        retryable: RETRYABLE.has(reason),
        recipientUnreachable: UNREACHABLE.has(reason),
        evidence: 'description',
      };
    }
  }

  if (status === 429) {
    return {
      reason: 'rate-limited',
      status,
      retryable: true,
      recipientUnreachable: false,
      evidence: 'status',
    };
  }
  if (status !== undefined && status >= 500) {
    // Telegram itself faltered. The recipient is not implicated, and the same
    // request is the right thing to send again.
    return {
      reason: 'server-error',
      status,
      retryable: true,
      recipientUnreachable: false,
      evidence: 'status',
    };
  }

  return {
    reason: 'unknown',
    ...(status !== undefined && { status }),
    retryable: false,
    recipientUnreachable: false,
    evidence: 'none',
  };
}
