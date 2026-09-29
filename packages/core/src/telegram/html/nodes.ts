/**
 * Telegram's HTML parse mode as a tree, and the rules that tree obeys.
 *
 * Telegram accepts a small, fixed subset of HTML and refuses the whole message
 * over one tag outside it, one bare `<` or one entity nested where it may not
 * be. Every bot that sends text written by someone else — a model, an editor,
 * an owner's greeting — has to turn arbitrary markup into that subset, and every
 * bot that sends a long text has to cut it without cutting a tag in half. Both
 * are answered once here, on a tree: markup is parsed into nodes that can only
 * express what Telegram accepts, and everything else — cleaning, cutting,
 * measuring, previewing — is a walk over those nodes.
 *
 * The nesting rules are Telegram's (Bot API, "Formatting options"): bold,
 * italic, underline, strikethrough and spoiler may contain and be contained by
 * anything except `pre` and `code`; a block quotation is never inside another;
 * all other entities never contain each other.
 */

/** Text formatting that nests freely, except inside `pre` and `code`. */
export type TelegramHtmlStyle = 'b' | 'i' | 'u' | 's' | 'tg-spoiler';

export interface TelegramHtmlTextNode {
  readonly kind: 'text';
  /** The text as a reader sees it — entities decoded, nothing escaped. */
  readonly text: string;
}

interface ElementBase {
  readonly kind: 'element';
  readonly children: readonly TelegramHtmlNode[];
}

export type TelegramHtmlElement =
  | (ElementBase & { readonly tag: TelegramHtmlStyle | 'code' })
  | (ElementBase & { readonly tag: 'a'; readonly href: string })
  | (ElementBase & { readonly tag: 'pre'; readonly language?: string })
  | (ElementBase & { readonly tag: 'blockquote'; readonly expandable: boolean })
  | (ElementBase & { readonly tag: 'tg-emoji'; readonly emojiId: string })
  | (ElementBase & {
      readonly tag: 'tg-time';
      readonly unix: number;
      readonly format?: string;
    });

export type TelegramHtmlNode = TelegramHtmlTextNode | TelegramHtmlElement;

export type TelegramHtmlTag = TelegramHtmlElement['tag'];

/** Telegram's limit for a message's text, after its markup is parsed. */
export const TELEGRAM_TEXT_LIMIT = 4_096;
/** Telegram's limit for a media caption, after its markup is parsed. */
export const TELEGRAM_CAPTION_LIMIT = 1_024;

const STYLES: ReadonlySet<string> = new Set<TelegramHtmlStyle>([
  'b',
  'i',
  'u',
  's',
  'tg-spoiler',
]);

export function isStyle(tag: string): tag is TelegramHtmlStyle {
  return STYLES.has(tag);
}

/** Holds only text: no element of any kind inside. */
export function holdsOnlyText(tag: TelegramHtmlTag): boolean {
  return tag === 'code' || tag === 'pre' || tag === 'tg-emoji' || tag === 'tg-time';
}

/** Rendered whole or not at all: its text is one thing, never cut. */
export function isAtomic(tag: TelegramHtmlTag): boolean {
  return tag === 'tg-emoji' || tag === 'tg-time';
}

/**
 * Whether an element of `tag` may open inside `ancestors` (outermost first).
 * A style is refused only under an element that holds text alone; any other
 * element is refused under any element that is not a style.
 */
export function mayOpenInside(
  tag: TelegramHtmlTag,
  ancestors: readonly TelegramHtmlTag[],
): boolean {
  if (isStyle(tag)) return !ancestors.some(holdsOnlyText);
  return ancestors.every(isStyle);
}

/** The visible text of nodes: what Telegram counts against its limits. */
export function textOf(nodes: readonly TelegramHtmlNode[]): string {
  let text = '';
  for (const node of nodes) text += node.kind === 'text' ? node.text : textOf(node.children);
  return text;
}

/** The same element holding other children. */
export function withChildren(
  element: TelegramHtmlElement,
  children: readonly TelegramHtmlNode[],
): TelegramHtmlElement {
  return { ...element, children };
}
