/**
 * A chat with the application's own bot, and no Telegram.
 *
 * `createScreenTestChat(bot)` takes the `Bot` the application composes — its
 * middleware, commands and error boundary, in their real order — and answers
 * its Bot API calls from memory through `bot.api.config.use`. Updates enter
 * through `bot.handleUpdate`, so what a test proves is what the bot does:
 * that `/support` is not swallowed by a screen waiting for text, that a press
 * edits the message it came from.
 *
 * The Telegram it talks to is `test-chat-telegram.ts`, which keeps the rules
 * screens depend on. Nothing here imports grammY at run time; the bot brings it.
 */
import type { Bot, BotError, Context } from 'grammy';
import type { InlineKeyboardMarkup, Message, Update, UserFromGetMe } from 'grammy/types';
import { isRecord, transportResult } from '../../internal/typed';
import {
  createFakeTelegram,
  type StoredMessage,
  type TestChatPeer,
  type TestMessageKind,
} from './test-chat-telegram';

/** A message as the user sees it. */
export interface TestChatMessage {
  readonly id: number;
  readonly from: 'bot' | 'user';
  readonly kind: TestMessageKind;
  /** The text, or the caption, as sent — Telegram HTML for the bot's messages. */
  readonly text: string;
  readonly media: string | undefined;
  readonly rich: unknown;
  /** Button labels, row by row. */
  readonly buttons: readonly (readonly string[])[];
  readonly markup: InlineKeyboardMarkup | undefined;
}

export interface TestChatCall {
  readonly method: string;
  readonly payload: Readonly<Record<string, unknown>>;
}

export interface TestChatOptions {
  readonly chatId?: number;
  readonly chatType?: 'private' | 'group' | 'supergroup';
  readonly userId?: number;
}

export interface ScreenTestChat<C extends Context = Context> {
  /** What the chat shows, top to bottom. */
  readonly messages: readonly TestChatMessage[];
  /** Every Bot API call the bot made, in order. */
  readonly calls: readonly TestChatCall[];
  /** Press answers — the toasts — in order; `''` for a silent answer. */
  readonly answers: readonly string[];
  /** The user sends text; a leading `/word` is a command. */
  send(text: string): Promise<void>;
  /** The user sends a photo, with an optional caption. */
  sendPhoto(fileId: string, caption?: string): Promise<void>;
  /** The user presses the lowest button with this label. */
  press(label: string): Promise<void>;
  /** A press carrying arbitrary `callback_data` on a message — what a forged press looks like. */
  pressData(messageId: number, data: string): Promise<void>;
  /** Refuse the next call of `method` the way Telegram would. */
  failNext(method: string, description: string, errorCode?: number): void;
  /** The user deletes a message. */
  deleteByUser(messageId: number): void;
  /**
   * The process restarted: the same chat, as Telegram keeps it, now answered by
   * a new bot — built over the same storage, the way the application builds it.
   */
  restart(bot: Bot<C>): void;
  clearCalls(): void;
}

export function createScreenTestChat<C extends Context>(
  first: Bot<C>,
  options: TestChatOptions = {},
): ScreenTestChat<C> {
  const chatId = options.chatId ?? 1_000;
  const userId = options.userId ?? chatId;
  const chat: TestChatPeer =
    options.chatType === 'group'
      ? { id: chatId, type: 'group', title: 'Test' }
      : options.chatType === 'supergroup'
        ? { id: chatId, type: 'supergroup', title: 'Test' }
        : { id: chatId, type: 'private', first_name: 'Test' };
  const user = { id: userId, is_bot: false, first_name: 'Test' };
  const botUser = {
    id: 42,
    is_bot: true,
    first_name: 'Screens',
    username: 'screens_test_bot',
  };
  const botInfo: UserFromGetMe = {
    ...botUser,
    is_bot: true,
    can_join_groups: true,
    can_read_all_group_messages: false,
    supports_inline_queries: false,
    can_connect_to_business: false,
    has_main_web_app: false,
    has_topics_enabled: false,
    allows_users_to_create_topics: false,
    can_manage_bots: false,
    supports_join_request_queries: false,
  };
  let bot = first;
  const calls: TestChatCall[] = [];
  const failures = new Map<string, { description: string; errorCode: number }>();
  let nextUpdateId = 1;
  const telegram = createFakeTelegram({ chat, botUser, user });
  const { stored, find, asTelegram } = telegram;

  const connect = (next: Bot<C>) => {
    if (!next.isInited()) next.botInfo = botInfo;
    next.api.config.use(async (_previous, method, payload) => {
      const body: Readonly<Record<string, unknown>> = isRecord(payload) ? payload : {};
      calls.push({ method, payload: body });
      const failure = failures.get(method);
      if (failure) {
        failures.delete(method);
        return transportResult(telegram.refuse(failure.description, failure.errorCode));
      }
      // One fake answers every method with the shape Telegram gives it; the
      // transformer's per-method result type cannot be followed through a switch.
      return transportResult(telegram.answer(method, body));
    });
    bot = next;
  };
  connect(first);

  // As long polling delivers: a middleware error reaches `bot.catch`, and
  // rejects only when the bot has none — so a test sees the bot's own boundary.
  const deliver = async (update: Readonly<Record<string, unknown>>) => {
    try {
      await bot.handleUpdate(
        transportResult<Update>({ update_id: nextUpdateId++, ...update }),
      );
    } catch (error) {
      if (!(isRecord(error) && error.name === 'BotError' && 'ctx' in error)) throw error;
      await bot.errorHandler(transportResult<BotError<C>>(error));
    }
  };

  const userMessage = (
    fields: Record<string, unknown>,
  ): StoredMessage & { telegram: Message } => {
    const message: StoredMessage = {
      id: telegram.nextMessageId(),
      from: 'user',
      kind: 'photo' in fields ? 'photo' : 'text',
      text:
        typeof fields.text === 'string'
          ? fields.text
          : typeof fields.caption === 'string'
            ? fields.caption
            : '',
      media: undefined,
      rich: undefined,
      markup: undefined,
      deleted: false,
    };
    stored.push(message);
    return {
      ...message,
      telegram: transportResult<Message>({
        message_id: message.id,
        date: 1_700_000_000,
        chat,
        from: user,
        ...fields,
      }),
    };
  };

  const pressOn = async (message: StoredMessage, data: string) => {
    await deliver({
      callback_query: {
        id: `press-${nextUpdateId}`,
        from: user,
        chat_instance: 'test',
        data,
        message: asTelegram(message),
      },
    });
  };

  return {
    get messages() {
      return stored
        .filter((message) => !message.deleted)
        .map((message) => ({
          id: message.id,
          from: message.from,
          kind: message.kind,
          text: message.text,
          media: message.media,
          rich: message.rich,
          buttons: (message.markup?.inline_keyboard ?? []).map((row) =>
            row.map((button) => button.text),
          ),
          markup: message.markup,
        }));
    },
    calls,
    answers: telegram.answers,
    send: async (text) => {
      const command = /^\/\w+/.exec(text);
      const { telegram } = userMessage({
        text,
        ...(command
          ? { entities: [{ type: 'bot_command', offset: 0, length: command[0].length }] }
          : {}),
      });
      await deliver({ message: telegram });
    },
    sendPhoto: async (fileId, caption) => {
      const { telegram } = userMessage({
        photo: [{ file_id: fileId, file_unique_id: fileId, width: 1, height: 1 }],
        ...(caption === undefined ? {} : { caption }),
      });
      await deliver({ message: telegram });
    },
    press: async (label) => {
      for (const message of [...stored].reverse()) {
        if (message.deleted) continue;
        for (const row of message.markup?.inline_keyboard ?? []) {
          for (const button of row) {
            if (button.text === label && 'callback_data' in button)
              return pressOn(message, button.callback_data);
          }
        }
      }
      throw new Error(`No button "${label}" in the chat.`);
    },
    pressData: async (messageId, data) => {
      const message = find(messageId);
      if (!message) throw new Error(`No message ${messageId} in the chat.`);
      await pressOn(message, data);
    },
    failNext: (method, description, errorCode = 400) => {
      failures.set(method, { description, errorCode });
    },
    deleteByUser: (messageId) => {
      const message = find(messageId);
      if (message) message.deleted = true;
    },
    restart: (next) => connect(next),
    clearCalls: () => {
      calls.length = 0;
      telegram.answers.length = 0;
    },
  };
}
