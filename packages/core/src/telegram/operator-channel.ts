/**
 * The operator's Telegram chat: product events for people, not the journal.
 *
 * Two bots each carried a 250-line static logger posting new users, payments
 * and errors into forum topics of one chat, and each mixed it with the process
 * journal. They answer different readers. The journal is for the machine and
 * the engineer and must never lose a line to a slow network; the chat is for a
 * person and must never slow the bot down. So this is a separate thing, with
 * the opposite guarantee: `post` returns at once and never throws, sending is
 * paced below Telegram's per-chat limit, and when the chat cannot keep up the
 * oldest message is dropped and counted rather than the bot waiting.
 *
 * What to post stays the application's. This owns the queue, the pacing, the
 * topics, 429s and the bounded way down.
 */

import { callTelegramBotApi } from './bot-api';
import { classifyTelegramSendFailure, type TelegramSendFailure } from './send-failure';

export type TelegramChatId = number | string;

/** Telegram's limit for one message's text. */
const TEXT_LIMIT = 4_096;

export interface TelegramOperatorMessage {
  readonly chatId: TelegramChatId;
  /** The forum topic, when the chat has topics. */
  readonly threadId?: number;
  readonly text: string;
}

export interface TelegramOperatorDrop<TTopic extends string> {
  readonly topic?: TTopic;
  readonly text: string;
  /**
   * `overflow` — the queue was full and this was the oldest; `refused` —
   * Telegram said no in a way repeating will not fix; `attempts` — it kept
   * failing; `closed` — the channel closed before it was sent.
   */
  readonly reason: 'overflow' | 'refused' | 'attempts' | 'closed';
  readonly failure?: TelegramSendFailure;
}

export interface TelegramOperatorChannelConfig<TTopic extends string> {
  readonly chatId: TelegramChatId;
  /** Topic name → forum `message_thread_id`. A topic not listed posts to the chat itself. */
  readonly topics?: Readonly<Partial<Record<TTopic, number>>>;
  /** Deliver one message — `telegramOperatorSender` or the application's own bot. */
  readonly send: (message: TelegramOperatorMessage, signal: AbortSignal) => Promise<unknown>;
  /** Default 200. The oldest message is dropped beyond it. */
  readonly maxQueued?: number;
  /** Pause between two sends. Default 3000 — Telegram allows about 20 per minute into a group. */
  readonly minIntervalMs?: number;
  /** Sends of one message before it is dropped. Default 3. */
  readonly maxAttempts?: number;
  /** Every message that will not arrive, with why. */
  readonly onDropped?: (drop: TelegramOperatorDrop<TTopic>) => void;
  /** Default: a timer. Rejects when `signal` aborts. */
  readonly sleep?: (milliseconds: number, signal: AbortSignal) => Promise<void>;
}

export interface TelegramOperatorChannel<TTopic extends string> {
  /** Queue one message. Returns at once and never throws. */
  post(text: string, topic?: TTopic): void;
  /** Messages waiting, the one in flight included. */
  readonly pending: number;
  /** Resolves once everything queued was sent or dropped, or when `signal` aborts. */
  drain(signal?: AbortSignal): Promise<void>;
  /** Stop: the message in flight is abandoned and the queue dropped as `closed`. */
  close(): void;
}

interface Queued<TTopic extends string> {
  readonly topic?: TTopic;
  readonly text: string;
  attempts: number;
}

function timer(milliseconds: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal.aborted) return reject(signal.reason);
    const handle = setTimeout(() => {
      signal.removeEventListener('abort', stop);
      resolve();
    }, milliseconds);
    const stop = (): void => {
      clearTimeout(handle);
      reject(signal.reason);
    };
    signal.addEventListener('abort', stop, { once: true });
  });
}

function fitted(text: string): string {
  const points = Array.from(text);
  return points.length <= TEXT_LIMIT ? text : `${points.slice(0, TEXT_LIMIT - 1).join('')}…`;
}

export function createTelegramOperatorChannel<TTopic extends string = never>(
  config: TelegramOperatorChannelConfig<TTopic>,
): TelegramOperatorChannel<TTopic> {
  const maxQueued = config.maxQueued ?? 200;
  const minIntervalMs = config.minIntervalMs ?? 3_000;
  const maxAttempts = config.maxAttempts ?? 3;
  const sleep = config.sleep ?? timer;
  const queue: Queued<TTopic>[] = [];
  const idle = new Set<() => void>();
  let lifetime = new AbortController();
  let running = false;
  let closed = false;
  let inFlight = 0;

  const drop = (
    item: Queued<TTopic>,
    reason: TelegramOperatorDrop<TTopic>['reason'],
    failure?: TelegramSendFailure,
  ) => {
    try {
      config.onDropped?.({
        ...(item.topic !== undefined && { topic: item.topic }),
        text: item.text,
        reason,
        ...(failure && { failure }),
      });
    } catch {
      // An observer of drops cannot become a reason to drop more.
    }
  };

  const settleIdle = (): void => {
    if (queue.length > 0 || inFlight > 0) return;
    for (const waiter of idle) waiter();
    idle.clear();
  };

  /** One send; the delay before the next attempt, or `undefined` when this message is finished. */
  const attempt = async (
    item: Queued<TTopic>,
    signal: AbortSignal,
  ): Promise<number | undefined> => {
    item.attempts += 1;
    const threadId = item.topic === undefined ? undefined : config.topics?.[item.topic];
    try {
      await config.send(
        {
          chatId: config.chatId,
          ...(threadId !== undefined && { threadId }),
          text: fitted(item.text),
        },
        signal,
      );
      return undefined;
    } catch (error) {
      if (signal.aborted) throw error;
      const failure = classifyTelegramSendFailure(error);
      if (!failure.retryable) {
        drop(item, 'refused', failure);
        return undefined;
      }
      if (item.attempts >= maxAttempts) {
        drop(item, 'attempts', failure);
        return undefined;
      }
      return Math.max(minIntervalMs, (failure.retryAfterSeconds ?? 0) * 1_000);
    }
  };

  const run = async (signal: AbortSignal): Promise<void> => {
    let current: Queued<TTopic> | undefined;
    try {
      for (let item = queue[0]; item; item = queue[0]) {
        current = item;
        inFlight = 1;
        queue.shift();
        let retryIn = await attempt(item, signal);
        while (retryIn !== undefined) {
          await sleep(retryIn, signal);
          retryIn = await attempt(item, signal);
        }
        current = undefined;
        inFlight = 0;
        settleIdle();
        if (queue.length > 0) await sleep(minIntervalMs, signal);
      }
    } catch {
      // Aborted by `close`, which dropped the queue; the message in hand too.
      if (current) drop(current, 'closed');
    } finally {
      inFlight = 0;
      running = false;
      settleIdle();
    }
  };

  return {
    post(text, topic) {
      try {
        const item: Queued<TTopic> = {
          ...(topic !== undefined && { topic }),
          text,
          attempts: 0,
        };
        if (closed) {
          drop(item, 'closed');
          return;
        }
        queue.push(item);
        while (queue.length > maxQueued) {
          const oldest = queue.shift();
          if (oldest) drop(oldest, 'overflow');
        }
        if (!running) {
          running = true;
          void run(lifetime.signal);
        }
      } catch {
        // `post` is called from failure paths; it cannot add one.
      }
    },
    get pending() {
      return queue.length + inFlight;
    },
    drain(signal) {
      if (queue.length === 0 && inFlight === 0) return Promise.resolve();
      return new Promise((resolve) => {
        const done = (): void => {
          signal?.removeEventListener('abort', done);
          idle.delete(done);
          resolve();
        };
        idle.add(done);
        signal?.addEventListener('abort', done, { once: true });
      });
    },
    close() {
      closed = true;
      lifetime.abort(new DOMException('Operator channel closed', 'AbortError'));
      lifetime = new AbortController();
      for (const item of queue.splice(0)) drop(item, 'closed');
      settleIdle();
    },
  };
}

export interface TelegramOperatorSenderConfig {
  readonly token: string;
  readonly apiRoot?: string;
  /** Default: plain text, so an operator message never fails on entity parsing. */
  readonly parseMode?: 'HTML' | 'MarkdownV2';
  readonly fetch?: typeof fetch;
}

/** The standard `send`: `sendMessage` through the Bot API, no bot library. */
export function telegramOperatorSender(
  config: TelegramOperatorSenderConfig,
): TelegramOperatorChannelConfig<string>['send'] {
  return (message, signal) =>
    callTelegramBotApi({
      token: config.token,
      method: 'sendMessage',
      params: {
        chat_id: message.chatId,
        text: message.text,
        ...(message.threadId !== undefined && { message_thread_id: message.threadId }),
        ...(config.parseMode && { parse_mode: config.parseMode }),
        link_preview_options: { is_disabled: true },
      },
      signal,
      ...(config.apiRoot && { apiRoot: config.apiRoot }),
      ...(config.fetch && { fetch: config.fetch }),
    });
}
