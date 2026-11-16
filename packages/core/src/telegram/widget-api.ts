/**
 * The three Bot API 10.4 widget methods over a grammY client the bot already has.
 *
 * grammY 1.46 does not type `sendWidget`, `editMessageWidgetData` or
 * `answerWidgetQuery`, and a bot that reaches for them builds a second client
 * or a second token reader, and with it a second limiter. `api.raw` needs none:
 * grammY's proxy sends any method name through the client's own transformers —
 * the outbound budget, a sandbox, error capture — so a widget send waits for
 * the same slot as every other message of the token and an answer, which costs
 * no message, does not.
 *
 * The methods keep the Bot API's names and parameters, so the call reads as the
 * grammY call it will become once grammY types it, and a new Telegram parameter
 * needs no second name here. Each call:
 *
 * 1. checks its input against Telegram's limits and throws `ZodError` — nothing
 *    was sent, and the same input will be refused again;
 * 2. throws `TelegramNotDispatchedError` when the signal is already aborted —
 *    nothing was sent, and it is safe to send again;
 * 3. hands the request to the client once. It never repeats it: a failure after
 *    this point may have been delivered, and a send whose outcome is unknown is
 *    the caller's to settle;
 * 4. parses Telegram's answer. An unexpected successful answer is an ordinary
 *    error with the parse failure as its `cause` — the request was sent.
 *
 * grammY is named in the declarations and never imported at run time.
 */

import type { Api, RawApi } from 'grammy';
import type {
  ForceReply,
  InlineKeyboardMarkup,
  MessageEntity,
  ParseMode,
  ReplyKeyboardMarkup,
  ReplyKeyboardRemove,
  ReplyParameters,
} from 'grammy/types';
import { z } from 'zod';
import { TelegramNotDispatchedError } from './not-dispatched';
import { classifyTelegramEditRefusal } from './send-failure';
import {
  TelegramWidgetDataSchema,
  TelegramWidgetHtmlSchema,
  type TelegramWidgetMessage,
  TelegramWidgetMessageSchema,
} from './widget';

/** `sendWidget` parameters, as the Bot API names them. */
export interface TelegramSendWidgetParams {
  readonly chat_id: number | string;
  /** The forum topic, for forum supergroups and private chats with topics. */
  readonly message_thread_id?: number;
  /** 1–32768 UTF-8 bytes, at most 4096 once compressed by zlib level 9. */
  readonly html: string;
  /** Logical pixels; omitted, the widget takes the bubble's width. */
  readonly width?: number;
  /** Logical pixels; omitted, the height is not fixed. */
  readonly height?: number;
  /** 0–1024 UTF-8 bytes, visible wherever the widget is shown. */
  readonly public_data?: string;
  /** 0–1024 UTF-8 bytes, specific to this message. */
  readonly chat_data?: string;
  /** Shown by an app that cannot draw the widget too; 0–1024 characters. */
  readonly caption?: string;
  readonly parse_mode?: ParseMode;
  readonly caption_entities?: readonly MessageEntity[];
  readonly show_caption_above_media?: boolean;
  /** Let the widget send queries to the bot. */
  readonly allow_queries?: boolean;
  readonly disable_notification?: boolean;
  readonly protect_content?: boolean;
  readonly allow_paid_broadcast?: boolean;
  readonly message_effect_id?: string;
  readonly reply_parameters?: ReplyParameters;
  readonly reply_markup?:
    | InlineKeyboardMarkup
    | ReplyKeyboardMarkup
    | ReplyKeyboardRemove
    | ForceReply;
}

/**
 * `editMessageWidgetData` parameters, as the Bot API names them: a chat message
 * (`chat_id` with `message_id`) or an inline one, and the data that changes —
 * an empty string removes it, an omitted field keeps it.
 */
export type TelegramEditMessageWidgetDataParams = (
  | {
      readonly chat_id: number | string;
      readonly message_id: number;
      readonly inline_message_id?: never;
    }
  | {
      readonly inline_message_id: string;
      readonly chat_id?: never;
      readonly message_id?: never;
    }
) &
  (
    | { readonly chat_data: string; readonly public_data?: string }
    | { readonly public_data: string; readonly chat_data?: string }
  );

/** `answerWidgetQuery` parameters, as the Bot API names them. */
export interface TelegramAnswerWidgetQueryParams {
  readonly widget_query_id: string;
  /** 0–1024 UTF-8 bytes; the widget that asked receives it, its data does not change. */
  readonly data?: string;
}

/** Per-call options of {@link TelegramWidgetApi}. */
export interface TelegramWidgetCallOptions {
  /** Cancels the call; before the request leaves, it fails as not dispatched. */
  readonly signal?: AbortSignal;
}

/** The widget methods of one grammY client. */
export interface TelegramWidgetApi {
  /** Send a widget message. Resolves to the sent message with its widget. */
  sendWidget(
    params: TelegramSendWidgetParams,
    options?: TelegramWidgetCallOptions,
  ): Promise<TelegramWidgetMessage>;
  /** Change a widget's data. Data already as asked (`message is not modified`) is success. */
  editMessageWidgetData(
    params: TelegramEditMessageWidgetDataParams,
    options?: TelegramWidgetCallOptions,
  ): Promise<void>;
  /** Answer a widget query; costs no message and waits for no outbound budget. */
  answerWidgetQuery(
    params: TelegramAnswerWidgetQueryParams,
    options?: TelegramWidgetCallOptions,
  ): Promise<void>;
}

const ChatIdSchema = z.union([z.int(), z.string().min(1)]);

const SendInputSchema = z.object({
  chat_id: ChatIdSchema,
  html: TelegramWidgetHtmlSchema,
  public_data: TelegramWidgetDataSchema.optional(),
  chat_data: TelegramWidgetDataSchema.optional(),
});

const EditInputSchema = z
  .object({
    chat_id: ChatIdSchema.optional(),
    message_id: z.int().optional(),
    inline_message_id: z.string().min(1).optional(),
    public_data: TelegramWidgetDataSchema.optional(),
    chat_data: TelegramWidgetDataSchema.optional(),
  })
  .refine(
    (edit) =>
      edit.inline_message_id === undefined
        ? edit.chat_id !== undefined && edit.message_id !== undefined
        : edit.chat_id === undefined && edit.message_id === undefined,
    { message: 'Pass chat_id with message_id, or inline_message_id alone' },
  )
  .refine((edit) => edit.chat_data !== undefined || edit.public_data !== undefined, {
    message: 'Pass chat_data or public_data to change',
  });

const AnswerInputSchema = z.object({
  widget_query_id: z.string().min(1),
  data: TelegramWidgetDataSchema.optional(),
});

const TrueSchema = z.literal(true);

/**
 * The payload, read once: it is what is checked and what is sent. A field is
 * omitted only when it is `undefined`, so `''` reaches Telegram.
 */
function payloadOf(params: object): Record<string, unknown> {
  return Object.fromEntries(Object.entries(params).filter(([, value]) => value !== undefined));
}

/** Hand one request to the client's transformer chain, unless it is cancelled already. */
async function dispatch(
  api: Pick<Api<RawApi>, 'raw'>,
  method: string,
  payload: Record<string, unknown>,
  signal: AbortSignal | undefined,
): Promise<unknown> {
  if (signal?.aborted) {
    throw new TelegramNotDispatchedError(
      'request',
      `the Telegram ${method} request was cancelled before it was sent`,
      { cause: signal.reason },
    );
  }
  const call: unknown = Reflect.get(api.raw, method);
  if (typeof call !== 'function') {
    throw new TypeError(`This grammY client has no ${method} method`);
  }
  return await Reflect.apply(call, api.raw, [payload, signal]);
}

/** Telegram's answer to a request that was sent, or an error that says the outcome is unknown. */
function answered<T>(method: string, schema: z.ZodType<T>, value: unknown): T {
  const parsed = schema.safeParse(value);
  if (parsed.success) return parsed.data;
  throw new Error(
    `Telegram answered ${method} with an unexpected result; the request was sent and its outcome is unknown`,
    { cause: parsed.error },
  );
}

/**
 * The widget methods of `api`, run through its transformers: install
 * `telegramBudgetTransformer` on the client and widget sends share the token's
 * budget.
 */
export function telegramWidgetApi(api: Pick<Api<RawApi>, 'raw'>): TelegramWidgetApi {
  return {
    async sendWidget(params, options) {
      const payload = payloadOf(params);
      SendInputSchema.parse(payload);
      const value = await dispatch(api, 'sendWidget', payload, options?.signal);
      return answered('sendWidget', TelegramWidgetMessageSchema, value);
    },
    async editMessageWidgetData(params, options) {
      const payload = payloadOf(params);
      EditInputSchema.parse(payload);
      let value: unknown;
      try {
        value = await dispatch(api, 'editMessageWidgetData', payload, options?.signal);
      } catch (error) {
        if (classifyTelegramEditRefusal(error) === 'not-modified') return;
        throw error;
      }
      answered('editMessageWidgetData', TrueSchema, value);
    },
    async answerWidgetQuery(params, options) {
      const payload = payloadOf(params);
      AnswerInputSchema.parse(payload);
      const value = await dispatch(api, 'answerWidgetQuery', payload, options?.signal);
      answered('answerWidgetQuery', TrueSchema, value);
    },
  };
}
