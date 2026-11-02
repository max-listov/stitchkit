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
 * Two lanes share that one rate. An `interactive` call is granted before any
 * `bulk` call that is waiting, so a person's reply never queues behind a
 * campaign; a campaign runs at whatever rate replies leave it.
 *
 * **It paces; it does not retry.** A 429 on a method that spends the budget
 * pauses the chat it was sent to for the wait Telegram stated (or a declared
 * fallback when it stated none); every other chat of the token goes on. Telegram
 * words a group's limit, a chat's pace and the bot's own limit alike, and only
 * the addressee differs, so one chat's refusal is read as that chat's. Refusals
 * from several chats inside a short window are read as the bot's own limit and
 * pause the token, as does a 429 with no chat to blame. A 429 on an edit or a
 * read concerns that call and pauses nothing. A network failure or a 5xx is
 * returned to the caller unchanged: repeating a send whose external outcome is
 * unknown is the caller's decision, and a primitive that retried it would turn
 * one unknown message into two.
 *
 * The schedule is a strict token budget, not a bucket with a full burst: the
 * first call after an idle period is immediate, and every later call occupies
 * its own `cost / messagesPerSecond` interval. A full bucket would release a
 * saved burst at start and again after a 429 pause, which is exactly the
 * stampede a shared budget exists to prevent.
 */

import { z } from 'zod';
import { argumentsDigest } from '../internal/stable-digest';
import { MAX_TIMER_MS, sleep } from '../internal/timers';
import { isRecord } from '../internal/typed';
import { chatOf, sendCost } from './outbound-cost';
import { createOutboundPauses, type OutboundPausePolicy } from './outbound-pauses';
import { createOutboundQueue } from './outbound-queue';
import { classifyTelegramSendFailure } from './send-failure';

/** Telegram's reference rate for one bot: 24 messages per second in this SDK. */
const DEFAULT_MESSAGES_PER_SECOND = 24;

/**
 * A local wait when Telegram answers 429 without `retry_after`. It is a policy,
 * not a provider fact; the provider's own number always wins when it is there.
 */
const DEFAULT_RETRY_AFTER_FALLBACK_MS = 1_000;

/** Refusals from this many chats inside the window are the bot's limit, not theirs. */
const DEFAULT_TOKEN_PAUSE_CHATS = 3;
const DEFAULT_TOKEN_PAUSE_WINDOW_MS = 5_000;

const TOKEN = z.string().min(1, 'token must not be empty');
const MESSAGES_PER_SECOND = z.number().positive().max(1_000);
const RETRY_AFTER_FALLBACK_MS = z.number().int().nonnegative().max(MAX_TIMER_MS);
const TOKEN_PAUSE_CHATS = z.number().int().min(2).max(1_000);
const TOKEN_PAUSE_WINDOW_MS = z.number().int().positive().max(MAX_TIMER_MS);

/** Whose turn comes first. `interactive` answers a person; `bulk` is a campaign. */
export type TelegramOutboundLane = 'interactive' | 'bulk';

export interface TelegramOutboundBudgetConfig {
  /** The bot token whose sends share this budget. It is never returned or logged. */
  readonly token: string;
  /** Telegram messages per second. Default 24. */
  readonly messagesPerSecond?: number;
  /**
   * How long a 429 without `retry_after` pauses. Default 1000 ms.
   * Telegram's own `retry_after` is always used instead when present.
   */
  readonly retryAfterFallbackMs?: number;
  /**
   * How many different chats have to get a 429 inside `tokenPauseWindowMs`
   * before the token pauses instead of those chats. Default 3.
   */
  readonly tokenPauseChats?: number;
  /** The window `tokenPauseChats` is counted in. Default 5000 ms. */
  readonly tokenPauseWindowMs?: number;
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
  /** Calls waiting for their turn, in both lanes. */
  readonly queued: number;
  /** How many of them are in the `bulk` lane. */
  readonly queuedBulk: number;
  readonly messagesPerSecond: number;
  /** How much of the current token pause is still ahead, in milliseconds. */
  readonly pausedForMs: number;
  /** Chats on their own 429 pause right now. */
  readonly pausedChats: number;
}

export interface TelegramOutboundCallOptions {
  /** Default `interactive`. */
  readonly lane?: TelegramOutboundLane;
  /** The addressed chat: a pause of that chat holds this call. `run` reads `chat_id` itself. */
  readonly chatId?: number | string;
  /**
   * What this call's own 429 does. `pause` (the default) pauses its chat. `call`
   * pauses nothing, for a chat known to run into its limit: the refusal concerns
   * this send alone. The call still spends the budget and waits out other pauses.
   */
  readonly refusal?: 'pause' | 'call';
  /**
   * Give up after this long in the queue with `TelegramNotDispatchedError`,
   * stage `queue`: nothing was sent, so repeating it is safe. A burst to one
   * chat on pause otherwise queues without limit. Default: wait.
   */
  readonly maxWaitMs?: number;
}

/** Which chat a pause or a wait concerns. */
export interface TelegramOutboundChatOptions {
  readonly chatId?: number | string;
}

/**
 * A token's outbound budget. `run` is the narrow adapter a client transformer
 * calls around its own send; it gates, pauses on 429 and never retries.
 */
export interface TelegramOutboundBudget {
  /**
   * Run one Bot API call under the budget, in the `interactive` lane by default.
   * A non-send method passes through without spending a message. A 429 on a send
   * pauses the chat in the payload's `chat_id`, whether `send` throws it or resolves
   * with the Bot API's `{ ok: false, … }` body, as a client transformer's `send`
   * does; several chats refused at once, or a call with no chat, pause the token.
   * A 429 on a non-send method pauses nothing. The error is rethrown, or the
   * response returned, unchanged and the call is not repeated.
   */
  run<T>(
    method: string,
    payload: unknown,
    signal: AbortSignal | undefined,
    send: () => Promise<T>,
    options?: TelegramOutboundCallOptions,
  ): Promise<T>;
  /**
   * Wait until `cost` messages fit. The wait rejects with `signal.reason`
   * without spending a token; a granted call owns its slots even if its later
   * send is aborted, which the caller must not repeat as a definite failure.
   */
  acquire(
    cost: number,
    signal?: AbortSignal,
    options?: TelegramOutboundCallOptions,
  ): Promise<void>;
  /** Pause every sender of this token for at least `milliseconds`. Never shortens an existing pause. */
  pause(milliseconds: number): void;
  /**
   * Pause after a rate-limited refusal; another failure does nothing. With
   * `chatId` this is that chat's pause, counted like a refusal `run` saw; without
   * it, the token's.
   */
  pauseAfter(error: unknown, options?: TelegramOutboundChatOptions): void;
  /**
   * Wait out the current pause without spending a token, and that chat's own
   * with `chatId`. For a retry path that is not a send (edit, delete) and does
   * not go through `acquire`.
   */
  waitUntilResumed(signal?: AbortSignal, options?: TelegramOutboundChatOptions): Promise<void>;
  /** Measured counters. It never contains the token. */
  stats(): TelegramOutboundBudgetStats;
}

interface ManagedBudget {
  readonly budget: TelegramOutboundBudget;
  readonly rate: number;
  readonly fallback: number;
  readonly tokenPauseChats: number;
  readonly tokenPauseWindowMs: number;
  readonly nowOption: (() => number) | undefined;
  readonly sleepOption:
    | ((milliseconds: number, signal?: AbortSignal) => Promise<void>)
    | undefined;
}

function createBudget(
  policy: OutboundPausePolicy & { readonly rate: number; readonly fallback: number },
  now: () => number,
  sleepFor: (milliseconds: number, signal?: AbortSignal) => Promise<void>,
): TelegramOutboundBudget {
  const { rate, fallback } = policy;
  const pauses = createOutboundPauses(policy, now, () => queue.wake());
  const queue = createOutboundQueue(1_000 / rate, now, sleepFor, pauses);

  const pauseAfter = (error: unknown, options?: TelegramOutboundChatOptions): void => {
    const failure = classifyTelegramSendFailure(error);
    if (failure.reason !== 'rate-limited') return;
    const milliseconds =
      failure.retryAfterSeconds === undefined ? fallback : failure.retryAfterSeconds * 1_000;
    if (options?.chatId === undefined) pauses.pauseToken(milliseconds);
    else pauses.pauseChat(String(options.chatId), milliseconds);
  };

  const waitUntilResumed = async (
    signal?: AbortSignal,
    options?: TelegramOutboundChatOptions,
  ): Promise<void> => {
    const chat = options?.chatId === undefined ? undefined : String(options.chatId);
    while (true) {
      if (signal?.aborted) throw signal.reason;
      const remaining = pauses.resumesAt(chat) - now();
      if (remaining <= 0) return;
      await queue.wait(Math.min(remaining, MAX_TIMER_MS), signal);
    }
  };

  const run = async <T>(
    method: string,
    payload: unknown,
    signal: AbortSignal | undefined,
    send: () => Promise<T>,
    options?: TelegramOutboundCallOptions,
  ): Promise<T> => {
    if (signal?.aborted) throw signal.reason;
    const cost = sendCost(method, payload);
    const chatId = options?.chatId ?? chatOf(payload);
    const call = chatId === undefined ? {} : { chatId };
    if (cost > 0) await queue.acquire(cost, signal, { ...options, ...call });
    if (signal?.aborted) throw signal.reason;
    // Telegram's limit on editing one message says nothing about sending the next one.
    const pauseOnRefusal = (refusal: unknown): void => {
      if (cost > 0 && options?.refusal !== 'call') pauseAfter(refusal, call);
    };
    let result: T;
    try {
      result = await send();
    } catch (error) {
      pauseOnRefusal(error);
      throw error;
    }
    // A client transformer sits below the place where grammY turns a refusal
    // into an exception: the Bot API's `{ ok: false, error_code, parameters }`
    // body comes back as the value. It is the same fact as a thrown 429.
    if (isRecord(result) && result.ok === false) pauseOnRefusal(result);
    return result;
  };

  return {
    run,
    acquire: queue.acquire,
    pause: pauses.pauseToken,
    pauseAfter,
    waitUntilResumed,
    stats: () => ({
      ...queue.counts(),
      messagesPerSecond: rate,
      pausedForMs: pauses.pausedForMs(),
      pausedChats: pauses.pausedChats(),
    }),
  };
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
  const tokenPauseChats = TOKEN_PAUSE_CHATS.parse(
    config.tokenPauseChats ?? DEFAULT_TOKEN_PAUSE_CHATS,
  );
  const tokenPauseWindowMs = TOKEN_PAUSE_WINDOW_MS.parse(
    config.tokenPauseWindowMs ?? DEFAULT_TOKEN_PAUSE_WINDOW_MS,
  );
  const key = keyOf(token);
  const existing = budgets.get(key);
  if (existing) {
    const same =
      existing.rate === rate &&
      existing.fallback === fallback &&
      existing.tokenPauseChats === tokenPauseChats &&
      existing.tokenPauseWindowMs === tokenPauseWindowMs &&
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
    { rate, fallback, tokenPauseChats, tokenPauseWindowMs },
    config.now ?? (() => performance.now()),
    config.sleep ?? sleep,
  );
  budgets.set(key, {
    budget,
    rate,
    fallback,
    tokenPauseChats,
    tokenPauseWindowMs,
    nowOption: config.now,
    sleepOption: config.sleep,
  });
  return budget;
}
