import type { TerminalKey } from './keys';

/**
 * Terminal text: what a cell holds. Anything an application did not write
 * itself (provider output, tool results, file names) passes through
 * `sanitizeTerminalText` before it reaches the screen, so an escape sequence in
 * data can never move the cursor, change colours or retitle the window.
 */

// String sequences (OSC, DCS, SOS, PM, APC) run to their terminator, or to the
// end of the text when it never comes; then CSI with parameters, then any other
// escape with its intermediates. The 8-bit C1 introducers count as escapes.
const STRING_SEQUENCE =
  // biome-ignore lint/suspicious/noControlCharactersInRegex: the point is to find them
  /(?:\u001b[\]PX^_]|[\u0090\u0098\u009d\u009e\u009f])[\s\S]*?(?:\u0007|\u001b\\|\u009c|$)/g;
const CSI =
  // biome-ignore lint/suspicious/noControlCharactersInRegex: the point is to find them
  /(?:\u001b\[|\u009b)[0-?]*[ -/]*[@-~]?/g;
const ESCAPE =
  // biome-ignore lint/suspicious/noControlCharactersInRegex: the point is to find them
  /\u001b[ -/]*[0-~]?/g;
// biome-ignore lint/suspicious/noControlCharactersInRegex: the point is to find them
const CONTROL = /[\u0000-\u0008\u000b-\u001f\u007f-\u009f]/g;

/** Drop escape sequences and control characters; tabs become spaces, newlines stay. */
export function sanitizeTerminalText(text: string, tabWidth = 2): string {
  return text
    .replace(STRING_SEQUENCE, '')
    .replace(CSI, '')
    .replace(ESCAPE, '')
    .replace(/\r\n?/g, '\n')
    .replace(/\t/g, ' '.repeat(tabWidth))
    .replace(CONTROL, '');
}

const WIDE: readonly [number, number][] = [
  [0x1100, 0x115f],
  [0x2e80, 0x303e],
  [0x3041, 0x33ff],
  [0x3400, 0x4dbf],
  [0x4e00, 0x9fff],
  [0xa000, 0xa4cf],
  [0xac00, 0xd7a3],
  [0xf900, 0xfaff],
  [0xfe30, 0xfe4f],
  [0xff00, 0xff60],
  [0xffe0, 0xffe6],
  [0x1f300, 0x1f64f],
  [0x1f900, 0x1f9ff],
  [0x20000, 0x3fffd],
];

const segmenter = new Intl.Segmenter(undefined, { granularity: 'grapheme' });

/** The user-perceived characters of a text: an emoji family or a letter with its marks is one. */
export function terminalGraphemes(text: string): string[] {
  return Array.from(segmenter.segment(text), ({ segment }) => segment);
}

/**
 * Cells one grapheme takes: 2 for emoji presentation and wide East Asian
 * characters, 0 for a lone mark or format character, otherwise 1.
 */
export function terminalGraphemeWidth(grapheme: string): number {
  if (/^[\p{M}\p{Cf}]+$/u.test(grapheme)) return 0;
  if (
    /\p{Emoji_Presentation}/u.test(grapheme) ||
    (grapheme.includes('️') && /\p{Extended_Pictographic}/u.test(grapheme))
  )
    return 2;
  const code = grapheme.codePointAt(0) ?? 0;
  for (const [start, end] of WIDE) if (code >= start && code <= end) return 2;
  return 1;
}

export function terminalTextWidth(text: string): number {
  let width = 0;
  for (const grapheme of terminalGraphemes(text)) width += terminalGraphemeWidth(grapheme);
  return width;
}

/** Cut to at most `width` cells, ending in `…` when anything was cut; never splits a grapheme. */
export function truncateTerminalText(text: string, width: number): string {
  if (width <= 0) return '';
  if (terminalTextWidth(text) <= width) return text;
  let used = 0;
  let result = '';
  for (const grapheme of terminalGraphemes(text)) {
    const cells = terminalGraphemeWidth(grapheme);
    if (used + cells > width - 1) break;
    result += grapheme;
    used += cells;
  }
  return `${result}…`;
}

/** Exactly `width` cells: cut with `…` or padded on the side away from `align`. */
export function fitTerminalText(
  text: string,
  width: number,
  align: 'left' | 'right' | 'center' = 'left',
): string {
  const cut = truncateTerminalText(text, width);
  const pad = Math.max(0, width - terminalTextWidth(cut));
  if (align === 'right') return ' '.repeat(pad) + cut;
  if (align === 'center') {
    const before = Math.floor(pad / 2);
    return ' '.repeat(before) + cut + ' '.repeat(pad - before);
  }
  return cut + ' '.repeat(pad);
}

/**
 * Word-wrap to `width` cells. Paragraph breaks are kept, a word longer than a
 * line is broken between graphemes, and an indentation shorter than half the
 * width carries onto continuation lines.
 */
export function wrapTerminalText(text: string, width: number): string[] {
  if (width <= 0) return [];
  const lines: string[] = [];
  for (const paragraph of text.split('\n')) {
    const indent = /^ */.exec(paragraph)?.[0] ?? '';
    const words = paragraph.slice(indent.length).split(/ +/).filter(Boolean);
    if (words.length === 0) {
      lines.push('');
      continue;
    }
    const first = indent.length < width ? indent : '';
    const hang = indent.length < width / 2 ? indent : '';
    let line = first;
    let start = first.length;
    let used = start;
    const flush = (): void => {
      lines.push(line.trimEnd());
      line = hang;
      start = hang.length;
      used = start;
    };
    for (const word of words) {
      const cells = terminalTextWidth(word);
      const separator = used > start ? 1 : 0;
      if (used + separator + cells <= width) {
        line += (separator ? ' ' : '') + word;
        used += separator + cells;
        continue;
      }
      if (used > start) flush();
      if (cells <= width - used) {
        line += word;
        used += cells;
        continue;
      }
      for (const grapheme of terminalGraphemes(word)) {
        const graphemeCells = terminalGraphemeWidth(grapheme);
        if (used + graphemeCells > width && used > start) flush();
        line += grapheme;
        used += graphemeCells;
      }
    }
    lines.push(line.trimEnd());
  }
  return lines;
}

/** One edit of a single-line text: relative, so edits arriving faster than renders all land. */
export type TerminalTextEdit =
  | { kind: 'insert'; text: string }
  | { kind: 'erase' }
  | { kind: 'clear' }
  | { kind: 'commit' };

/** Typing into a one-line text: printable keys insert, Backspace erases, Esc clears, Enter commits. */
export function terminalTextEdit(key: TerminalKey): TerminalTextEdit | null {
  if (key.name === 'escape') return { kind: 'clear' };
  if (key.name === 'return' || key.name === 'enter') return { kind: 'commit' };
  if (key.name === 'backspace') return { kind: 'erase' };
  const text = key.sequence ?? '';
  const control = Array.from(text).some((char) => {
    const code = char.codePointAt(0) ?? 0;
    return code < 0x20 || code === 0x7f;
  });
  if (key.ctrl || key.meta || text.length === 0 || control) return null;
  return { kind: 'insert', text };
}

export function applyTerminalTextEdit(text: string, edit: TerminalTextEdit): string {
  if (edit.kind === 'insert') return text + edit.text;
  if (edit.kind === 'erase') return terminalGraphemes(text).slice(0, -1).join('');
  if (edit.kind === 'clear') return '';
  return text;
}
