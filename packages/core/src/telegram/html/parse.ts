/**
 * Markup in, a tree Telegram accepts out — whatever the markup was.
 *
 * The parser is lenient on purpose: its input is text someone else wrote, and
 * the only useful answer to a tag Telegram does not know is to keep the words
 * and lose the tag. Synonyms become Telegram's tags (`strong` → `b`), block
 * tags (`p`, `div`, `li`, `br`, headings) become line breaks, a link keeps only
 * an `href` with a scheme Telegram opens, an element opened where Telegram
 * forbids it stays text, and a closing tag closes the element it names along
 * with whatever was left open inside it. No DOM and nothing executed, so the
 * same parse serves a server and a browser preview.
 */

import {
  isStyle,
  mayOpenInside,
  type TelegramHtmlElement,
  type TelegramHtmlNode,
  type TelegramHtmlTextNode,
} from './nodes';

const TAG = /<(\/?)([a-zA-Z][a-zA-Z0-9-]*)((?:\s[^<>]*?)?)\s*\/?>/y;
const ATTRIBUTE =
  /([a-zA-Z_:][-a-zA-Z0-9_:.]*)(?:\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'=<>`]+)))?/g;
const ENTITY = /&(?:(amp|lt|gt|quot|apos|nbsp)|#(\d{1,7})|#[xX]([0-9a-fA-F]{1,6}));/y;

const NAMED: Readonly<Record<string, string>> = {
  amp: '&',
  lt: '<',
  gt: '>',
  quot: '"',
  apos: "'",
  nbsp: ' ',
};

/** Tags written another way; `span` becomes a spoiler only by its class. */
const SYNONYMS: Readonly<Record<string, string>> = {
  strong: 'b',
  em: 'i',
  ins: 'u',
  strike: 's',
  del: 's',
};

/** Block tags → the line breaks they stand for: a paragraph is two, a line one. */
const BLOCK_BREAKS: Readonly<Record<string, number>> = {
  p: 2,
  h1: 2,
  h2: 2,
  h3: 2,
  h4: 2,
  h5: 2,
  h6: 2,
  div: 1,
  li: 1,
  ul: 1,
  ol: 1,
  tr: 1,
  table: 1,
  section: 1,
  article: 1,
  header: 1,
  footer: 1,
};

const LINK_SCHEMES = new Set(['http:', 'https:', 'tg:', 'mailto:']);
const TIME_FORMAT = /^(?:r|w?[dD]?[tT]?)$/;

export type Token =
  | { readonly type: 'text'; readonly text: string }
  | {
      readonly type: 'entity';
      readonly text: string;
      readonly named: boolean;
      readonly telegram: boolean;
    }
  | { readonly type: 'bare'; readonly char: string }
  | {
      readonly type: 'tag';
      readonly closing: boolean;
      readonly name: string;
      readonly attributes: ReadonlyMap<string, string>;
    };

function decodeEntity(match: RegExpExecArray): string | undefined {
  const [, named, decimal, hex] = match;
  if (named !== undefined) return NAMED[named];
  const code = Number.parseInt(decimal ?? hex ?? '', decimal === undefined ? 16 : 10);
  const valid = code > 0 && code <= 0x10ffff && (code < 0xd800 || code > 0xdfff);
  return valid ? String.fromCodePoint(code) : undefined;
}

function attributesOf(source: string): Map<string, string> {
  const attributes = new Map<string, string>();
  for (const [, name = '', double, single, bare] of source.matchAll(ATTRIBUTE)) {
    attributes.set(name.toLowerCase(), decodeText(double ?? single ?? bare ?? ''));
  }
  return attributes;
}

/** Markup as tokens: tags, entities, runs of text, and the bare `<`, `>`, `&` Telegram refuses. */
export function* tokenize(markup: string): Generator<Token> {
  let index = 0;
  let textStart = 0;
  const flush = function* (): Generator<Token> {
    if (index > textStart) yield { type: 'text', text: markup.slice(textStart, index) };
  };
  while (index < markup.length) {
    const char = markup[index];
    if (char === '<') {
      TAG.lastIndex = index;
      const tag = TAG.exec(markup);
      yield* flush();
      if (tag) {
        yield {
          type: 'tag',
          closing: tag[1] === '/',
          name: (tag[2] ?? '').toLowerCase(),
          attributes: attributesOf(tag[3] ?? ''),
        };
        index = TAG.lastIndex;
      } else {
        yield { type: 'bare', char };
        index += 1;
      }
      textStart = index;
    } else if (char === '&') {
      ENTITY.lastIndex = index;
      const entity = ENTITY.exec(markup);
      const text = entity ? decodeEntity(entity) : undefined;
      yield* flush();
      if (entity && text !== undefined) {
        const named = entity[1];
        yield {
          type: 'entity',
          text,
          named: named !== undefined,
          telegram: named !== 'apos' && named !== 'nbsp',
        };
        index = ENTITY.lastIndex;
      } else {
        yield { type: 'bare', char };
        index += 1;
      }
      textStart = index;
    } else if (char === '>') {
      yield* flush();
      yield { type: 'bare', char };
      index += 1;
      textStart = index;
    } else {
      index += 1;
    }
  }
  yield* flush();
}

/** Markup's text with its entities decoded and its tags kept as written. */
function decodeText(value: string): string {
  let text = '';
  for (const token of tokenize(value)) {
    if (token.type === 'text' || token.type === 'entity') text += token.text;
    else if (token.type === 'bare') text += token.char;
  }
  return text;
}

/** An element under construction: its attributes, and children still being appended. */
interface DraftElement {
  readonly kind: 'element';
  element: TelegramHtmlElement;
  readonly children: DraftNode[];
}

type DraftNode = TelegramHtmlTextNode | DraftElement;

interface Frame {
  /** The tag name a closing tag matches, as written after synonyms. */
  readonly name: string;
  /** The element this frame builds; `undefined` for a tag whose words stay but whose tag does not. */
  readonly draft: DraftElement | undefined;
}

const KNOWN = new Set([
  'b',
  'i',
  'u',
  's',
  'tg-spoiler',
  'code',
  'a',
  'pre',
  'blockquote',
  'tg-emoji',
  'tg-time',
  'span',
]);

function linkOf(href: string | undefined): string | undefined {
  const value = href?.trim();
  if (!value || !URL.canParse(value)) return undefined;
  return LINK_SCHEMES.has(new URL(value).protocol) ? value : undefined;
}

/** The element a tag opens, before the nesting rules; `undefined` when it stays text. */
function elementFor(
  tag: string,
  attributes: ReadonlyMap<string, string>,
): TelegramHtmlElement | undefined {
  const children: readonly TelegramHtmlNode[] = [];
  if (isStyle(tag) || tag === 'code') return { kind: 'element', tag, children };
  if (tag === 'span') {
    const spoiler = (attributes.get('class') ?? '').split(/\s+/).includes('tg-spoiler');
    return spoiler ? { kind: 'element', tag: 'tg-spoiler', children } : undefined;
  }
  if (tag === 'a') {
    const href = linkOf(attributes.get('href'));
    return href === undefined ? undefined : { kind: 'element', tag, href, children };
  }
  if (tag === 'pre') return { kind: 'element', tag, children };
  if (tag === 'blockquote') {
    return { kind: 'element', tag, expandable: attributes.has('expandable'), children };
  }
  if (tag === 'tg-emoji') {
    const emojiId = attributes.get('emoji-id') ?? '';
    return /^\d{1,32}$/.test(emojiId)
      ? { kind: 'element', tag, emojiId, children }
      : undefined;
  }
  if (tag === 'tg-time') {
    const unix = attributes.get('unix') ?? '';
    const format = attributes.get('format');
    if (!/^\d{1,12}$/.test(unix)) return undefined;
    return {
      kind: 'element',
      tag,
      unix: Number(unix),
      ...(format !== undefined && TIME_FORMAT.test(format) && { format }),
      children,
    };
  }
  return undefined;
}

class TreeBuilder {
  readonly root: DraftNode[] = [];
  readonly #frames: Frame[] = [];
  /** Line breaks the text so far ends with, and how many the next text needs before it. */
  #trailing = 0;
  #needed = 0;
  #started = false;

  #innermost(): DraftElement | undefined {
    for (let index = this.#frames.length - 1; index >= 0; index -= 1) {
      const draft = this.#frames[index]?.draft;
      if (draft) return draft;
    }
    return undefined;
  }

  text(value: string): void {
    if (value === '') return;
    this.#append(this.#pendingBreaks() + value);
    this.#started = true;
  }

  /** The line breaks block tags asked for, due now that more content follows. */
  #pendingBreaks(): string {
    const breaks = this.#started
      ? '\n'.repeat(Math.max(0, this.#needed - this.#trailing))
      : '';
    this.#needed = 0;
    return breaks;
  }

  #append(text: string): void {
    if (text === '') return;
    const trailing = /\n*$/.exec(text)?.[0].length ?? 0;
    this.#trailing = trailing === text.length ? this.#trailing + trailing : trailing;
    const children = this.#innermost()?.children ?? this.root;
    const last = children.at(-1);
    if (last?.kind === 'text')
      children[children.length - 1] = { kind: 'text', text: last.text + text };
    else children.push({ kind: 'text', text });
  }

  /** `cumulative` — each tag adds a line (`br`); otherwise the text is only ensured that many. */
  lineBreaks(count: number, cumulative: boolean): void {
    this.#needed = cumulative
      ? Math.max(this.#needed, this.#trailing) + count
      : Math.max(this.#needed, count);
  }

  openTag(name: string, attributes: ReadonlyMap<string, string>): void {
    const tag = SYNONYMS[name] ?? name;
    if (!KNOWN.has(tag)) return;
    const parent = this.#innermost();
    if (tag === 'code' && parent?.element.tag === 'pre') {
      // `<pre><code class="language-x">` names the block's language; the code tag adds nothing.
      const language = /(?:^|\s)language-([\w+#.-]{1,64})(?:\s|$)/.exec(
        attributes.get('class') ?? '',
      );
      if (language?.[1] && parent.element.language === undefined) {
        parent.element = { ...parent.element, language: language[1] };
      }
      this.#frames.push({ name: tag, draft: undefined });
      return;
    }
    const element = elementFor(tag, attributes);
    const open = this.#frames.flatMap((frame) =>
      frame.draft ? [frame.draft.element.tag] : [],
    );
    if (!element || !mayOpenInside(element.tag, open)) {
      this.#frames.push({ name: tag, draft: undefined });
      return;
    }
    // Breaks owed before the element go before its tag, not inside it.
    this.#append(this.#pendingBreaks());
    const draft: DraftElement = { kind: 'element', element, children: [] };
    (parent?.children ?? this.root).push(draft);
    this.#frames.push({ name: tag, draft });
  }

  /** Closes the element the tag names and whatever is still open inside it; a stray close is ignored. */
  closeTag(name: string): void {
    const tag = SYNONYMS[name] ?? name;
    for (let index = this.#frames.length - 1; index >= 0; index -= 1) {
      if (this.#frames[index]?.name === tag) {
        this.#frames.length = index;
        return;
      }
    }
  }
}

/**
 * The finished tree: adjacent text joined, and elements left with no text
 * dropped — they say nothing, and Telegram shows nothing for them either.
 */
function finish(nodes: readonly DraftNode[]): TelegramHtmlNode[] {
  const result: TelegramHtmlNode[] = [];
  for (const node of nodes) {
    if (node.kind === 'text') {
      const last = result.at(-1);
      if (last?.kind === 'text')
        result[result.length - 1] = { kind: 'text', text: last.text + node.text };
      else result.push(node);
      continue;
    }
    const children = finish(node.children);
    if (children.length > 0) result.push({ ...node.element, children });
  }
  return result;
}

/** Parse markup into the tree Telegram accepts. Never throws. */
export function parseTelegramHtml(markup: string): TelegramHtmlNode[] {
  const builder = new TreeBuilder();
  for (const token of tokenize(markup)) {
    if (token.type === 'text' || token.type === 'entity') builder.text(token.text);
    else if (token.type === 'bare') builder.text(token.char);
    else if (token.name === 'br') {
      if (!token.closing) builder.lineBreaks(1, true);
    } else if (BLOCK_BREAKS[token.name] !== undefined) {
      builder.lineBreaks(BLOCK_BREAKS[token.name] ?? 1, false);
    } else if (token.closing) builder.closeTag(token.name);
    else builder.openTag(token.name, token.attributes);
  }
  return finish(builder.root);
}
