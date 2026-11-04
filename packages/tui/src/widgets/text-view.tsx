import { useMemo, useState } from 'react';
import { type TerminalStyledLine, terminalJsonLines } from '../core/json';
import {
  defineTerminalKeymap,
  matchTerminalKey,
  type TerminalKeyBinding,
} from '../core/key-hints';
import type { TerminalLabels } from '../core/labels';
import { sanitizeTerminalText, wrapTerminalText } from '../core/text';
import { useTerminalFocused, useTerminalLabels } from './context';
import { useTerminalKeyboard } from './keyboard';
import { useTerminalPalette } from './theme';

export function terminalTextViewKeymap(
  labels: TerminalLabels,
  back = true,
): TerminalKeyBinding[] {
  return defineTerminalKeymap([
    {
      id: 'up',
      keys: ['up', 'k'],
      shift: false,
      display: '↑↓',
      label: labels.move,
      priority: 1,
    },
    {
      id: 'down',
      keys: ['down', 'j'],
      shift: false,
      display: '↓',
      label: labels.move,
      hidden: true,
    },
    {
      id: 'page-up',
      keys: ['pageup', 'b'],
      shift: false,
      display: 'PgUp/PgDn',
      label: labels.page,
      priority: 0,
    },
    {
      id: 'page-down',
      keys: ['pagedown', 'space'],
      display: 'Space',
      label: labels.page,
      hidden: true,
    },
    {
      id: 'home',
      keys: ['home', 'g'],
      shift: false,
      display: 'Home',
      label: labels.top,
      hidden: true,
    },
    { id: 'end', keys: ['end', 'G'], display: 'End', label: labels.bottom, hidden: true },
    ...(back
      ? [
          {
            id: 'back',
            keys: ['escape', 'q'],
            display: 'Esc',
            label: labels.back,
            priority: 0,
          },
        ]
      : []),
  ]);
}

export interface TerminalTextViewProps {
  /** Plain text (sanitized and word-wrapped) or pre-toned lines (cut, not wrapped). */
  content: string | readonly TerminalStyledLine[];
  width: number;
  /** Lines for the view, the position line included. */
  height: number;
  onBack?(): void;
  focusId?: string;
  focused?: boolean;
}

/**
 * A pager for long output: scrolls by line and page, shows where the reader is,
 * and never runs escape sequences from the text it shows.
 */
export function TerminalTextView({
  content,
  width,
  height,
  onBack,
  focusId,
  focused,
}: TerminalTextViewProps) {
  const palette = useTerminalPalette();
  const labels = useTerminalLabels();
  const active = useTerminalFocused(focusId, focused);
  const bindings = terminalTextViewKeymap(labels, onBack !== undefined);
  const lines = useMemo<TerminalStyledLine[]>(
    () =>
      typeof content === 'string'
        ? wrapTerminalText(sanitizeTerminalText(content), Math.max(1, width)).map((text) => [
            { text, tone: 'primary' },
          ])
        : [...content],
    [content, width],
  );
  const rows = Math.max(1, height - 1);
  const last = Math.max(0, lines.length - rows);
  const [start, setStart] = useState(0);
  const top = Math.min(start, last);

  useTerminalKeyboard(
    (key) => {
      const id = matchTerminalKey(bindings, key)?.id;
      // Steps compose from the latest position, so a key repeat never drops one.
      const step = (move: (from: number) => number) =>
        setStart((from) => Math.min(Math.max(0, move(Math.min(from, last))), last));
      if (id === 'up') step((from) => from - 1);
      else if (id === 'down') step((from) => from + 1);
      else if (id === 'page-up') step((from) => from - rows);
      else if (id === 'page-down') step((from) => from + rows);
      else if (id === 'home') step(() => 0);
      else if (id === 'end') step(() => last);
      else if (id === 'back' && onBack) onBack();
      else return false;
      return true;
    },
    { active },
  );

  const percent = last === 0 ? 100 : Math.round((top / last) * 100);
  return (
    <box style={{ flexDirection: 'column', width, height }}>
      <box style={{ flexDirection: 'column', height: rows }}>
        {lines.slice(top, top + rows).map((line, slot) => (
          <text key={slot} wrapMode='none'>
            {line.map((run, index) => (
              <span key={index} fg={palette[run.tone]}>
                {run.text}
              </span>
            ))}
          </text>
        ))}
      </box>
      <text fg={palette.muted} wrapMode='none'>
        {`${top + 1}–${Math.min(lines.length, top + rows)} / ${lines.length} · ${labels.scroll(percent)}`}
      </text>
    </box>
  );
}

/** A JSON value in a pager, toned by kind. */
export function TerminalJsonView({
  value,
  ...props
}: Omit<TerminalTextViewProps, 'content'> & { value: unknown }) {
  const lines = useMemo(() => terminalJsonLines(value), [value]);
  return <TerminalTextView {...props} content={lines} />;
}
