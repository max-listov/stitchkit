/**
 * One outbound budget for one Telegram bot token.
 *
 * Telegram counts a bot's bulk messages per token, not per subsystem. A bot
 * that sends a marketing campaign, answers a person and posts an operator note
 * through three senders has one limit, and three separate pacemakers cannot
 * keep it: each of them is below the limit on its own and the sum is not.
 *
 * This is the one place that counts. The token names the budget; every alias
 * of the same token in the process gets the same object, and another token is
 * another budget. The unit is a Telegram message: `sendMediaGroup` and
 * `sendPaidMedia` cost their media length, `copyMessages` and
 * `forwardMessages` cost their message ids, and the follow-up call to action
 * after an album is one more message.
 *
 * **It paces; it does not retry.** A 429 pauses every sender of the token for
 * the wait Telegram stated (or a declared fallback when it stated none). A
 * network failure or a 5xx is returned to the caller unchanged: repeating a
 * send whose external outcome is unknown is the caller's decision, and a
 * primitive that retried it would turn one unknown message into two.
 *
 * The schedule is a strict token budget, not a bucket with a full burst: the
 * first call after an idle period is immediate, and every later call occupies
 * its own `cost / messagesPerSecond` interval. A full bucket would release a
 * saved burst at start and again after a 429 pause, which is exactly the
 * stampede a shared budget exists to prevent.
 */

import { z } from 'zod';
import { raceAbort } from '../internal/abort-race';
import { argumentsDigest } from '../internal/stable-digest';
import { MAX_TIMER_MS, sleep } from '../internal/timers';
import { isRecord } from '../internal/typed';
import { classifyTelegramSendFailure } from './send-failure';

/** Telegram's reference rate for one bot: 24 messages per second in this SDK. */
const DEFAULT_MESSAGES_PER_SECOND = 24;

/**
 * A local wait when Telegram answers 429 without `retry_after`. It is a policy,
 * not a provider fact; the provider's own number always wins when it is there.
 */
const DEFAULT_RETRY_AFTER_FALLBACK_MS = 1_000;

const TOKEN = z.string().min(1, 'token must not be empty');
const MESSAGES_PER_SECOND = z.number().positive().max(1_000);
const RETRY_AFTER_FALLBACK_MS = z.number().int().nonnegative().max(MAX_TIMER_MS);

/** The methods that produce a Telegram message and therefore spend the budget. */
const SEND_METHODS: ReadonlySet<string> = new Set([
  'sendMessage',
  'sendPhoto',
  'sendAudio',
  'sendDocument',
  'sendVideo',
  'sendAnimation',
  'sendVoice',
  'sendVideoNote',
  'sendPaidMedia',
  'sendMediaGroup',
  'sendLocation',
  'sendVenue',
  'sendContact',
  'sendPoll',
  'sendChecklist',
  'sendDice',
  'sendMessageDraft',
  'sendSticker',
  'sendInvoice',
  'sendGame',
  'sendGift',
  'sendGiveaway',
  'sendLivePhoto',
  'sendRichMessage',
  'copyMessage',
  'copyMessages',
  'forwardMessage',
  'forwardMessages',
  'answerWebAppQuery',
]);

/** The methods whose cost is the length of one array in the payload. */
const WEIGHTED_METHODS: ReadonlyMap<string, string> = new Map([
  ['sendMediaGroup', 'media'],
  ['sendPaidMedia', 'media'],
  ['copyMessages', 'message_ids'],
  ['forwardMessages', 'message_ids'],
]);

/** One message-producing call costs one; an empty or malformed array still costs one. */
function sendCost(method: string, payload: unknown): number {
  if (!SEND_METHODS.has(method)) return 0;
  const field = WEIGHTED_METHODS.get(method);
  if (field === undefined || !isRecord(payload)) return 1;
  const value = payload[field];
  return Array.isArray(value) ? Math.max(1, value.length) : 1;
}

export interface TelegramOutboundBudgetConfig {
  /** The bot token whose sends share this budget. It is never returned or logged. */
  readonly token: string;
  /** Telegram messages per second. Default 24. */
  readonly messagesPerSecond?: number;
  /**
   * How long a 429 without `retry_after` pauses the token. Default 1000 ms.
   * Telegram's own `retry_after` is always used instead when present.
   */
  readonly retryAfterFallbackMs?: number;
  /**
   * Test seam: the monotonic clock. Default `performance.now`. A wall clock can
   * jump backwards and turn a pause into a burst, so the default is monotonic.
   */
  readonly now?: () => number;
  /**
   * Test seam: how a wait is taken. Default the shared abortable sleep. A
   * custom sleeper must reject with `signal.reason` when the signal aborts.
   */
  readonly sleep?: (milliseconds: number, signal?: AbortSignal) => Promise<void>;
}

/** What the budget has done, with no token and no message ids. */
export interface TelegramOutboundBudgetStats {
  /** Calls admitted by `acquire` or `run`. */
  readonly granted: number;
  /** Weighted messages admitted: an album of three counts as three. */
  readonly messages: number;
  /** Calls waiting for their turn. */
  readonly queued: number;
  readonly messagesPerSecond: number;
  /** How much of the current 429 pause is still ahead, in milliseconds. */
  readonly pausedForMs: number;
}

/**
 * A token's outbound budget. `run` is the narrow adapter a client transformer
 * calls around its own send; it gates, pauses on 429 and never retries.
 */
export interface TelegramOutboundBudget {
  /**
   * Run one Bot API call under the budget. A non-send method passes through
   * without spending a message. A 429 pauses every sender of the token, whether
   * `send` throws it or resolves with the Bot API's `{ ok: false, … }` body, as
   * a client transformer's `send` does. The error is rethrown, or the response
   * returned, unchanged and the call is not repeated.
   */
  run<T>(
    method: string,
    payload: unknown,
    signal: AbortSignal | undefined,
    send: () => Promise<T>,
  ): Promise<T>;
  /**
   * Wait until `cost` messages fit. The wait rejects with `signal.reason`
   * without spending a token; a granted call owns its slots even if its later
   * send is aborted, which the caller must not repeat as a definite failure.
   */
  acquire(cost: number, signal?: AbortSignal): Promise<void>;
  /** Pause every sender of this token for at least `milliseconds`. Never shortens an existing pause. */
  pause(milliseconds: number): void;
  /** Pause the token after a rate-limited refusal; another failure does nothing. */
  pauseAfter(error: unknown): void;
  /**
   * Wait out the current pause without spending a token. For a retry path that
   * is not a send (edit, delete) and does not go through `acquire`.
   */
  waitUntilResumed(signal?: AbortSignal): Promise<void>;
  /** Measured counters. It never contains the token. */
  stats(): TelegramOutboundBudgetStats;
}

interface Waiter {
  readonly cost: number;
  readonly resolve: () => void;
  readonly reject: (reason: unknown) => void;
  readonly signal?: AbortSignal;
  onAbort?: () => void;
}

interface ManagedBudget {
  readonly budget: TelegramOutboundBudget;
  readonly rate: number;
  readonly fallback: number;
  readonly nowOption: (() => number) | undefined;
  readonly sleepOption:
    | ((milliseconds: number, signal?: AbortSignal) => Promise<void>)
    | undefined;
}

function createBudget(
  rate: number,
  fallback: number,
  now: () => number,
  sleepFor: (milliseconds: number, signal?: AbortSignal) => Promise<void>,
): TelegramOutboundBudget {
  const interval = 1_000 / rate;
  const queue: Waiter[] = [];
  let nextGrantAt = now();
  let pausedUntil = Number.NEGATIVE_INFINITY;
  let granted = 0;
  let messages = 0;
  let draining = false;
  let wake: AbortController | undefined;

  const wait = async (milliseconds: number, signal?: AbortSignal): Promise<void> => {
    const delay = Math.min(MAX_TIMER_MS, Math.max(0, milliseconds));
    if (delay <= 0) return;
    const pending = sleepFor(delay, signal);
    if (signal) await raceAbort(pending, signal);
    else await pending;
  };

  const wakeWaiting = (): void => {
    const current = wake;
    wake = undefined;
    current?.abort();
  };

  const remove = (waiter: Waiter): void => {
    const index = queue.indexOf(waiter);
    if (index === -1) return;
    queue.splice(index, 1);
    if (index === 0) wakeWaiting();
  };

  const drain = async (): Promise<void> => {
    if (draining) return;
    draining = true;
    try {
      while (queue.length > 0) {
        const head = queue[0];
        if (head === undefined) break;
        if (head.signal?.aborted) {
          remove(head);
          continue;
        }
        const current = now();
        const at = Math.max(current, nextGrantAt, pausedUntil);
        if (at > current) {
          const controller = new AbortController();
          wake = controller;
          try {
            await wait(at - current, controller.signal);
          } catch (error) {
            if (!controller.signal.aborted) {
              for (const waiter of queue.splice(0)) {
                if (waiter.onAbort)
                  waiter.signal?.removeEventListener('abort', waiter.onAbort);
                waiter.reject(error);
              }
              return;
            }
          } finally {
            if (wake === controller) wake = undefined;
          }
          continue;
        }
        queue.shift();
        if (head.onAbort) head.signal?.removeEventListener('abort', head.onAbort);
        nextGrantAt = at + head.cost * interval;
        granted += 1;
        messages += head.cost;
        head.resolve();
      }
    } finally {
      draining = false;
      // A waiter added after the loop checked the empty queue but before the
      // flag was cleared must not be left behind.
      if (queue.length > 0) void drain();
    }
  };

  const acquire = (cost: number, signal?: AbortSignal): Promise<void> => {
    if (!Number.isSafeInteger(cost) || cost < 1) {
      return Promise.reject(new RangeError('cost must be an integer of at least one message'));
    }
    if (signal?.aborted) return Promise.reject(signal.reason);
    return new Promise<void>((resolve, reject) => {
      const waiter: Waiter = { cost, resolve, reject, ...(signal && { signal }) };
      if (signal) {
        const onAbort = (): void => {
          remove(waiter);
          reject(signal.reason);
        };
        waiter.onAbort = onAbort;
        signal.addEventListener('abort', onAbort, { once: true });
      }
      queue.push(waiter);
      void drain();
    });
  };

  const pauseFor = (milliseconds: number): void => {
    if (Number.isNaN(milliseconds) || milliseconds < 0) {
      throw new RangeError('pause must be a non-negative number of milliseconds');
    }
    // An infinite wait is the strongest pause there is; it is never a no-op.
    const duration = Number.isFinite(milliseconds) ? milliseconds : Number.MAX_SAFE_INTEGER;
    pausedUntil = Math.max(pausedUntil, now() + duration);
    wakeWaiting();
  };

  const pauseAfter = (error: unknown): void => {
    const failure = classifyTelegramSendFailure(error);
    if (failure.reason !== 'rate-limited') return;
    pauseFor(
      failure.retryAfterSeconds === undefined ? fallback : failure.retryAfterSeconds * 1_000,
    );
  };

  const waitUntilResumed = async (signal?: AbortSignal): Promise<void> => {
    while (true) {
      if (signal?.aborted) throw signal.reason;
      const remaining = pausedUntil - now();
      if (remaining <= 0) return;
      await wait(Math.min(remaining, MAX_TIMER_MS), signal);
    }
  };

  const run = async <T>(
    method: string,
    payload: unknown,
    signal: AbortSignal | undefined,
    send: () => Promise<T>,
  ): Promise<T> => {
    if (signal?.aborted) throw signal.reason;
    const cost = sendCost(method, payload);
    if (cost > 0) await acquire(cost, signal);
    if (signal?.aborted) throw signal.reason;
    let result: T;
    try {
      result = await send();
    } catch (error) {
      // A 429 is a fact about the token, not about this method: an edit or a
      // read that sees one pauses the sends as well.
      pauseAfter(error);
      throw error;
    }
    // A client transformer sits below the place where grammY turns a refusal
    // into an exception: the Bot API's `{ ok: false, error_code, parameters }`
    // body comes back as the value. It is the same fact as a thrown 429.
    if (isRecord(result) && result.ok === false) pauseAfter(result);
    return result;
  };

  const budget: TelegramOutboundBudget = {
    run,
    acquire,
    pause: pauseFor,
    pauseAfter,
    waitUntilResumed,
    stats: () => ({
      granted,
      messages,
      queued: queue.length,
      messagesPerSecond: rate,
      pausedForMs: Math.max(0, pausedUntil - now()),
    }),
  };

  return budget;
}

const budgets = new Map<string, ManagedBudget>();

function keyOf(token: string): string {
  // Identity, not secrecy: the registry never keeps the credential itself.
  return `telegram-outbound:${argumentsDigest({ token })}`;
}

/**
 * The one budget for `config.token`, created on first use.
 *
 * Two aliases of one token share it; two tokens never do. A second call for a
 * token already in use must agree on the options, otherwise the process has
 * two incompatible policies for one credential and the call is refused. The
 * refusal never contains the token.
 */
export function telegramOutboundBudget(
  config: TelegramOutboundBudgetConfig,
): TelegramOutboundBudget {
  const token = TOKEN.parse(config.token);
  const rate = MESSAGES_PER_SECOND.parse(
    config.messagesPerSecond ?? DEFAULT_MESSAGES_PER_SECOND,
  );
  const fallback = RETRY_AFTER_FALLBACK_MS.parse(
    config.retryAfterFallbackMs ?? DEFAULT_RETRY_AFTER_FALLBACK_MS,
  );
  const key = keyOf(token);
  const existing = budgets.get(key);
  if (existing) {
    const same =
      existing.rate === rate &&
      existing.fallback === fallback &&
      existing.nowOption === config.now &&
      existing.sleepOption === config.sleep;
    if (!same) {
      throw new Error(
        'a Telegram outbound budget already exists for this token with different options',
      );
    }
    return existing.budget;
  }

  const budget = createBudget(
    rate,
    fallback,
    config.now ?? (() => performance.now()),
    config.sleep ?? sleep,
  );
  budgets.set(key, {
    budget,
    rate,
    fallback,
    nowOption: config.now,
    sleepOption: config.sleep,
  });
  return budget;
}
