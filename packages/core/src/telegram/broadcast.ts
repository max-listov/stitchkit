/**
 * A broadcast that survives its own process.
 *
 * Two bots carried the same broadcast subsystem — three files byte-identical —
 * and inside it their own list of refusal phrases and their own single retry
 * on 429. This is that subsystem once: the application says who and how one
 * message is sent; the runner owns the pacing, the retries Telegram asks for,
 * the difference between "not this recipient" and "not this message", and the
 * state that lets a broadcast stopped by a crash, a deploy or Ctrl-C continue
 * where it was without writing twice to anyone.
 *
 * It is a function, not a resource. A broadcast is a job with an end: run from
 * a script it takes the process's signal; run inside a live application it
 * takes the application's, and admission is the caller's to hold around it.
 */

import { callTelegramBotApi } from './bot-api';
import {
  appendJournal,
  assertBroadcastName,
  type BroadcastProgress,
  broadcastFiles,
  lockBroadcast,
  readProgress,
  readRecipients,
  type TelegramBroadcastOutcome,
  type TelegramBroadcastRecipient,
  writeRecipients,
} from './broadcast-state';
import { classifyTelegramSendFailure, type TelegramSendFailure } from './send-failure';

export type { TelegramBroadcastOutcome, TelegramBroadcastRecipient } from './broadcast-state';

export interface TelegramBroadcastSend {
  readonly recipient: TelegramBroadcastRecipient;
  /** 1 for the first try of this recipient in this run. */
  readonly attempt: number;
}

export interface TelegramBroadcastConfig {
  /** The broadcast's identity: running the same name again resumes it. `[A-Za-z0-9._-]`. */
  readonly name: string;
  /** Where its state lives — a state root, never the release tree. Absolute. */
  readonly directory: string;
  /**
   * The audience, read once: on the first run it is written down, and every
   * resumed run sends to that list. Duplicates are sent once.
   */
  readonly recipients: () =>
    | Iterable<TelegramBroadcastRecipient>
    | AsyncIterable<TelegramBroadcastRecipient>
    | Promise<Iterable<TelegramBroadcastRecipient>>;
  /** Send the message to one recipient; throw Telegram's refusal as it came. */
  readonly send: (send: TelegramBroadcastSend) => Promise<unknown>;
  /** Sends started per second. Default 25, under Telegram's 30 for one bot. */
  readonly ratePerSecond?: number;
  /** Tries of one recipient on a retryable refusal before it is `failed`. Default 5. */
  readonly maxAttempts?: number;
  /** Count what would be sent and send nothing; no state is written. */
  readonly dryRun?: boolean;
  /** Stops between sends — the send in flight is finished and recorded first. */
  readonly signal?: AbortSignal;
  /** At the start, every `progressEveryMs`, and at the end. */
  readonly onProgress?: (report: TelegramBroadcastReport) => void;
  /** Default 10 000. */
  readonly progressEveryMs?: number;
  readonly sleep?: (milliseconds: number) => Promise<void>;
  readonly now?: () => number;
}

/**
 * - `finished` — nobody is left.
 * - `stopped` — the signal stopped it; run the same name again to continue.
 * - `halted` — the message itself was refused (`message-invalid`) or Telegram
 *   was unreachable; nobody was charged with it. Fix the cause and run again.
 * - `dry-run` — counted, not sent.
 */
export type TelegramBroadcastRunOutcome = 'finished' | 'stopped' | 'halted' | 'dry-run';

export interface TelegramBroadcastReport {
  readonly name: string;
  readonly outcome: TelegramBroadcastRunOutcome | 'running';
  readonly total: number;
  readonly delivered: number;
  /** The recipient blocked the bot, is gone, or never started it — do not address them again. */
  readonly unreachable: number;
  /** Refused for a reason about neither the recipient nor the message, or retries ran out. */
  readonly failed: number;
  /** A send that was in flight when a previous run died — not repeated. */
  readonly uncertain: number;
  readonly pending: number;
  /** Why a `halted` run stopped. */
  readonly halt?: TelegramSendFailure;
}

function pause(milliseconds: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

type RecipientOutcome = { outcome: TelegramBroadcastOutcome; reason?: string } | 'halt';

function tally(
  name: string,
  total: number,
  progress: BroadcastProgress,
  outcome: TelegramBroadcastReport['outcome'],
  halt?: TelegramSendFailure,
): TelegramBroadcastReport {
  const counts = { delivered: 0, unreachable: 0, failed: 0, uncertain: 0 };
  for (const state of progress.values()) if (state !== 'sending') counts[state] += 1;
  return {
    name,
    outcome,
    total,
    ...counts,
    pending: total - progress.size,
    ...(halt && { halt }),
  };
}

async function audience(
  config: TelegramBroadcastConfig,
): Promise<TelegramBroadcastRecipient[]> {
  const seen = new Set<string>();
  const list: TelegramBroadcastRecipient[] = [];
  for await (const recipient of await config.recipients()) {
    const key = `${typeof recipient}:${recipient}`;
    if (seen.has(key)) continue;
    seen.add(key);
    list.push(recipient);
  }
  return list;
}

export async function runTelegramBroadcast(
  config: TelegramBroadcastConfig,
): Promise<TelegramBroadcastReport> {
  assertBroadcastName(config.name);
  const files = broadcastFiles(config.directory, config.name);
  const intervalMs = 1_000 / (config.ratePerSecond ?? 25);
  const maxAttempts = config.maxAttempts ?? 5;
  const sleep = config.sleep ?? pause;
  const now = config.now ?? Date.now;
  let recipients: TelegramBroadcastRecipient[] = [];
  let progress: BroadcastProgress = new Map();
  const report = (outcome: TelegramBroadcastReport['outcome'], halt?: TelegramSendFailure) =>
    tally(config.name, recipients.length, progress, outcome, halt);

  if (config.dryRun) {
    recipients = (await readRecipients(files)) ?? (await audience(config));
    progress = await readProgress(files);
    return report('dry-run');
  }

  const unlock = await lockBroadcast(config.directory, files);
  try {
    const snapshot = await readRecipients(files);
    if (snapshot) recipients = snapshot;
    else {
      recipients = await audience(config);
      await writeRecipients(files, recipients);
    }
    progress = await readProgress(files);
    for (const [index, state] of progress) {
      if (state !== 'sending') continue;
      await appendJournal(files, { i: index, o: 'uncertain' });
      progress.set(index, 'uncertain');
    }

    const emit = (value: TelegramBroadcastReport): TelegramBroadcastReport => {
      try {
        config.onProgress?.(value);
      } catch {
        // A progress observer cannot stop the broadcast it observes.
      }
      return value;
    };
    emit(report('running'));
    let lastProgressAt = now();
    let lastSendAt = Number.NEGATIVE_INFINITY;

    let halted: TelegramSendFailure | undefined;
    const halt = (failure: TelegramSendFailure): 'halt' => {
      halted = failure;
      return 'halt';
    };

    /** One recipient to its end: sent, refused for good, or out of tries. */
    const deliver = async (
      recipient: TelegramBroadcastRecipient,
    ): Promise<RecipientOutcome> => {
      for (let attempt = 1; ; attempt += 1) {
        const wait = lastSendAt + intervalMs - now();
        if (wait > 0) await sleep(wait);
        lastSendAt = now();
        try {
          await config.send({ recipient, attempt });
          return { outcome: 'delivered' };
        } catch (error) {
          const failure = classifyTelegramSendFailure(error);
          if (failure.recipientUnreachable)
            return { outcome: 'unreachable', reason: failure.reason };
          if (failure.reason === 'message-invalid') return halt(failure);
          const transport = failure.reason === 'unknown' && failure.status === undefined;
          if (!failure.retryable && !transport)
            return { outcome: 'failed', reason: failure.reason };
          if (attempt >= maxAttempts) {
            return transport ? halt(failure) : { outcome: 'failed', reason: failure.reason };
          }
          await sleep(
            failure.retryAfterSeconds !== undefined
              ? failure.retryAfterSeconds * 1_000
              : Math.min(60_000, 1_000 * 2 ** (attempt - 1)),
          );
        }
      }
    };
    for (let index = 0; index < recipients.length; index += 1) {
      if (progress.has(index)) continue;
      if (config.signal?.aborted) return emit(report('stopped'));
      const recipient = recipients[index];
      if (recipient === undefined) continue;
      await appendJournal(files, { i: index, s: 'sending' });
      const result = await deliver(recipient);
      if (result === 'halt') {
        // Not the recipient's doing: they stay pending for the run after the fix.
        await appendJournal(files, { i: index, s: 'released' });
        return emit(report('halted', halted));
      }
      await appendJournal(files, {
        i: index,
        o: result.outcome,
        ...(result.reason && { r: result.reason }),
      });
      progress.set(index, result.outcome);
      if (now() - lastProgressAt >= (config.progressEveryMs ?? 10_000)) {
        lastProgressAt = now();
        emit(report('running'));
      }
    }
    return emit(report('finished'));
  } finally {
    await unlock();
  }
}

/** What the standard sender delivers: a text, or a copy of a prepared message with its media. */
export type TelegramBroadcastMessage =
  | { readonly text: string; readonly parseMode?: 'HTML' | 'MarkdownV2' }
  | {
      readonly copyFrom: {
        readonly chatId: TelegramBroadcastRecipient;
        readonly messageId: number;
      };
    };

export interface TelegramBroadcastSenderConfig {
  readonly token: string;
  readonly message: TelegramBroadcastMessage;
  readonly apiRoot?: string;
  readonly fetch?: typeof fetch;
}

/** The standard `send`: `sendMessage` or `copyMessage` through the Bot API, no bot library. */
export function telegramBroadcastSender(
  config: TelegramBroadcastSenderConfig,
): TelegramBroadcastConfig['send'] {
  const message = config.message;
  return ({ recipient }) =>
    callTelegramBotApi({
      token: config.token,
      ...('copyFrom' in message
        ? {
            method: 'copyMessage',
            params: {
              chat_id: recipient,
              from_chat_id: message.copyFrom.chatId,
              message_id: message.copyFrom.messageId,
            },
          }
        : {
            method: 'sendMessage',
            params: {
              chat_id: recipient,
              text: message.text,
              ...(message.parseMode && { parse_mode: message.parseMode }),
            },
          }),
      ...(config.apiRoot && { apiRoot: config.apiRoot }),
      ...(config.fetch && { fetch: config.fetch }),
    });
}
