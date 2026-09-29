/**
 * The Telegram side of the test chat: the messages it keeps and how it answers
 * the Bot API calls screens make.
 *
 * It keeps the rules screens depend on: an edit that changes nothing is
 * refused as "message is not modified", a deleted message cannot be edited or
 * deleted again, a text message has no caption to edit, a media message no
 * text.
 */
import type { Chat, InlineKeyboardMarkup, Message, User } from 'grammy/types';
import { isRecord, transportResult } from '../../internal/typed';
import { checkTelegramHtml, type TelegramHtmlProblem } from '../html/check';
import { TELEGRAM_CAPTION_LIMIT, TELEGRAM_TEXT_LIMIT } from '../html/nodes';

export type TestMessageKind =
  | 'text'
  | 'rich'
  | 'photo'
  | 'video'
  | 'animation'
  | 'document'
  | 'audio';

export interface StoredMessage {
  id: number;
  from: 'bot' | 'user';
  kind: TestMessageKind;
  text: string;
  media: string | undefined;
  rich: unknown;
  markup: InlineKeyboardMarkup | undefined;
  deleted: boolean;
}

export type TestChatPeer = Chat.PrivateChat | Chat.GroupChat | Chat.SupergroupChat;

export interface FakeTelegramIdentity {
  readonly chat: TestChatPeer;
  readonly botUser: User;
  readonly user: User;
}

export interface FakeTelegramRefusal {
  readonly ok: false;
  readonly error_code: number;
  readonly description: string;
}

export interface FakeTelegram {
  /** Every message the chat has had, deleted ones marked. */
  readonly stored: StoredMessage[];
  /** Press answers — the toasts — in order. */
  readonly answers: string[];
  /** A message still in the chat. */
  find(id: unknown): StoredMessage | undefined;
  asTelegram(message: StoredMessage): Message;
  /** A Bot API call answered the way Telegram would. */
  answer(method: string, payload: Readonly<Record<string, unknown>>): unknown;
  refuse(description: string, errorCode?: number): FakeTelegramRefusal;
  nextMessageId(): number;
}

const MEDIA: readonly TestMessageKind[] = ['photo', 'video', 'animation', 'document', 'audio'];

const SENT_KINDS: Readonly<Record<string, TestMessageKind>> = {
  sendPhoto: 'photo',
  sendVideo: 'video',
  sendAnimation: 'animation',
  sendDocument: 'document',
  sendAudio: 'audio',
};

const CALLBACK_DATA_LIMIT = 64;

const PARSE_REFUSALS: Readonly<Record<TelegramHtmlProblem['kind'], string>> = {
  'bare-character': 'unexpected character',
  'unsupported-tag': 'Unsupported start tag',
  'unmatched-end-tag': "Can't find end tag corresponding to start tag",
  'unclosed-tag': "Can't find end of the entity",
};

/**
 * Why Telegram would refuse this markup, as it words it — unbalanced or
 * unknown tags, a bare `<` or `&`, text past the limit — or `undefined`.
 */
function htmlRefusal(markup: string, limit: number): string | undefined {
  const { problem, text } = checkTelegramHtml(markup);
  if (problem) {
    const detail = problem.kind === 'unsupported-tag' ? ` "${problem.tag}"` : '';
    return `Bad Request: can't parse entities: ${PARSE_REFUSALS[problem.kind]}${detail}`;
  }
  if ([...text].length > limit) {
    return limit === TELEGRAM_CAPTION_LIMIT
      ? 'Bad Request: message caption is too long'
      : 'Bad Request: message is too long';
  }
  return undefined;
}

/** Why Telegram would refuse this send or edit, or `undefined`. */
function payloadRefusal(
  payload: Readonly<Record<string, unknown>>,
  field: 'text' | 'caption',
): string | undefined {
  for (const row of markupAt(payload)?.inline_keyboard ?? []) {
    for (const button of row) {
      if (
        'callback_data' in button &&
        new TextEncoder().encode(button.callback_data).length > CALLBACK_DATA_LIMIT
      ) {
        return 'Bad Request: BUTTON_DATA_INVALID';
      }
    }
  }
  const text = stringAt(payload, field);
  if (text === undefined || payload.parse_mode !== 'HTML') return undefined;
  return htmlRefusal(text, field === 'caption' ? TELEGRAM_CAPTION_LIMIT : TELEGRAM_TEXT_LIMIT);
}

const NOT_MODIFIED =
  'Bad Request: message is not modified: specified new message content and reply markup are exactly the same as a current content and reply markup of the message';

function stringAt(
  payload: Readonly<Record<string, unknown>>,
  key: string,
): string | undefined {
  const value = payload[key];
  return typeof value === 'string' ? value : undefined;
}

function markupAt(
  payload: Readonly<Record<string, unknown>>,
): InlineKeyboardMarkup | undefined {
  const markup = payload.reply_markup;
  if (!isRecord(markup) || !Array.isArray(markup.inline_keyboard)) return undefined;
  return transportResult<InlineKeyboardMarkup>(markup);
}

function sameMarkup(
  left: InlineKeyboardMarkup | undefined,
  right: InlineKeyboardMarkup | undefined,
): boolean {
  return (
    JSON.stringify(left?.inline_keyboard ?? []) ===
    JSON.stringify(right?.inline_keyboard ?? [])
  );
}

/** Apply an edit's new content, or refuse it when the message has no such part. */
function editContent(
  message: StoredMessage,
  method: string,
  payload: Readonly<Record<string, unknown>>,
): { changed: boolean } | { refused: string } {
  if (method === 'editMessageText') {
    if (message.kind !== 'text' && message.kind !== 'rich') {
      return { refused: 'Bad Request: there is no text in the message to edit' };
    }
    const text = stringAt(payload, 'text') ?? '';
    const rich = payload.rich_message;
    const changed =
      text !== message.text || JSON.stringify(rich) !== JSON.stringify(message.rich);
    message.text = text;
    message.rich = rich;
    return { changed };
  }
  if (method === 'editMessageCaption') {
    if (!MEDIA.includes(message.kind)) {
      return { refused: 'Bad Request: there is no caption in the message to edit' };
    }
    const caption = stringAt(payload, 'caption') ?? '';
    const changed = caption !== message.text;
    message.text = caption;
    return { changed };
  }
  if (method === 'editMessageMedia') {
    const media = isRecord(payload.media) ? payload.media : {};
    const type = stringAt(media, 'type');
    const kind = MEDIA.find((candidate) => candidate === type);
    if (!kind) return { refused: 'Bad Request: wrong media type' };
    const source = stringAt(media, 'media');
    const caption = stringAt(media, 'caption') ?? '';
    const changed =
      kind !== message.kind || source !== message.media || caption !== message.text;
    Object.assign(message, { kind, media: source, text: caption, rich: undefined });
    return { changed };
  }
  return { changed: false };
}

export function createFakeTelegram({
  chat,
  botUser,
  user,
}: FakeTelegramIdentity): FakeTelegram {
  const stored: StoredMessage[] = [];
  const answers: string[] = [];
  let lastMessageId = 0;

  const refuse = (description: string, errorCode = 400): FakeTelegramRefusal => ({
    ok: false,
    error_code: errorCode,
    description,
  });
  const find = (id: unknown) =>
    stored.find((message) => message.id === id && !message.deleted);

  const asTelegram = (message: StoredMessage): Message => {
    const base = {
      message_id: message.id,
      date: 1_700_000_000,
      chat,
      from: message.from === 'bot' ? botUser : user,
    };
    const markup = message.markup ? { reply_markup: message.markup } : {};
    if (message.kind === 'text')
      return transportResult<Message>({ ...base, text: message.text, ...markup });
    if (message.kind === 'rich')
      return transportResult<Message>({ ...base, rich_message: message.rich, ...markup });
    const file = { file_id: message.media ?? '', file_unique_id: message.media ?? '' };
    const media =
      message.kind === 'photo'
        ? { photo: [{ ...file, width: 1, height: 1 }] }
        : { [message.kind]: file };
    return transportResult<Message>({
      ...base,
      ...media,
      ...(message.text ? { caption: message.text } : {}),
      ...markup,
    });
  };

  const send = (kind: TestMessageKind, payload: Readonly<Record<string, unknown>>) => {
    const refusal = payloadRefusal(payload, kind === 'text' ? 'text' : 'caption');
    if (refusal) return refuse(refusal);
    const message: StoredMessage = {
      id: ++lastMessageId,
      from: 'bot',
      kind,
      text: stringAt(payload, kind === 'text' ? 'text' : 'caption') ?? '',
      media: kind === 'text' || kind === 'rich' ? undefined : stringAt(payload, kind),
      rich: payload.rich_message,
      markup: markupAt(payload),
      deleted: false,
    };
    stored.push(message);
    return { ok: true, result: asTelegram(message) };
  };

  const edit = (method: string, payload: Readonly<Record<string, unknown>>) => {
    const message = find(payload.message_id);
    if (!message) return refuse('Bad Request: message to edit not found');
    const media = isRecord(payload.media) ? payload.media : undefined;
    const refusal =
      method === 'editMessageMedia' && media
        ? payloadRefusal({ ...media, reply_markup: payload.reply_markup }, 'caption')
        : payloadRefusal(payload, method === 'editMessageCaption' ? 'caption' : 'text');
    if (refusal) return refuse(refusal);
    const markup = markupAt(payload);
    const content = editContent(message, method, payload);
    if ('refused' in content) return refuse(content.refused);
    if (!content.changed && sameMarkup(message.markup, markup)) return refuse(NOT_MODIFIED);
    message.markup = markup;
    return { ok: true, result: asTelegram(message) };
  };

  const answer = (method: string, payload: Readonly<Record<string, unknown>>): unknown => {
    switch (method) {
      case 'sendMessage':
        return send('text', payload);
      case 'sendRichMessage':
        return send('rich', payload);
      case 'sendPhoto':
      case 'sendVideo':
      case 'sendAnimation':
      case 'sendDocument':
      case 'sendAudio':
        return send(SENT_KINDS[method] ?? 'document', payload);
      case 'editMessageText':
      case 'editMessageCaption':
      case 'editMessageMedia':
      case 'editMessageReplyMarkup':
        return edit(method, payload);
      case 'deleteMessage': {
        const message = find(payload.message_id);
        if (!message) return refuse('Bad Request: message to delete not found');
        message.deleted = true;
        return { ok: true, result: true };
      }
      case 'answerCallbackQuery':
        answers.push(stringAt(payload, 'text') ?? '');
        return { ok: true, result: true };
      default:
        return { ok: true, result: true };
    }
  };

  return {
    stored,
    answers,
    find,
    asTelegram,
    answer,
    refuse,
    nextMessageId: () => ++lastMessageId,
  };
}
