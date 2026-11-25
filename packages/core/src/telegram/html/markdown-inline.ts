/**
 * Inline Markdown — emphasis, code spans, links, underline, entities — into
 * `TelegramHtmlNode[]`.
 *
 * Conversion is linear in the text. Every lookahead that could otherwise be
 * repeated from each opener is answered from one index built per text: code
 * span closers by backtick-run length, `<u>`/`</u>` and `[`/`]` pairs matched
 * on one stack. An opener that finds no closer once never searches again, and
 * a link destination nests at most `MAX_LINK_PARENS` parentheses, so a
 * destination scan that cannot close stops within that many later openers.
 * Nesting is bounded by `MAX_INLINE_DEPTH`; deeper markup stays text.
 */

import {
  mayOpenInside,
  safeTelegramLinkHref,
  type TelegramHtmlNode,
  type TelegramHtmlStyle,
  type TelegramHtmlTag,
} from './nodes';

const MAX_INLINE_DEPTH = 32;
const MAX_LINK_PARENS = 32;
const ENTITY_AT = /&(?:(amp|lt|gt|quot)|#(\d{1,7})|#[xX]([0-9a-fA-F]{1,6}));/y;
const ENTITY_ALL = /&(?:(amp|lt|gt|quot)|#(\d{1,7})|#[xX]([0-9a-fA-F]{1,6}));/g;
const NAMED: Readonly<Record<string, string>> = { amp: '&', lt: '<', gt: '>', quot: '"' };
const WORD_END = /[\p{L}\p{N}_]$/u;
const WORD_START = /^[\p{L}\p{N}_]/u;
const ASCII_PUNCT = /^[!-/:-@[-`{-~]$/;
const ANGLE_URL = /<((?:\\.|[^<>\\])*)>/y;
const LINK_TAIL = /[ \t]*(?:(?:"(?:\\.|[^"\\])*"|'(?:\\.|[^'\\])*')[ \t]*)?\)/y;

const MARKER_MAP: Readonly<Record<string, readonly string[]>> = {
  '*': ['***', '**', '*'],
  _: ['___', '__', '_'],
  '~': ['~~'],
  '|': ['||'],
};

export const textNode = (text: string): TelegramHtmlNode => ({ kind: 'text', text });
const isSpace = (c?: string): boolean => c === ' ' || c === '\t' || c === '\n' || c === '\r';

function tagsFor(m: string): readonly TelegramHtmlStyle[] {
  if (m.length === 3) return ['b', 'i'];
  if (m === '~~') return ['s'];
  if (m === '||') return ['tg-spoiler'];
  return m.length === 2 ? ['b'] : ['i'];
}

function decodeEntity(n?: string, dec?: string, hex?: string): string | undefined {
  if (n !== undefined) return NAMED[n];
  const c = Number.parseInt(dec ?? hex ?? '', dec === undefined ? 16 : 10);
  const ok =
    c >= 0x20
      ? c <= 0xd7ff || (c >= 0xe000 && c <= 0xfffd) || (c >= 0x10000 && c <= 0x10ffff)
      : c === 9 || c === 10 || c === 13;
  return ok ? String.fromCodePoint(c) : undefined;
}

export const decodeEntities = (text: string): string =>
  text.replace(ENTITY_ALL, (raw, n, d, h) => decodeEntity(n, d, h) ?? raw);

/** Where the run of `char` that holds `at` begins: a run is one delimiter, judged at its edge. */
function runBegin(text: string, at: number, char: string): number {
  let start = at;
  while (start > 0 && text[start - 1] === char) start -= 1;
  return start;
}

/** Where the run of `char` from `at` ends. */
function runEnd(text: string, at: number, char: string): number {
  let end = at;
  while (text[end] === char) end += 1;
  return end;
}

function countRun(text: string, start: number, char: string): number {
  let end = start;
  while (text[end] === char) end += 1;
  return end - start;
}

/** Whether `text` holds `tag` (lowercase ASCII) at `at`, ignoring case. */
function tagAt(text: string, at: number, tag: string): boolean {
  for (let k = 0; k < tag.length; k += 1) {
    if ((text[at + k] ?? '').toLowerCase() !== tag[k]) return false;
  }
  return true;
}

/** Lookaheads of one text, computed once. */
interface InlineIndex {
  readonly text: string;
  /** Start of every maximal backtick run, ascending, by run length. */
  readonly runs: ReadonlyMap<number, readonly number[]>;
  /** `<u>` at a position → its `</u>`. */
  readonly underlineClose: ReadonlyMap<number, number>;
  /** `[` at a position → its `]`. */
  readonly bracketClose: ReadonlyMap<number, number>;
}

/** The first backtick run of exactly `ticks` starting at or after `from`, or `-1`. */
function codeSpanClose(index: InlineIndex, from: number, ticks: number): number {
  const starts = index.runs.get(ticks);
  if (starts === undefined) return -1;
  let low = 0;
  let high = starts.length;
  while (low < high) {
    const mid = (low + high) >> 1;
    if ((starts[mid] ?? 0) < from) low = mid + 1;
    else high = mid;
  }
  return starts[low] ?? -1;
}

function skipEscapedOrCode(index: InlineIndex, i: number): number {
  const { text } = index;
  if (text[i] === '\\' && i + 1 < text.length) return i + 2;
  if (text[i] !== '`') return i;
  const ticks = countRun(text, i, '`');
  const close = codeSpanClose(index, i + ticks, ticks);
  return close === -1 ? i + ticks : close + ticks;
}

function indexInline(text: string): InlineIndex {
  const runs = new Map<number, number[]>();
  for (let i = text.indexOf('`'); i !== -1; ) {
    const run = countRun(text, i, '`');
    const list = runs.get(run);
    if (list === undefined) runs.set(run, [i]);
    else list.push(i);
    i = text.indexOf('`', i + run);
  }
  const underlineClose = new Map<number, number>();
  const bracketClose = new Map<number, number>();
  const index: InlineIndex = { text, runs, underlineClose, bracketClose };
  const underlines: number[] = [];
  const brackets: number[] = [];
  for (let i = 0; i < text.length; ) {
    const next = skipEscapedOrCode(index, i);
    if (next !== i) {
      i = next;
      continue;
    }
    if (tagAt(text, i, '<u>')) {
      underlines.push(i);
      i += 3;
      continue;
    }
    if (tagAt(text, i, '</u>')) {
      const open = underlines.pop();
      if (open !== undefined) underlineClose.set(open, i);
      i += 4;
      continue;
    }
    if (text[i] === '[') brackets.push(i);
    else if (text[i] === ']') {
      const open = brackets.pop();
      if (open !== undefined) bracketClose.set(open, i);
    }
    i += 1;
  }
  return index;
}

interface ParsedLink {
  readonly label: string;
  readonly rawUrl: string;
  readonly end: number;
}

function parseLinkAt(index: InlineIndex, start: number): ParsedLink | undefined {
  const { text } = index;
  const close = index.bracketClose.get(start);
  if (close === undefined || text[close + 1] !== '(') return undefined;
  const label = text.slice(start + 1, close);
  let p = close + 2;
  while (text[p] === ' ' || text[p] === '\t') p += 1;
  let rawUrl = '';
  ANGLE_URL.lastIndex = p;
  const angle = ANGLE_URL.exec(text);
  if (angle !== null) {
    rawUrl = (angle[1] ?? '').replace(/\\([!-/:-@[-`{-~])/g, '$1');
    p = ANGLE_URL.lastIndex;
  } else {
    let parens = 0;
    for (; p < text.length; p += 1) {
      const ch = text[p] ?? '';
      if (ch === '\\' && ASCII_PUNCT.test(text[p + 1] ?? '')) {
        rawUrl += text[p + 1] ?? '';
        p += 1;
        continue;
      }
      if (ch === '(') {
        parens += 1;
        if (parens > MAX_LINK_PARENS) return undefined;
      } else if (ch === ')') {
        if (parens === 0) return { label, rawUrl, end: p + 1 };
        parens -= 1;
      } else if (ch === ' ' || ch === '\t') break;
      rawUrl += ch;
    }
    if (parens !== 0) return undefined;
  }
  LINK_TAIL.lastIndex = p;
  return LINK_TAIL.exec(text) === null
    ? undefined
    : { label, rawUrl, end: LINK_TAIL.lastIndex };
}

/**
 * Every delimiter keeps to word boundaries — the rule CommonMark gives `_`, here for `*`, `~~`
 * and `||` too: it opens only where no letter or digit stands before it and closes only where
 * none follows, so `a*b or c*d`, `2*3*4` and `snake_case` stay text.
 */
function findDelimiterClose(index: InlineIndex, start: number, marker: string): number {
  const { text } = index;
  const char = marker[0] ?? '';
  const len = marker.length;
  const canClose = (pos: number): boolean => {
    if (pos <= start || isSpace(text[pos - 1])) return false;
    const after = runEnd(text, pos + len, char);
    return !WORD_START.test(text.slice(after, after + 2));
  };
  let inDouble = false;
  let singles = 0;
  for (let i = start; i < text.length; ) {
    const next = skipEscapedOrCode(index, i);
    if (next !== i) i = next;
    else if (text[i] !== char) i += 1;
    else {
      const run = countRun(text, i, char);
      if (len === 1) {
        if (run === 2) inDouble = !inDouble;
        else if (run === 3 && inDouble) {
          inDouble = false;
          if (canClose(i + 2)) return i + 2;
        } else if (run === 1 && canClose(i)) return i;
      } else {
        if (run === 1) singles += 1;
        const pos = len === 2 && run === 3 && singles % 2 === 1 ? i + 1 : i;
        if (run >= len && canClose(pos)) return pos;
      }
      i += run;
    }
  }
  return -1;
}

export const wrapStyle = (
  tag: TelegramHtmlStyle,
  children: readonly TelegramHtmlNode[],
  anc: readonly TelegramHtmlTag[],
): TelegramHtmlNode[] =>
  children.length === 0
    ? []
    : anc.includes(tag) || !mayOpenInside(tag, anc)
      ? [...children]
      : [{ kind: 'element', tag, children }];

function append(target: TelegramHtmlNode[], nodes: readonly TelegramHtmlNode[]): void {
  for (const node of nodes) target.push(node);
}

/** Inline Markdown of one line (or one title) as nodes valid under `anc`. */
export function parseInline(
  text: string,
  anc: readonly TelegramHtmlTag[],
  depth = 0,
): TelegramHtmlNode[] {
  if (text === '') return [];
  if (depth >= MAX_INLINE_DEPTH) return [textNode(decodeEntities(text))];
  const index = indexInline(text);
  const nodes: TelegramHtmlNode[] = [];
  let pending = '';
  const emit = (more: readonly TelegramHtmlNode[]): void => {
    if (pending !== '') nodes.push(textNode(pending));
    pending = '';
    append(nodes, more);
  };
  const noCloser = new Set<string>();
  // The run of delimiter characters the scan stands in, measured once per run: a run is judged
  // at its edges, and every position inside it asks the same question.
  let run = { char: '', start: -1, end: -1 };
  const runOf = (at: number, char: string): number => {
    if (run.char !== char || at >= run.end || at < run.start)
      run = { char, start: runBegin(text, at, char), end: runEnd(text, at, char) };
    return run.start;
  };
  outer: for (let i = 0; i < text.length; ) {
    const ch = text[i] ?? '';
    if (ch === '\\' && ASCII_PUNCT.test(text[i + 1] ?? '')) {
      pending += text[i + 1] ?? '';
      i += 2;
      continue;
    }
    if (ch === '`') {
      const ticks = countRun(text, i, '`');
      const close = codeSpanClose(index, i + ticks, ticks);
      if (close === -1) {
        pending += text.slice(i, i + ticks);
        i += ticks;
      } else {
        const raw = text.slice(i + ticks, close).replace(/\n/g, ' ');
        const padded = raw.length > 2 && raw[0] === ' ' && raw.at(-1) === ' ';
        const code = padded && /[^ ]/.test(raw) ? raw.slice(1, -1) : raw;
        if (mayOpenInside('code', anc)) {
          emit([{ kind: 'element', tag: 'code', children: [textNode(code)] }]);
        } else pending += code;
        i = close + ticks;
      }
      continue;
    }
    if (ch === '&') {
      ENTITY_AT.lastIndex = i;
      const m = ENTITY_AT.exec(text);
      const decoded = m ? decodeEntity(m[1], m[2], m[3]) : undefined;
      pending += decoded ?? '&';
      i = decoded !== undefined ? ENTITY_AT.lastIndex : i + 1;
      continue;
    }
    const underline = ch === '<' ? index.underlineClose.get(i) : undefined;
    if (underline !== undefined) {
      const next: readonly TelegramHtmlTag[] = anc.includes('u') ? anc : [...anc, 'u'];
      emit(wrapStyle('u', parseInline(text.slice(i + 3, underline), next, depth + 1), anc));
      i = underline + 4;
      continue;
    }
    if ((ch === '!' && text[i + 1] === '[') || ch === '[') {
      const link = parseLinkAt(index, ch === '!' ? i + 1 : i);
      if (link !== undefined) {
        // A literal quote is invalid in the Markdown destination; an entity is not a literal quote.
        const href = link.rawUrl.includes('"')
          ? undefined
          : safeTelegramLinkHref(decodeEntities(link.rawUrl));
        if (href === undefined) {
          // A destination the link rules refuse is not a link and is not dropped either: the
          // reader sees what was written, so nothing the author meant is lost.
          pending += decodeEntities(text.slice(i, link.end));
        } else if (mayOpenInside('a', anc)) {
          const children = parseInline(link.label, [...anc, 'a'], depth + 1);
          if (children.length > 0) emit([{ kind: 'element', tag: 'a', href, children }]);
        } else emit(parseInline(link.label, anc, depth + 1));
        i = link.end;
        continue;
      }
    }
    for (const marker of MARKER_MAP[ch] ?? []) {
      const openEnd = i + marker.length;
      if (!text.startsWith(marker, i) || noCloser.has(marker)) continue;
      const runStart = runOf(i, ch);
      if (WORD_END.test(text.slice(Math.max(0, runStart - 2), runStart))) continue;
      if (openEnd >= text.length || isSpace(text[openEnd])) continue;
      const close = findDelimiterClose(index, openEnd, marker);
      if (close === -1) {
        noCloser.add(marker);
        continue;
      }
      const tags = tagsFor(marker);
      const next = [...anc, ...tags.filter((t) => !anc.includes(t) && mayOpenInside(t, anc))];
      const inner = parseInline(text.slice(openEnd, close), next, depth + 1);
      emit(tags.reduceRight((acc, tag) => wrapStyle(tag, acc, anc), inner));
      i = close + marker.length;
      continue outer;
    }
    pending += ch;
    i += 1;
  }
  emit([]);
  return nodes;
}
