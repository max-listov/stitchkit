/**
 * Telegram widgets (Bot API 10.4): the limits a widget message must keep and
 * the shapes Telegram sends back, for both sides of a bot.
 *
 * A widget is HTML that the Telegram app runs and draws inside a message. Every
 * limit is counted in UTF-8 bytes, not in JavaScript characters, so a string
 * that looks short in an editor can still be refused: one emoji is four bytes,
 * one Cyrillic letter two. The schemas here check a value before any request,
 * so a refusal names its field and size instead of coming back as a 400.
 *
 * What Telegram sends is parsed loosely: only the fields used here are checked,
 * and the rest pass through, because every Bot API release adds fields to a
 * message, a user and a chat, and a strict parse of a successful send would
 * turn a delivered widget into an unknown outcome.
 */

import { deflateSync } from 'node:zlib';
import { z } from 'zod';

/** The widget limits Telegram states, in UTF-8 bytes unless named otherwise. */
export const TELEGRAM_WIDGET_LIMITS = Object.freeze({
  /** Widget HTML, 1 to 32768 bytes. */
  htmlBytes: 32_768,
  /** Widget HTML after zlib at the maximum compression level. */
  compressedHtmlBytes: 4_096,
  /** `chat_data`, `public_data` and a query answer, 0 to 1024 bytes each. */
  dataBytes: 1_024,
  /** The data a widget sends with a query, 1 to 64 bytes. */
  queryDataBytes: 64,
  /** How long Telegram waits for the answer to a widget query. */
  answerWindowMs: 15_000,
});

const encoder = new TextEncoder();
const decoder = new TextDecoder('utf-8', { ignoreBOM: true });

/**
 * Why `value` cannot be a widget string of `min`..`max` UTF-8 bytes, or
 * `undefined` when it can. An unpaired surrogate is refused because it does not
 * survive UTF-8 encoding (it becomes U+FFFD), so Telegram would keep another
 * string than the one sent. A NUL is this package's refusal, not Telegram's: a
 * widget reads its data as text, and a NUL in it is a bug upstream.
 */
function textProblem(value: string, max: number, min = 0): string | undefined {
  if (value.includes('\0')) return 'contains NUL';
  const encoded = encoder.encode(value);
  if (decoder.decode(encoded) !== value) return 'contains an unpaired surrogate';
  const bytes = encoded.length;
  if (bytes < min) return `is ${bytes} UTF-8 bytes, at least ${min} required`;
  if (bytes > max) return `is ${bytes} UTF-8 bytes, at most ${max} allowed`;
  return undefined;
}

/**
 * The compressed size is this runtime's zlib at level 9, an estimate of
 * Telegram's: zlib builds differ by tens of bytes near the limit (Node's comes
 * out smaller than Bun's on the same HTML), and which one Telegram runs is not
 * stated. A sender close to 4096 keeps its own margin.
 */
function htmlProblem(html: string): string | undefined {
  const problem = textProblem(html, TELEGRAM_WIDGET_LIMITS.htmlBytes, 1);
  if (problem !== undefined) return problem;
  const compressed = deflateSync(html, { level: 9 }).byteLength;
  return compressed > TELEGRAM_WIDGET_LIMITS.compressedHtmlBytes
    ? `compresses to ${compressed} bytes, at most ${TELEGRAM_WIDGET_LIMITS.compressedHtmlBytes} allowed`
    : undefined;
}

function widgetText(problemOf: (value: string) => string | undefined) {
  return z.string().superRefine((value, context) => {
    const problem = problemOf(value);
    if (problem !== undefined)
      context.addIssue({ code: 'custom', message: `Text ${problem}` });
  });
}

/**
 * Widget HTML: 1–32768 UTF-8 bytes, no NUL, and at most 4096 once compressed by
 * this runtime's zlib at level 9 — an estimate of Telegram's, so keep a margin.
 */
export const TelegramWidgetHtmlSchema = widgetText(htmlProblem);

/** `chat_data`, `public_data` or a query answer: 0–1024 UTF-8 bytes, no NUL. */
export const TelegramWidgetDataSchema = widgetText((value) =>
  textProblem(value, TELEGRAM_WIDGET_LIMITS.dataBytes),
);

/** The data of a widget query: 1–64 UTF-8 bytes, sent by the user's app. */
const QueryDataSchema = widgetText((value) =>
  textProblem(value, TELEGRAM_WIDGET_LIMITS.queryDataBytes, 1),
);

/** A TON wallet named in a signed-data or transaction query. */
const WalletSchema = z.looseObject({
  address: z.string(),
  amount: z.string(),
  public_key: z.string().optional(),
  state_init: z.string().optional(),
});

/**
 * Telegram's widget message: the sent `Message` with its `widget`. Only the
 * fields a sender needs are checked — where the message is and what it holds.
 */
export const TelegramWidgetMessageSchema = z.looseObject({
  message_id: z.int().nonnegative(),
  chat: z.looseObject({ id: z.int(), type: z.string() }),
  widget: z.looseObject({
    html: z.string(),
    /** Present only for a shared widget. */
    id: z.string().optional(),
    width: z.int().optional(),
    height: z.int().optional(),
    public_data: z.string().optional(),
    chat_data: z.string().optional(),
  }),
});
/** A sent widget message as Telegram returns it; fields not checked here pass through. */
export type TelegramWidgetMessage = z.infer<typeof TelegramWidgetMessageSchema>;

/**
 * `Update.widget_query`: a query from a widget in a message the bot sent. The
 * message is `chat` with `message_id`, or `inline_message_id` for an inline
 * one; `from` is filled in by Telegram. `type` is one of the three kinds the
 * Bot API documents; a kind it adds later fails this schema, and
 * {@link parseTelegramWidgetQuery} still returns the query's id so it can be
 * refused instead of left to time out.
 */
export const TelegramWidgetQuerySchema = z.looseObject({
  id: z.string().min(1),
  from: z.looseObject({ id: z.int() }),
  chat: z.looseObject({ id: z.int(), type: z.string() }).optional(),
  message_id: z.int().optional(),
  inline_message_id: z.string().optional(),
  chat_instance: z.string(),
  /** For an inline message: `sender`, `private`, `group`, `supergroup` or `channel`. */
  chat_type: z.string().optional(),
  type: z.discriminatedUnion('type', [
    z.looseObject({ type: z.literal('data'), wallet_card: z.looseObject({}).optional() }),
    z.looseObject({
      type: z.literal('sign_data'),
      wallet: WalletSchema,
      sign_data: z.string(),
    }),
    z.looseObject({
      type: z.literal('sent_transaction'),
      wallet: WalletSchema,
      msg_hash: z.string(),
    }),
  ]),
  data: QueryDataSchema,
  /** Present only when a shared widget sent the query. */
  widget_id: z.string().optional(),
});
/** One widget query, as `TelegramWidgetQuerySchema` reads it. */
export type TelegramWidgetQuery = z.infer<typeof TelegramWidgetQuerySchema>;

/**
 * A parsed widget query, or the id of one that did not parse together with why.
 * The id is enough to answer: an unparsed query still gets a refusal.
 */
export type TelegramWidgetQueryParse =
  | { readonly query: TelegramWidgetQuery }
  | { readonly id: string; readonly error: z.ZodError };

/**
 * Read `update.widget_query`. Returns the query, the id and parse error of one
 * that does not match, or `undefined` when there is no query id to answer.
 */
export function parseTelegramWidgetQuery(
  value: unknown,
): TelegramWidgetQueryParse | undefined {
  const parsed = TelegramWidgetQuerySchema.safeParse(value);
  if (parsed.success) return { query: parsed.data };
  const id: unknown =
    typeof value === 'object' && value !== null ? Reflect.get(value, 'id') : undefined;
  return typeof id === 'string' && id.length > 0 ? { id, error: parsed.error } : undefined;
}
