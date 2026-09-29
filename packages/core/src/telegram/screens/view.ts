/**
 * What a screen shows: messages as plain objects.
 *
 * A view is data, so it can be compared. `{ text }` is a text message,
 * `{ rich }` a Bot API rich message (Markdown, HTML or blocks, without file
 * uploads) and `{ photo }` (or `video`, `animation`, `document`, `audio`) a
 * media message with an optional caption; exactly one of those keys is
 * present, and the type says so. A keyboard is rows of buttons where a row or a button may be `false`,
 * `null` or `undefined` — a conditional row is written in the literal, not
 * around it. Buttons are either screen buttons (`link`, `back`, an action) or
 * any Telegram inline button that carries no `callback_data`, as Telegram
 * spells it.
 */
import type { InlineKeyboardButton, InputRichMessageWithoutUpload } from 'grammy/types';
import type { ActionValue } from './callback-codec';
import type { TelegramText } from './html';
import type { AnyTelegramScreen, ScreenLinkArgs } from './screen-types';

export type ScreenMediaKind = 'photo' | 'video' | 'animation' | 'document' | 'audio';
export const SCREEN_MEDIA_KINDS: readonly ScreenMediaKind[] = [
  'photo',
  'video',
  'animation',
  'document',
  'audio',
];

/** A button label: its text, or its text with Telegram's style and custom-emoji icon. */
export type ButtonLabel = string | Omit<InlineKeyboardButton.CallbackButton, 'callback_data'>;

type ButtonTarget =
  | {
      readonly kind: 'link';
      readonly screen: AnyTelegramScreen;
      readonly params: Readonly<Record<string, ActionValue>>;
    }
  | { readonly kind: 'back' }
  | {
      readonly kind: 'action';
      readonly screen: AnyTelegramScreen;
      readonly params: Readonly<Record<string, ActionValue>>;
      readonly action: string;
      readonly input: Readonly<Record<string, ActionValue | undefined>> | undefined;
    };

/** A button the screens runtime answers: it becomes `callback_data` when rendered. */
export class ScreenButton {
  constructor(
    readonly label: ButtonLabel,
    readonly target: ButtonTarget,
  ) {}
}

/** Any inline button Telegram answers itself — a URL, a Mini App, copy text, … */
export type PlainKeyboardButton = Exclude<
  InlineKeyboardButton,
  InlineKeyboardButton.CallbackButton
>;

export type KeyboardButton = ScreenButton | PlainKeyboardButton;
type Absent = false | null | undefined;
export type KeyboardRow = readonly (KeyboardButton | Absent)[];
export type Keyboard = readonly (KeyboardRow | Absent)[];

interface ViewMessageCommon {
  /**
   * The message's identity across renders: two renders put the same key in the
   * same Telegram message when they can. The default is `'main'` for the last
   * message and `'s0'`, `'s1'`, … for those above it, so the message that
   * carries a screen's buttons is the one the next screen edits.
   */
  readonly key?: string;
  readonly keyboard?: Keyboard;
}

type ContentKey = 'text' | 'rich' | ScreenMediaKind;
type Without<TKeys extends string> = { readonly [K in TKeys]?: never };

export interface TextViewMessage
  extends ViewMessageCommon,
    Without<Exclude<ContentKey, 'text'> | 'caption'> {
  readonly text: TelegramText;
  /** `false` hides the preview of the first link. Default: Telegram's. */
  readonly linkPreview?: boolean;
}

export interface RichViewMessage
  extends ViewMessageCommon,
    Without<Exclude<ContentKey, 'rich'> | 'caption' | 'linkPreview'> {
  /** A rich message as the Bot API takes it; files by `file_id` or URL only. */
  readonly rich: InputRichMessageWithoutUpload;
}

type MediaViewMessageOf<TKind extends ScreenMediaKind> = ViewMessageCommon &
  Without<Exclude<ContentKey, TKind> | 'linkPreview'> & {
    /** A Telegram `file_id` or an HTTP URL Telegram can fetch. */
    readonly [K in TKind]: string;
  } & { readonly caption?: TelegramText };

export type PhotoViewMessage = MediaViewMessageOf<'photo'>;
export type VideoViewMessage = MediaViewMessageOf<'video'>;
export type AnimationViewMessage = MediaViewMessageOf<'animation'>;
export type DocumentViewMessage = MediaViewMessageOf<'document'>;
export type AudioViewMessage = MediaViewMessageOf<'audio'>;

export type ViewMessage =
  | TextViewMessage
  | RichViewMessage
  | PhotoViewMessage
  | VideoViewMessage
  | AnimationViewMessage
  | DocumentViewMessage
  | AudioViewMessage;

/** What `view` returns: one message, or several shown top to bottom. */
export type ScreenViewResult = ViewMessage | readonly ViewMessage[];

/** A link to another screen; its params are required exactly when its path has any. */
export function link<TScreen extends AnyTelegramScreen>(
  label: ButtonLabel,
  screen: TScreen,
  ...params: ScreenLinkArgs<TScreen>
): ScreenButton {
  const [values] = params;
  return new ScreenButton(label, { kind: 'link', screen, params: values ?? {} });
}

/** A link to the parent screen — the nearest declared screen above this path. */
export function back(label: ButtonLabel): ScreenButton {
  return new ScreenButton(label, { kind: 'back' });
}
