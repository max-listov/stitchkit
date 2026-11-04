import {
  fitTerminalText,
  sanitizeTerminalText,
  terminalTextWidth,
  truncateTerminalText,
} from './text';
import type { TerminalTone } from './theme';

export interface TerminalStyledRun {
  text: string;
  tone: TerminalTone;
}

/** A drawn line as same-tone runs. */
export type TerminalStyledLine = TerminalStyledRun[];

/**
 * A JSON value as indented, toned lines: keys accent, strings success, numbers
 * and literals warning, punctuation muted. Strings are sanitized, so a value
 * carrying escape sequences prints them as text rather than running them.
 */
export function terminalJsonLines(value: unknown, indent = 2): TerminalStyledLine[] {
  const lines: TerminalStyledLine[] = [];
  const pad = (depth: number): TerminalStyledRun => ({
    text: ' '.repeat(depth * indent),
    tone: 'muted',
  });
  const scalar = (input: unknown): TerminalStyledRun => {
    if (typeof input === 'string')
      return { text: sanitizeTerminalText(JSON.stringify(input)), tone: 'success' };
    if (input === null || typeof input === 'boolean')
      return { text: String(input), tone: 'accent' };
    if (typeof input === 'number' || typeof input === 'bigint')
      return { text: String(input), tone: 'warning' };
    return { text: JSON.stringify(input) ?? 'undefined', tone: 'muted' };
  };
  const seen = new WeakSet<object>();
  const visit = (
    raw: unknown,
    depth: number,
    prefix: TerminalStyledRun[],
    last: boolean,
  ): void => {
    const comma: TerminalStyledRun[] = last ? [] : [{ text: ',', tone: 'muted' }];
    // What JSON.stringify would print: `toJSON` first (a Date is its ISO string).
    const input =
      typeof raw === 'object' &&
      raw !== null &&
      'toJSON' in raw &&
      typeof raw.toJSON === 'function'
        ? raw.toJSON()
        : raw;
    if (typeof input === 'object' && input !== null) {
      if (seen.has(input)) {
        lines.push([pad(depth), ...prefix, { text: '[Circular]', tone: 'muted' }, ...comma]);
        return;
      }
      seen.add(input);
    }
    const entries: [string | null, unknown][] | null = Array.isArray(input)
      ? input.map((item) => [null, item])
      : typeof input === 'object' && input !== null
        ? Object.entries(input)
        : null;
    if (entries === null) {
      lines.push([pad(depth), ...prefix, scalar(input), ...comma]);
      return;
    }
    const [open, close] = Array.isArray(input) ? ['[', ']'] : ['{', '}'];
    if (entries.length === 0) {
      lines.push([
        pad(depth),
        ...prefix,
        { text: `${open}${close}`, tone: 'muted' },
        ...comma,
      ]);
      return;
    }
    lines.push([pad(depth), ...prefix, { text: open, tone: 'muted' }]);
    entries.forEach(([key, item], index) => {
      const keyRuns: TerminalStyledRun[] =
        key === null
          ? []
          : [
              { text: sanitizeTerminalText(JSON.stringify(key)), tone: 'accent' },
              { text: ': ', tone: 'muted' },
            ];
      visit(item, depth + 1, keyRuns, index === entries.length - 1);
    });
    lines.push([pad(depth), { text: close, tone: 'muted' }, ...comma]);
  };
  visit(value, 0, [], true);
  return lines.map((line) => line.filter(({ text }) => text !== ''));
}

/** Aligned `key  value` pairs for a details view, values cut to the width left. */
export function layoutTerminalDetails(
  pairs: readonly { key: string; value: string; tone?: TerminalTone }[],
  width: number,
  gap = 2,
): { key: string; value: string; tone: TerminalTone }[] {
  const keyWidth = Math.min(
    Math.max(0, ...pairs.map(({ key }) => terminalTextWidth(key))),
    Math.max(1, Math.floor(width / 3)),
  );
  return pairs.map(({ key, value, tone }) => ({
    key: fitTerminalText(sanitizeTerminalText(key), keyWidth) + ' '.repeat(gap),
    value: truncateTerminalText(
      sanitizeTerminalText(value).replace(/\n/g, ' ⏎ '),
      Math.max(1, width - keyWidth - gap),
    ),
    tone: tone ?? 'primary',
  }));
}
