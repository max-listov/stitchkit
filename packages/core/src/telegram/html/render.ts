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

/**
 * The visible end of each node of a list, from the list's start, measured once per tree: a
 * text of many parts is sliced many times, and each slice finds its first node by these ends
 * instead of walking — and measuring — every node before it.
 */
type Ends = (nodes: readonly TelegramHtmlNode[]) => readonly number[];

function measureEnds(): Ends {
  const known = new WeakMap<readonly TelegramHtmlNode[], number[]>();
  const ends: Ends = (nodes) => {
    const cached = known.get(nodes);
    if (cached) return cached;
    const measured: number[] = [];
    let offset = 0;
    for (const node of nodes) {
      offset += node.kind === 'text' ? node.text.length : (ends(node.children).at(-1) ?? 0);
      measured.push(offset);
    }
    known.set(nodes, measured);
    return measured;
  };
  return ends;
}

/** The first index whose end is past `from`: the nodes before it lie wholly before the slice. */
function firstPast(ends: readonly number[], from: number): number {
  let low = 0;
  let high = ends.length;
  while (low < high) {
    const middle = (low + high) >>> 1;
    if ((ends[middle] ?? 0) > from) high = middle;
    else low = middle + 1;
  }
  return low;
}

/** The nodes whose visible text lies in `[from, to)`, elements across the edges kept on both sides. */
function slice(
  nodes: readonly TelegramHtmlNode[],
  from: number,
  to: number,
  ends: Ends,
  start = 0,
): TelegramHtmlNode[] {
  const result: TelegramHtmlNode[] = [];
  const nodeEnds = ends(nodes);
  for (let index = firstPast(nodeEnds, from - start); index < nodes.length; index += 1) {
    const node = nodes[index];
    const offset = start + (nodeEnds[index - 1] ?? 0);
    if (node === undefined || offset >= to) break;
    if (node.kind === 'text') {
      result.push({
        kind: 'text',
        text: node.text.slice(Math.max(0, from - offset), to - offset),
      });
    } else if (isAtomic(node.tag)) {
      if (offset >= from) result.push(node);
    } else {
      const children = slice(node.children, from, to, ends, offset);
      if (children.length > 0) result.push(withChildren(node, children));
    }
  }
  return result;
}

/** A custom emoji or a time starts here: a place to cut before, never one to drop. */
const ATOM_START = 2;
/** Strictly inside one: never a place to cut. */
const ATOM_INSIDE = 1;

/** Marks where each custom emoji or time starts, and the visible offsets strictly inside it. */
function atomicInside(
  nodes: readonly TelegramHtmlNode[],
  ends: Ends,
  inside = new Uint8Array(textOf(nodes).length + 1),
  start = 0,
): Uint8Array {
  const nodeEnds = ends(nodes);
  for (const [index, node] of nodes.entries()) {
    if (node.kind !== 'element') continue;
    const offset = start + (nodeEnds[index - 1] ?? 0);
    if (!isAtomic(node.tag)) atomicInside(node.children, ends, inside, offset);
    else {
      inside[offset] = ATOM_START;
      inside.fill(ATOM_INSIDE, offset + 1, start + (nodeEnds[index] ?? 0));
    }
  }
  return inside;
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
  atomic: Uint8Array,
  structural: boolean,
): Cut {
  const last = from + limit;
  const allowed = (index: number): boolean => {
    const code = text.charCodeAt(index - 1);
    if (code >= 0xd800 && code <= 0xdbff) return false;
    return atomic[index] !== ATOM_INSIDE;
  };
  // The break a cut drops — a space, a line, a paragraph — must be text of its own: a break that
  // is an atom's first character would drop the atom with it, and the next part would start
  // inside it. (An end inside an atom is already refused by `allowed`.)
  const dropsNoAtom = (index: number, skip: number): boolean => {
    for (let at = index; at < index + skip; at += 1) if (atomic[at] !== 0) return false;
    return true;
  };
  const find = (matches: (index: number) => number): Cut | undefined => {
    for (let index = last; index > from; index -= 1) {
      const skip = matches(index);
      if (skip >= 0 && allowed(index) && dropsNoAtom(index, skip))
        return { end: index, next: index + skip };
    }
    return undefined;
  };
  const paragraph = () => find((index) => (text.startsWith('\n\n', index) ? 2 : -1));
  const line = () => find((index) => (text[index] === '\n' ? 1 : -1));
  return (
    (structural ? (paragraph() ?? line()) : undefined) ??
    find((index) => (/\s/.test(text[index] ?? '') ? 1 : -1)) ??
    find(() => 0) ??
    beforeAtom(atomic, last)
  );
}

/**
 * No place in the window may be cut: an atom covers its end. The cut goes before the atom, which
 * starts the next part; one that starts the window is longer than the limit (`end` stays `from`).
 */
function beforeAtom(atomic: Uint8Array, last: number): Cut {
  let start = last;
  while (atomic[start] === ATOM_INSIDE) start -= 1;
  return { end: start, next: start };
}

/** A part whose visible text is blank still goes when an atom starts in it: nothing is dropped. */
function holdsAtom(atomic: Uint8Array, from: number, end: number): boolean {
  for (let at = from; at < end; at += 1) if (atomic[at] === ATOM_START) return true;
  return false;
}

const ATOM_OVER_LIMIT =
  '[stitchkit] telegram html: a custom emoji or a time is longer than the limit and cannot be cut';

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
  const ends = measureEnds();
  const atomic = atomicInside(nodes, ends);
  const parts: string[] = [];
  let from = 0;
  while (from < text.length) {
    const cut =
      text.length - from <= limit
        ? { end: text.length, next: text.length }
        : cutWithin(text, from, limit, atomic, true);
    if (cut.next <= from) throw new RangeError(ATOM_OVER_LIMIT);
    if (text.slice(from, cut.end).trim() !== '' || holdsAtom(atomic, from, cut.end)) {
      parts.push(renderTelegramHtml(slice(nodes, from, cut.end, ends)));
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
  const ends = measureEnds();
  const { end } = cutWithin(text, 0, room, atomicInside(nodes, ends), false);
  const kept = slice(nodes, 0, end, ends);
  return renderTelegramHtml(kept).trimEnd() + escapeTelegramHtml(ellipsis);
}
