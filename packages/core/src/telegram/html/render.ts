/**
 * The tree back to markup, and the operations that go through the tree:
 * cleaning, cutting to Telegram's limits, measuring.
 *
 * Telegram's limits count the text after the markup is parsed — 4096 for a
 * message, 1024 for a caption — so a long text is cut by what the reader
 * sees, never by the length of its tags. A cut prefers a paragraph break, then
 * a line break, then a space, then any place that does not split a character
 * or a custom emoji; every element open across the cut is closed in one part
 * and opened again, with its attributes, in the next. Length is counted in
 * UTF-16 code units, the unit of Telegram's entity offsets: a text within the
 * limit by this count is within it however Telegram counts.
 */

import {
  isAtomic,
  TELEGRAM_TEXT_LIMIT,
  type TelegramHtmlElement,
  type TelegramHtmlNode,
  textOf,
  withChildren,
} from './nodes';
import { parseTelegramHtml } from './parse';

/** `&`, `<` and `>` as Telegram's HTML requires them, and `"` for attributes. */
export function escapeTelegramHtml(text: string): string {
  return text
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;');
}

function openingTag(element: TelegramHtmlElement): string {
  switch (element.tag) {
    case 'a':
      return `<a href="${escapeTelegramHtml(element.href)}">`;
    case 'pre':
      return element.language === undefined
        ? '<pre>'
        : `<pre><code class="language-${escapeTelegramHtml(element.language)}">`;
    case 'blockquote':
      return element.expandable ? '<blockquote expandable>' : '<blockquote>';
    case 'tg-emoji':
      return `<tg-emoji emoji-id="${element.emojiId}">`;
    case 'tg-time':
      return element.format === undefined
        ? `<tg-time unix="${element.unix}">`
        : `<tg-time unix="${element.unix}" format="${element.format}">`;
    default:
      return `<${element.tag}>`;
  }
}

function closingTag(element: TelegramHtmlElement): string {
  if (element.tag === 'pre' && element.language !== undefined) return '</code></pre>';
  return `</${element.tag}>`;
}

/** The markup Telegram parses back into exactly these nodes. */
export function renderTelegramHtml(nodes: readonly TelegramHtmlNode[]): string {
  let markup = '';
  for (const node of nodes) {
    markup +=
      node.kind === 'text'
        ? escapeTelegramHtml(node.text)
        : openingTag(node) + renderTelegramHtml(node.children) + closingTag(node);
  }
  return markup;
}

/** Any markup as markup Telegram accepts: its tags, its nesting, its escaping. */
export function sanitizeTelegramHtml(markup: string): string {
  return renderTelegramHtml(parseTelegramHtml(markup));
}

/** What the reader sees: the text of the markup, entities decoded. */
export function telegramHtmlText(markup: string): string {
  return textOf(parseTelegramHtml(markup));
}

/** The nodes whose visible text lies in `[from, to)`, elements across the edges kept on both sides. */
function slice(
  nodes: readonly TelegramHtmlNode[],
  from: number,
  to: number,
  start = 0,
): TelegramHtmlNode[] {
  const result: TelegramHtmlNode[] = [];
  let offset = start;
  for (const node of nodes) {
    const length = node.kind === 'text' ? node.text.length : textOf(node.children).length;
    const end = offset + length;
    if (end > from && offset < to) {
      if (node.kind === 'text') {
        result.push({
          kind: 'text',
          text: node.text.slice(Math.max(0, from - offset), to - offset),
        });
      } else if (isAtomic(node.tag)) {
        if (offset >= from) result.push(node);
      } else {
        const children = slice(node.children, from, to, offset);
        if (children.length > 0) result.push(withChildren(node, children));
      }
    }
    offset = end;
  }
  return result;
}

/** Visible offsets strictly inside a custom emoji or a time — never a place to cut. */
function atomicRanges(nodes: readonly TelegramHtmlNode[], start = 0): [number, number][] {
  const ranges: [number, number][] = [];
  let offset = start;
  for (const node of nodes) {
    const length = node.kind === 'text' ? node.text.length : textOf(node.children).length;
    if (node.kind === 'element') {
      if (isAtomic(node.tag)) ranges.push([offset, offset + length]);
      else ranges.push(...atomicRanges(node.children, offset));
    }
    offset += length;
  }
  return ranges;
}

interface Cut {
  /** The part ends here. */
  readonly end: number;
  /** The next part starts here: the break the cut was made at is dropped. */
  readonly next: number;
}

/**
 * Where a part ends. `structural` prefers a paragraph, then a line — the
 * shape a reader expects of a split, whatever it costs in length; without it
 * the last space is enough, since a truncation keeps only this part.
 */
function cutWithin(
  text: string,
  from: number,
  limit: number,
  atomic: readonly [number, number][],
  structural: boolean,
): Cut {
  const last = from + limit;
  const allowed = (index: number): boolean => {
    const code = text.charCodeAt(index - 1);
    if (code >= 0xd800 && code <= 0xdbff) return false;
    return !atomic.some(([start, end]) => index > start && index < end);
  };
  const find = (matches: (index: number) => number): Cut | undefined => {
    for (let index = last; index > from; index -= 1) {
      const skip = matches(index);
      if (skip >= 0 && allowed(index)) return { end: index, next: index + skip };
    }
    return undefined;
  };
  const paragraph = () => find((index) => (text.startsWith('\n\n', index) ? 2 : -1));
  const line = () => find((index) => (text[index] === '\n' ? 1 : -1));
  return (
    (structural ? (paragraph() ?? line()) : undefined) ??
    find((index) => (/\s/.test(text[index] ?? '') ? 1 : -1)) ??
    find(() => 0) ?? { end: last, next: last }
  );
}

function checkedLimit(limit: number): number {
  if (!Number.isSafeInteger(limit) || limit < 2) {
    throw new RangeError('[stitchkit] telegram html: a limit is an integer of at least 2');
  }
  return limit;
}

export interface TelegramHtmlLimitOptions {
  /** Visible characters per part. Default 4096 — a message; 1024 for a caption. */
  readonly limit?: number;
}

/**
 * Cut markup into parts Telegram accepts one by one, each within `limit`
 * visible characters and each valid on its own. Markup that fits is one part;
 * text with nothing visible is no parts.
 */
export function splitTelegramHtml(
  markup: string,
  options: TelegramHtmlLimitOptions = {},
): string[] {
  const limit = checkedLimit(options.limit ?? TELEGRAM_TEXT_LIMIT);
  const nodes = parseTelegramHtml(markup);
  const text = textOf(nodes);
  const atomic = atomicRanges(nodes);
  const parts: string[] = [];
  let from = 0;
  while (from < text.length) {
    const cut =
      text.length - from <= limit
        ? { end: text.length, next: text.length }
        : cutWithin(text, from, limit, atomic, true);
    if (text.slice(from, cut.end).trim() !== '') {
      parts.push(renderTelegramHtml(slice(nodes, from, cut.end)));
    }
    from = cut.next;
  }
  return parts;
}

export interface TelegramHtmlTruncateOptions extends TelegramHtmlLimitOptions {
  /** Appended when text was cut. Default `…`. */
  readonly ellipsis?: string;
}

/** Markup cut to `limit` visible characters, the ellipsis included, still valid. */
export function truncateTelegramHtml(
  markup: string,
  options: TelegramHtmlTruncateOptions = {},
): string {
  const limit = checkedLimit(options.limit ?? TELEGRAM_TEXT_LIMIT);
  const ellipsis = options.ellipsis ?? '…';
  const nodes = parseTelegramHtml(markup);
  const text = textOf(nodes);
  if (text.length <= limit) return renderTelegramHtml(nodes);
  const room = limit - ellipsis.length;
  if (room < 1) throw new RangeError('[stitchkit] telegram html: the ellipsis leaves no room');
  const { end } = cutWithin(text, 0, room, atomicRanges(nodes), false);
  const kept = slice(nodes, 0, end);
  return renderTelegramHtml(kept).trimEnd() + escapeTelegramHtml(ellipsis);
}
