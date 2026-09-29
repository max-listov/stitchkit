/**
 * A view as Telegram will receive it: payloads, `callback_data` and the
 * fingerprints the next render is compared against.
 *
 * Buttons are resolved here, against the registered screens: a link becomes
 * its target's id and params, `back` the parent of the screen being shown, an
 * action the screen's own id, params and input. An address longer than
 * Telegram's 64 bytes is kept in the chat's state under a short token and the
 * button carries the token — so a long param never makes a screen unrenderable.
 */
import type {
  InlineKeyboardButton,
  InlineKeyboardMarkup,
  InputRichMessageWithoutUpload,
} from 'grammy/types';
import { argumentsDigest } from '../../internal/stable-digest';
import { escapeTelegramHtml } from '../html/render';
import {
  type ActionValue,
  CALLBACK_DATA_LIMIT,
  encodeCallback,
  encodeToken,
  utf8Length,
} from './callback-codec';
import { TelegramHtml, type TelegramText } from './html';
import type { AnyTelegramScreen, ScreenParams } from './screen-types';
import { RECORD_LIMITS } from './state';
import {
  type ButtonLabel,
  type Keyboard,
  SCREEN_MEDIA_KINDS,
  ScreenButton,
  type ScreenMediaKind,
  type ScreenViewResult,
  type ViewMessage,
} from './view';

export type RenderedKind = 'text' | 'rich' | ScreenMediaKind;

/** The parts of a message that are edited separately, as digests. */
export interface MessageFingerprint {
  readonly content: string;
  readonly media: string;
  readonly markup: string;
}

export interface OutgoingMessage {
  readonly key: string;
  readonly kind: RenderedKind;
  /**
   * Telegram HTML: the text of a text message, the caption of a media one.
   * Always sent with `parse_mode: 'HTML'`, plain strings escaped — so no
   * `parse_mode` default an application sets elsewhere can reinterpret it.
   */
  readonly html: string | undefined;
  readonly rich: InputRichMessageWithoutUpload | undefined;
  readonly linkPreview: boolean | undefined;
  readonly media: string | undefined;
  readonly markup: InlineKeyboardMarkup | undefined;
  readonly fingerprint: MessageFingerprint;
}

/** Where a screen button leads, resolved against the registered screens. */
export interface ButtonResolver {
  /** The id and param order of a registered screen; throws for one not registered. */
  addressOf(screen: AnyTelegramScreen): {
    readonly id: string;
    readonly params: readonly string[];
  };
  /** The parent of the screen being rendered, or `undefined` at the root. */
  readonly parent: { readonly id: string; readonly params: readonly string[] } | undefined;
  readonly path: string;
}

export interface RenderContext {
  readonly prefix: string;
  readonly resolver: ButtonResolver;
  readonly params: ScreenParams;
}

export interface RenderedView {
  readonly messages: readonly OutgoingMessage[];
  /** Addresses too long for a button, by token. */
  readonly tokens: Readonly<Record<string, string>>;
}

/** Text as Telegram HTML: markup as it is, a plain string escaped. */
export function htmlOf(text: TelegramText): string {
  return text instanceof TelegramHtml ? text.toString() : escapeTelegramHtml(text);
}

function mediaOf(message: ViewMessage): { kind: ScreenMediaKind; source: string } | undefined {
  for (const kind of SCREEN_MEDIA_KINDS) {
    const source = message[kind];
    if (typeof source === 'string') return { kind, source };
  }
  return undefined;
}

function paramValues(
  names: readonly string[],
  params: Readonly<Record<string, ActionValue>>,
  where: string,
): ActionValue[] {
  return names.map((name) => {
    const value = params[name];
    if (value === undefined) {
      throw new Error(
        `[stitchkit] telegram screens: a button to "${where}" is missing param "${name}".`,
      );
    }
    return value;
  });
}

function labelled(
  label: ButtonLabel,
  callbackData: string,
): InlineKeyboardButton.CallbackButton {
  return typeof label === 'string'
    ? { text: label, callback_data: callbackData }
    : { ...label, callback_data: callbackData };
}

/**
 * Addresses too long for a button, kept in the view's record. A token is a
 * digest of the address it stands for, not a counter: a counter would give an
 * older message's token a new meaning after the next render, and its button
 * would do something else. Being a digest, the same button renders the same
 * token every time, so an unchanged keyboard stays unchanged.
 */
class TokenBook {
  readonly tokens: Record<string, string> = {};

  constructor(
    private readonly prefix: string,
    private readonly where: string,
  ) {}

  data(body: string): string {
    const direct = this.prefix + body;
    if (utf8Length(direct) <= CALLBACK_DATA_LIMIT) return direct;
    if (body.length > RECORD_LIMITS.tokenBody) {
      throw new Error(
        `[stitchkit] telegram screens: a button of "${this.where}" carries ${body.length} characters; a kept address holds ${RECORD_LIMITS.tokenBody}.`,
      );
    }
    const token = argumentsDigest({ body }).slice(0, 12);
    const known = this.tokens[token];
    if (known === undefined && Object.keys(this.tokens).length >= RECORD_LIMITS.tokens) {
      throw new Error(
        `[stitchkit] telegram screens: "${this.where}" renders more than ${RECORD_LIMITS.tokens} buttons too long to carry their address.`,
      );
    }
    if (known !== undefined && known !== body) {
      throw new Error(
        `[stitchkit] telegram screens: two buttons of "${this.where}" share a token; shorten one of their addresses.`,
      );
    }
    this.tokens[token] = body;
    const spilled = this.prefix + encodeToken(token);
    if (utf8Length(spilled) > CALLBACK_DATA_LIMIT) {
      throw new Error(
        `[stitchkit] telegram screens: callback prefix "${this.prefix}" leaves no room for a button.`,
      );
    }
    return spilled;
  }
}

function buttonData(button: ScreenButton, context: RenderContext, book: TokenBook): string {
  const { target } = button;
  const { resolver } = context;
  if (target.kind === 'back') {
    const parent = resolver.parent;
    if (!parent) {
      throw new Error(
        `[stitchkit] telegram screens: "${resolver.path}" has no parent to go back to.`,
      );
    }
    return book.data(
      encodeCallback({
        screen: parent.id,
        params: paramValues(parent.params, context.params, resolver.path),
      }),
    );
  }
  const address = resolver.addressOf(target.screen);
  const params = paramValues(address.params, target.params, target.screen.path);
  return book.data(
    target.kind === 'link'
      ? encodeCallback({ screen: address.id, params })
      : encodeCallback({
          screen: address.id,
          action: target.action,
          params,
          input: target.input,
        }),
  );
}

function renderKeyboard(
  keyboard: Keyboard | undefined,
  context: RenderContext,
  book: TokenBook,
): InlineKeyboardMarkup | undefined {
  if (!keyboard) return undefined;
  const rows: InlineKeyboardButton[][] = [];
  for (const row of keyboard) {
    if (!row) continue;
    const buttons: InlineKeyboardButton[] = [];
    for (const button of row) {
      if (!button) continue;
      buttons.push(
        button instanceof ScreenButton
          ? labelled(button.label, buttonData(button, context, book))
          : button,
      );
    }
    if (buttons.length > 0) rows.push(buttons);
  }
  return rows.length > 0 ? { inline_keyboard: rows } : undefined;
}

function renderMessage(
  message: ViewMessage,
  key: string,
  context: RenderContext,
  book: TokenBook,
): OutgoingMessage {
  const markup = renderKeyboard(message.keyboard, context, book);
  const media = mediaOf(message);
  const rich = message.rich;
  const kind: RenderedKind = media ? media.kind : rich ? 'rich' : 'text';
  const bodyText = media ? message.caption : message.text;
  const html = bodyText === undefined ? undefined : htmlOf(bodyText);
  const linkPreview = message.linkPreview;
  return {
    key,
    kind,
    html,
    rich,
    linkPreview,
    media: media?.source,
    markup,
    fingerprint: {
      content: argumentsDigest({ html, rich, linkPreview }),
      media: argumentsDigest({ kind, source: media?.source }),
      markup: argumentsDigest({ markup }),
    },
  };
}

export function renderView(view: ScreenViewResult, context: RenderContext): RenderedView {
  const messages: readonly ViewMessage[] = Array.isArray(view) ? view : [view];
  if (messages.length === 0) {
    throw new Error(
      `[stitchkit] telegram screens: "${context.resolver.path}" rendered no messages.`,
    );
  }
  if (messages.length > RECORD_LIMITS.messages) {
    throw new Error(
      `[stitchkit] telegram screens: "${context.resolver.path}" renders ${messages.length} messages; a view holds ${RECORD_LIMITS.messages}.`,
    );
  }
  const book = new TokenBook(context.prefix, context.resolver.path);
  const keys = new Set<string>();
  const rendered = messages.map((message, index) => {
    const key = message.key ?? (index === messages.length - 1 ? 'main' : `s${index}`);
    if (key.length === 0 || key.length > RECORD_LIMITS.key) {
      throw new Error(
        `[stitchkit] telegram screens: "${context.resolver.path}" renders a message key of ${key.length} characters; a key has 1 to ${RECORD_LIMITS.key}.`,
      );
    }
    if (keys.has(key)) {
      throw new Error(
        `[stitchkit] telegram screens: "${context.resolver.path}" renders two messages with key "${key}".`,
      );
    }
    keys.add(key);
    return renderMessage(message, key, context, book);
  });
  return { messages: rendered, tokens: book.tokens };
}

/**
 * A link for a message the screens do not own — a notification. It carries
 * its whole address, because no view record will hold a token for it, and it
 * opens its screen below rather than changing the message it sits on.
 */
export function renderDetachedButton(
  button: ScreenButton,
  prefix: string,
  addressOf: ButtonResolver['addressOf'],
): InlineKeyboardButton.CallbackButton {
  const { target } = button;
  if (target.kind !== 'link') {
    throw new Error('[stitchkit] telegram screens: only a link can be used outside a screen.');
  }
  const address = addressOf(target.screen);
  const data =
    prefix +
    encodeCallback({
      screen: address.id,
      params: paramValues(address.params, target.params, target.screen.path),
      detached: true,
    });
  if (utf8Length(data) > CALLBACK_DATA_LIMIT) {
    throw new Error(
      `[stitchkit] telegram screens: a link to "${target.screen.path}" outside a screen needs ${utf8Length(data)} bytes; Telegram allows ${CALLBACK_DATA_LIMIT}.`,
    );
  }
  return labelled(button.label, data);
}
