/**
 * What one line of GitHub-flavored Markdown is: a code fence, a quote, a
 * heading, a rule, a list item, the start of a `<details>` block or of a GFM
 * table. The converter and the Markdown splitter read lines through these same
 * rules, so a construct the converter renders whole is the construct the
 * splitter keeps whole.
 */

const FENCE_OPEN = /^([ ]{0,3})(`{3,}|~{3,})(.*)$/;
const FENCE_CLOSE = /^[ ]{0,3}(`{3,}|~{3,})[ \t]*$/;

export const QUOTE = /^[ ]{0,3}> ?(.*)$/;
const HEADING_OPEN = /^[ ]{0,3}(#{1,6})([ \t]+)/;
export const HR = /^[ ]{0,3}(?:(?:\*[ \t]*){3,}|(?:-[ \t]*){3,}|(?:_[ \t]*){3,})$/;
export const LIST_ITEM =
  /^([ \t]*)(?:(?:[-*+]|\d+[.)])[ \t]+\[([ xX])\]|([-*+])|(\d+)[.)])[ \t]+(.*)$/;
export const DETAILS_OPEN = /^[ \t]*<details(?:\s[^<>]*)?>(.*)$/i;
export const DETAILS_TOKEN = /<(\/?)details(?:\s[^<>]*)?>/gi;

const isBlank = (char: string | undefined): boolean => char === ' ' || char === '\t';

/**
 * The title of an ATX heading (`## Title ##`), trimmed, or `undefined` when the
 * line is not one. A heading of spaces alone has an empty title. Scanned by
 * hand: a lazy title followed by an optional closing run backtracks
 * quadratically on a long run of spaces.
 */
export function headingTitle(line: string): string | undefined {
  const open = HEADING_OPEN.exec(line);
  if (open === null) return undefined;
  const content = line.slice(open[0].length);
  if (content === '') return (open[2] ?? '').length >= 2 ? '' : undefined;
  let end = content.length;
  while (end > 0 && isBlank(content[end - 1])) end -= 1;
  let hashes = end;
  while (hashes > 0 && content[hashes - 1] === '#') hashes -= 1;
  if (hashes < end && hashes > 0 && isBlank(content[hashes - 1])) end = hashes;
  return content.slice(0, end).trim();
}

/** An opening code fence line. */
export interface FenceOpen {
  readonly char: '`' | '~';
  readonly length: number;
  readonly info: string;
  readonly openLine: string;
  readonly closeLine: string;
}

/** Parse a fenced code block opener (` ```+ ` or ` ~~~+ `), or `undefined` if the line is not one. */
export function matchFenceOpen(line: string): FenceOpen | undefined {
  const match = FENCE_OPEN.exec(line);
  if (!match) return undefined;
  const run = match[2] ?? '';
  const info = match[3] ?? '';
  const char = run[0] === '~' ? '~' : '`';
  // A backtick fence's info string holds no backtick, or a one-line code span would open a fence.
  if (char === '`' && info.includes('`')) return undefined;
  return {
    char,
    length: run.length,
    info,
    openLine: line,
    closeLine: char.repeat(run.length),
  };
}

/** Whether `line` closes `fence` (same fence character, at least as long, only trailing spaces). */
export function isFenceClose(
  line: string,
  fence: Pick<FenceOpen, 'char' | 'length'>,
): boolean {
  const match = FENCE_CLOSE.exec(line);
  if (!match) return false;
  const run = match[1] ?? '';
  return run[0] === fence.char && run.length >= fence.length;
}

/** Index of the matching closing fence after `openIndex`, or `-1` when the fence is unclosed. */
export function findClosingFenceIndex(
  lines: readonly string[],
  openIndex: number,
  fence: Pick<FenceOpen, 'char' | 'length'>,
): number {
  for (let index = openIndex + 1; index < lines.length; index += 1) {
    if (isFenceClose(lines[index] ?? '', fence)) return index;
  }
  return -1;
}

/**
 * A table separator row (`|---|:-:|`). Written as a scan rather than one
 * pattern: two runs of optional spaces around an optional pipe make a pattern
 * backtrack quadratically on a long run of spaces.
 */
export function isTableSeparator(line: string): boolean {
  const cells = line.trim().replace(/^\|/, '').replace(/\|$/, '');
  if (cells === '') return false;
  for (const cell of cells.split('|')) {
    const body = cell.trim();
    const dashes = body.replace(/^:/, '').replace(/:$/, '');
    if (dashes === '' || /[^-]/.test(dashes)) return false;
  }
  return true;
}

/** Cells of a table row: outer pipes dropped, `\|` kept as a pipe inside a cell. */
export function splitRow(line: string): string[] {
  const body = line.trim().replace(/^\||(?<!\\)\|$/g, '');
  return body.split(/(?<!\\)\|/).map((cell) => cell.replaceAll('\\|', '|').trim());
}

/** Whether `line` heads a GFM table: a row followed by a separator of as many cells. */
export function isTableStart(line: string, nextLine: string): boolean {
  return (
    line.includes('|') &&
    nextLine.includes('|') &&
    isTableSeparator(nextLine) &&
    splitRow(line).length === splitRow(nextLine).length
  );
}

/**
 * Whether `line` opens a block the converter reads before a table — a quote,
 * a rule, a heading, a list item or a `<details>` — so it never heads one.
 */
export function startsOtherBlock(line: string): boolean {
  return (
    QUOTE.test(line) ||
    HR.test(line) ||
    headingTitle(line) !== undefined ||
    LIST_ITEM.test(line) ||
    DETAILS_OPEN.test(line)
  );
}

/** Index just past the last body row of a table whose first body row is at `first`. */
export function tableBodyEnd(lines: readonly string[], first: number): number {
  let index = first;
  for (; index < lines.length; index += 1) {
    const row = lines[index] ?? '';
    if (!row.includes('|') || !row.trim() || matchFenceOpen(row)) break;
    if (QUOTE.test(row) || headingTitle(row) !== undefined || HR.test(row)) break;
  }
  return index;
}
