/**
 * GitHub-flavored Markdown into Telegram HTML, built as `TelegramHtmlNode[]`
 * and rendered only through `renderTelegramHtml` so every output satisfies
 * `checkTelegramHtml(out).problem === undefined` and `sanitizeTelegramHtml(out) === out`.
 *
 * Block conversion is linear in the text: `<details>` blocks are matched for a
 * whole run of lines on one stack before any is converted, and a table is
 * aligned only while its aligned form stays within `MAX_TABLE_GROWTH` times its
 * source. Quotes and `<details>` nest at most `MAX_BLOCK_DEPTH` deep; deeper
 * lines stay inline text, so no input recurses on its own depth.
 */

import { parseInline, textNode, wrapStyle } from './markdown-inline';
import {
  DETAILS_OPEN,
  DETAILS_TOKEN,
  type FenceOpen,
  findClosingFenceIndex,
  HR,
  headingTitle,
  isFenceClose,
  isTableStart,
  LIST_ITEM,
  matchFenceOpen,
  QUOTE,
  splitRow,
  tableBodyEnd,
} from './markdown-lines';
import {
  mayOpenInside,
  normalizeTelegramHtmlNodes,
  TELEGRAM_CODE_LANGUAGE_PATTERN,
  type TelegramHtmlNode,
  type TelegramHtmlTag,
  textOf,
} from './nodes';
import { renderTelegramHtml } from './render';

const MAX_BLOCK_DEPTH = 32;
const MAX_TABLE_GROWTH = 4;
const SUMMARY_OPEN = /<summary(?:\s[^<>]*)?>/i;
const SUMMARY_CLOSE = /<\/summary>/gi;

const NEWLINE = textNode('\n');
const joinParts = (parts: readonly (readonly TelegramHtmlNode[])[]): TelegramHtmlNode[] =>
  parts.flatMap((part, i) => (i > 0 ? [NEWLINE, ...part] : [...part]));

const boldInline = (title: string, anc: readonly TelegramHtmlTag[]): TelegramHtmlNode[] =>
  wrapStyle('b', parseInline(title, anc.includes('b') ? anc : [...anc, 'b']), anc);

function wrapPre(text: string, anc: readonly TelegramHtmlTag[], language?: string) {
  if (text === '') return [];
  if (!mayOpenInside('pre', anc)) return [textNode(text)];
  const children = [textNode(text)];
  const pre: TelegramHtmlNode = language
    ? { kind: 'element', tag: 'pre', language, children }
    : { kind: 'element', tag: 'pre', children };
  return [pre];
}

/**
 * A table as aligned text. Its size is known before any padding is built: a
 * table whose aligned form would outgrow `MAX_TABLE_GROWTH` times its source
 * is joined unpadded instead. The last column is never padded on the right.
 */
function formatGfmTable(headerLine: string, sepLine: string, body: readonly string[]): string {
  const header = splitRow(headerLine);
  const aligns = splitRow(sepLine).map((c) =>
    c.startsWith(':') && c.endsWith(':') ? 'c' : c.endsWith(':') ? 'r' : 'l',
  );
  const rows = [header, ...body.map(splitRow)];
  const widths: number[] = [];
  let source = sepLine.length;
  for (const row of rows) {
    row.forEach((cell, c) => {
      widths[c] = Math.max(widths[c] ?? 1, cell.length);
      source += cell.length + 3;
    });
  }
  const last = widths.length - 1;
  const lastWidth = widths[last] ?? 1;
  const lead = widths.slice(0, last).reduce((sum, w) => sum + w + 3, 0);
  const cell = (value: string, c: number): string => {
    const room = (widths[c] ?? 1) - value.length;
    if (aligns[c] === 'r') return ' '.repeat(room) + value;
    const before = aligns[c] === 'c' ? room >> 1 : 0;
    return ' '.repeat(before) + value + (c === last ? '' : ' '.repeat(room - before));
  };
  const lastLength = (value: string): number =>
    aligns[last] === 'r'
      ? lastWidth
      : value.length + (aligns[last] === 'c' ? (lastWidth - value.length) >> 1 : 0);
  let size = lead + lastWidth;
  for (const row of rows) size += lead + lastLength(row[last] ?? '') + 1;
  if (size > MAX_TABLE_GROWTH * source) return rows.map((row) => row.join(' | ')).join('\n');
  const render = (row: readonly string[]): string =>
    widths
      .map((_, c) => cell(row[c] ?? '', c))
      .join(' | ')
      .trimEnd();
  const rule = widths.map((w) => '-'.repeat(w)).join('-+-');
  return [render(header), rule, ...rows.slice(1).map(render)].join('\n');
}

/** A matched `<details>` block: where its closing tag sits. */
interface DetailsSpan {
  readonly endLine: number;
  readonly closeAt: number;
  readonly closeEnd: number;
}

/** Lines fenced as code, seen the way a `<details>` block sees them. */
interface DetailsScan {
  readonly spans: ReadonlyMap<number, DetailsSpan>;
  readonly fenced: readonly boolean[];
}

/**
 * Match every `<details>` that opens a line with its `</details>` in one pass.
 * A line opening a block is read after its opening tag; tags inside code
 * fences do not count.
 */
function scanDetails(lines: readonly string[]): DetailsScan {
  const spans = new Map<number, DetailsSpan>();
  const fenced: boolean[] = [];
  const open: (number | undefined)[] = [];
  let fence: FenceOpen | undefined;
  lines.forEach((line, i) => {
    if (fence !== undefined) {
      fenced[i] = true;
      if (isFenceClose(line, fence)) fence = undefined;
      return;
    }
    const opener = DETAILS_OPEN.exec(line);
    const rest = opener === null ? line : (opener[1] ?? '');
    const offset = line.length - rest.length;
    if (opener !== null) open.push(i);
    fence = matchFenceOpen(rest);
    if (fence !== undefined) {
      fenced[i] = true;
      return;
    }
    for (const token of rest.matchAll(DETAILS_TOKEN)) {
      if (token[1] !== '/') {
        open.push(undefined);
        continue;
      }
      const start = open.pop();
      if (start === undefined) continue;
      const closeAt = offset + (token.index ?? 0);
      spans.set(start, { endLine: i, closeAt, closeEnd: closeAt + token[0].length });
    }
  });
  return { spans, fenced };
}

/** The first `<summary>…</summary>` of `text`, its title and the text without it. */
function takeSummary(
  text: string,
  firstSegment: boolean,
): { title: string; rest: string } | undefined {
  const open = SUMMARY_OPEN.exec(text);
  if (open === null) return undefined;
  SUMMARY_CLOSE.lastIndex = open.index + open[0].length;
  const close = SUMMARY_CLOSE.exec(text);
  if (close === null) return undefined;
  const title = text.slice(open.index + open[0].length, close.index);
  const before = text.slice(0, open.index);
  const after = text.slice(SUMMARY_CLOSE.lastIndex);
  return {
    title: title
      .split('\n')
      .map((piece) => piece.trim())
      .filter((piece) => piece !== '')
      .join(' '),
    // joinParts supplies the heading's line break. Consume only the boundary of
    // a leading summary line; additional blank lines belong to the body.
    rest:
      firstSegment && /^[ \t]*$/.test(before)
        ? after.replace(/^[ \t]*\n/, '')
        : before + after,
  };
}

function parseDetailsBlock(
  lines: readonly string[],
  start: number,
  span: DetailsSpan,
  scan: DetailsScan,
  anc: readonly TelegramHtmlTag[],
  depth: number,
): TelegramHtmlNode[] {
  const segments: Array<{ fenced: boolean; lines: string[] }> = [];
  const push = (line: string, fenced: boolean): void => {
    const tail = segments.at(-1);
    if (tail?.fenced === fenced) tail.lines.push(line);
    else segments.push({ fenced, lines: [line] });
  };
  const opener = DETAILS_OPEN.exec(lines[start] ?? '');
  const firstRest = opener?.[1] ?? '';
  const offset = (lines[start] ?? '').length - firstRest.length;
  for (let i = start; i <= span.endLine; i += 1) {
    const from = i === start ? offset : 0;
    const line = lines[i] ?? '';
    const fenced = scan.fenced[i] === true;
    if (i === span.endLine && !fenced) {
      const content = line.slice(from, span.closeAt);
      if (content.trim()) push(content, false);
      break;
    }
    if (i === start && !firstRest.trim()) continue;
    push(line.slice(from), fenced);
  }
  let title = '';
  for (const seg of segments) {
    if (seg.fenced) continue;
    const summary = takeSummary(seg.lines.join('\n'), seg === segments[0]);
    if (summary === undefined) continue;
    title = summary.title;
    seg.lines = [summary.rest];
    break;
  }
  const rest = segments.flatMap((seg) => seg.lines).join('\n');
  const parts = [
    ...(title ? [boldInline(title, anc)] : []),
    ...(rest.trim() ? [parseBlocks(rest.split('\n'), anc, depth + 1)] : []),
  ].filter((p) => p.length > 0);
  return joinParts(parts);
}

function parseBlocks(
  lines: readonly string[],
  anc: readonly TelegramHtmlTag[],
  depth: number,
): TelegramHtmlNode[] {
  if (depth >= MAX_BLOCK_DEPTH) return joinParts(lines.map((line) => parseInline(line, anc)));
  const blocks: TelegramHtmlNode[][] = [];
  const details = scanDetails(lines);
  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i] ?? '';
    const fence = matchFenceOpen(line);
    if (fence !== undefined) {
      const closeIndex = findClosingFenceIndex(lines, i, fence);
      if (closeIndex === -1) {
        for (let r = i; r < lines.length; r += 1) blocks.push([textNode(lines[r] ?? '')]);
        break;
      }
      const token = fence.info.trim().split(/\s+/)[0] ?? '';
      const lang = TELEGRAM_CODE_LANGUAGE_PATTERN.test(token) ? token : undefined;
      blocks.push(wrapPre(lines.slice(i + 1, closeIndex).join('\n'), anc, lang));
      i = closeIndex;
      continue;
    }
    const span = details.spans.get(i);
    if (span !== undefined) {
      const nodes = parseDetailsBlock(lines, i, span, details, anc, depth);
      if (nodes.length > 0) blocks.push(nodes);
      const trailing = (lines[span.endLine] ?? '').slice(span.closeEnd);
      if (trailing.trim()) blocks.push(parseInline(trailing.trimStart(), anc));
      i = span.endLine;
      continue;
    }
    if (QUOTE.test(line)) {
      const quoted: string[] = [];
      for (; i < lines.length && QUOTE.test(lines[i] ?? ''); i += 1) {
        quoted.push((lines[i] ?? '').replace(QUOTE, '$1'));
      }
      i -= 1;
      const canQuote = mayOpenInside('blockquote', anc);
      const children = parseBlocks(quoted, canQuote ? [...anc, 'blockquote'] : anc, depth + 1);
      if (!canQuote) blocks.push(children);
      else if (textOf(children).trim() !== '') {
        blocks.push([{ kind: 'element', tag: 'blockquote', expandable: false, children }]);
      } else blocks.push([]);
      continue;
    }
    if (HR.test(line)) {
      blocks.push([textNode('───')]);
      continue;
    }
    const title = headingTitle(line);
    if (title !== undefined) {
      blocks.push(title === '' ? [] : boldInline(title, anc));
      continue;
    }
    const list = LIST_ITEM.exec(line);
    if (list !== null) {
      const indent = '  '.repeat(
        Math.floor((list[1] ?? '').replaceAll('\t', '  ').length / 2),
      );
      const marker = list[2] === ' ' ? '☐ ' : list[2] ? '☑ ' : list[4] ? `${list[4]}. ` : '• ';
      blocks.push([textNode(indent + marker), ...parseInline(list[5] ?? '', anc)]);
      continue;
    }
    const nextLine = lines[i + 1];
    if (nextLine !== undefined && isTableStart(line, nextLine)) {
      const end = tableBodyEnd(lines, i + 2);
      blocks.push(wrapPre(formatGfmTable(line, nextLine, lines.slice(i + 2, end)), anc));
      i = end - 1;
      continue;
    }
    blocks.push(parseInline(line, anc));
  }
  return joinParts(blocks);
}

/** Convert GitHub-flavored Markdown into Telegram HTML safe for `parse_mode: 'HTML'`. */
export function markdownToTelegramHtml(source: string): string {
  if (source === '') return '';
  const lines = source.replace(/\r\n?/g, '\n').split('\n');
  return renderTelegramHtml(normalizeTelegramHtmlNodes(parseBlocks(lines, [], 0)));
}
