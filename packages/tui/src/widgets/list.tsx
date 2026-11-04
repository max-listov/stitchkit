import { useEffect, useRef } from 'react';
import {
  defineTerminalKeymap,
  matchTerminalKey,
  type TerminalKeyBinding,
} from '../core/key-hints';
import type { TerminalLabels } from '../core/labels';
import {
  selectedTerminalListItem,
  type TerminalListAction,
  type TerminalListItem,
  type TerminalListState,
  visibleTerminalListLines,
} from '../core/list';
import { terminalHighlightRuns } from '../core/search';
import {
  fitTerminalText,
  sanitizeTerminalText,
  terminalTextEdit,
  terminalTextWidth,
  truncateTerminalText,
  wrapTerminalText,
} from '../core/text';
import { useTerminalFocused, useTerminalLabels } from './context';
import { useTerminalKeyboard } from './keyboard';
import { useTerminalPalette } from './theme';

/** Bindings of a list; the same data draws its key hints. */
export function terminalListKeymap(
  labels: TerminalLabels,
  options: { searchable?: boolean; multiple?: boolean; back?: boolean } = {},
): TerminalKeyBinding[] {
  return defineTerminalKeymap([
    { id: 'up', keys: ['up'], display: '↑↓', label: labels.move, priority: 0 },
    { id: 'down', keys: ['down'], display: '↓', label: labels.move, hidden: true },
    {
      id: 'activate',
      keys: ['return', 'enter'],
      display: 'Enter',
      label: labels.open,
      priority: 0,
    },
    ...(options.back
      ? [{ id: 'back', keys: ['escape'], display: 'Esc', label: labels.back, priority: 1 }]
      : []),
    ...(options.searchable
      ? [
          {
            id: 'search',
            keys: ['/'],
            display: labels.typing,
            label: labels.search,
            priority: 2,
          },
        ]
      : []),
    ...(options.multiple
      ? [{ id: 'pick', keys: ['space'], display: 'Space', label: labels.pick, priority: 1 }]
      : []),
    { id: 'page-up', keys: ['pageup'], display: 'PgUp/PgDn', label: labels.page, priority: 3 },
    { id: 'page-down', keys: ['pagedown'], display: 'PgDn', label: labels.page, hidden: true },
    { id: 'section-up', keys: ['['], display: '[ ]', label: labels.move, hidden: true },
    { id: 'section-down', keys: [']'], display: ']', label: labels.move, hidden: true },
  ]);
}

export interface TerminalListProps {
  state: TerminalListState;
  onAction(action: TerminalListAction): void;
  onActivate?(item: TerminalListItem): void;
  onBack?(): void;
  width: number;
  /** Lines for the whole widget: search line, list, and the selected item's description. */
  height: number;
  /** Typing filters the list (the query line shows at the top). */
  searchable?: boolean;
  /** Lines reserved under the list for the selected item's description. */
  descriptionLines?: number;
  focusId?: string;
  focused?: boolean;
  keymap?: readonly TerminalKeyBinding[];
}

/**
 * A picker: section headings, items with meta and badges, a `›` cursor on a
 * raised row, matches highlighted while searching, "N more" at the edges, and
 * the selected item's description underneath.
 */
export function TerminalList({
  state,
  onAction,
  onActivate,
  onBack,
  width,
  height,
  searchable = false,
  descriptionLines = 2,
  focusId,
  focused,
  keymap,
}: TerminalListProps) {
  const palette = useTerminalPalette();
  const labels = useTerminalLabels();
  const active = useTerminalFocused(focusId, focused);
  const bindings =
    keymap ??
    terminalListKeymap(labels, {
      searchable,
      multiple: state.multiple,
      back: onBack !== undefined,
    });
  const searchRows = searchable ? 2 : 0;
  // The list window sits between a "more above" and a "more below" line.
  const listRows = Math.max(1, height - searchRows - descriptionLines - 2);

  // Activation travels through the state, so Enter after keys that moved the
  // selection in the same burst opens the item the reader actually reached.
  const delivered = useRef(state.activation?.serial ?? 0);
  useEffect(() => {
    const activation = state.activation;
    if (!activation || activation.serial === delivered.current) return;
    delivered.current = activation.serial;
    const item = state.items.find(({ key }) => key === activation.key);
    if (item) onActivate?.(item);
  }, [state.activation, state.items, onActivate]);

  useTerminalKeyboard(
    (key) => {
      const id = matchTerminalKey(bindings, key)?.id;
      if (id === 'up' || id === 'down')
        onAction({ type: 'move', delta: id === 'up' ? -1 : 1 });
      else if (id === 'page-up' || id === 'page-down')
        onAction({ type: 'move', delta: (id === 'page-up' ? -1 : 1) * listRows });
      else if (id === 'section-up' || id === 'section-down')
        onAction({ type: 'section', delta: id === 'section-up' ? -1 : 1 });
      else if (id === 'pick') onAction({ type: 'toggle' });
      else if (id === 'activate') onAction({ type: 'activate' });
      else if (id === 'back' && searchable && state.query !== '')
        onAction({ type: 'query', query: '' });
      else if (id === 'back' && onBack) onBack();
      else if (searchable) {
        // Any printable key types into the query; the hint only names it.
        const edit = terminalTextEdit(key);
        if (edit === null || edit.kind === 'commit' || edit.kind === 'clear') return false;
        onAction({ type: 'query-edit', edit });
      } else return false;
      return true;
    },
    { active },
  );

  const { lines, above, below } = visibleTerminalListLines(state, listRows);
  const selected = selectedTerminalListItem(state);
  const description = wrapTerminalText(
    sanitizeTerminalText(selected?.description ?? ''),
    Math.max(1, width),
  ).slice(0, descriptionLines);
  const hasItems = state.lines.some((line) => line.kind === 'item');

  return (
    <box style={{ flexDirection: 'column', width, height }}>
      {searchable ? (
        <text wrapMode='none'>
          <span fg={palette.accent}>{'⌕ '}</span>
          <span fg={state.query ? palette.primary : palette.muted}>
            {fitTerminalText(state.query || labels.search, Math.max(0, width - 2))}
          </span>
        </text>
      ) : null}
      {searchable ? <text fg={palette.border}>{'─'.repeat(width)}</text> : null}
      <text fg={palette.muted} wrapMode='none'>
        {above > 0 ? labels.moreAbove(above) : ' '}
      </text>
      <box style={{ flexDirection: 'column', height: listRows }}>
        {!hasItems ? (
          <text fg={palette.muted}>{labels.nothingFound}</text>
        ) : (
          lines.map((line, slot) => {
            if (line.kind === 'section') {
              return (
                <text key={slot} wrapMode='none'>
                  <span fg={palette.accent}>
                    {truncateTerminalText(sanitizeTerminalText(line.title), width - 6)}
                  </span>
                  <span fg={palette.muted}>{` ${line.count}`}</span>
                </text>
              );
            }
            const item = line.item;
            const isSelected = line.key === state.collection.selectedKey;
            const mark = state.multiple ? (state.picked.has(item.key) ? '◉ ' : '○ ') : '';
            const badge =
              item.badge === undefined ? '' : ` ${sanitizeTerminalText(String(item.badge))}`;
            const meta = item.meta ? `  ${sanitizeTerminalText(item.meta)}` : '';
            const room = Math.max(
              1,
              width - 2 - terminalTextWidth(mark) - terminalTextWidth(badge),
            );
            const title = truncateTerminalText(sanitizeTerminalText(item.title), room);
            const metaText = truncateTerminalText(
              meta,
              Math.max(0, room - terminalTextWidth(title)),
            );
            const pad = Math.max(
              0,
              room - terminalTextWidth(title) - terminalTextWidth(metaText),
            );
            const tone = item.disabled ? palette.muted : palette[item.tone ?? 'primary'];
            return (
              <text
                key={slot}
                wrapMode='none'
                {...(isSelected && active && { bg: palette.panelRaised })}
              >
                <span fg={isSelected ? palette.accent : palette.muted}>
                  {isSelected ? '› ' : '  '}
                </span>
                <span fg={palette.accent}>{mark}</span>
                {terminalHighlightRuns(title, line.titleRanges).map((run, index) => (
                  <span key={index} fg={run.highlighted ? palette.accent : tone}>
                    {run.text}
                  </span>
                ))}
                <span fg={palette.muted}>{metaText + ' '.repeat(pad)}</span>
                <span fg={palette.muted}>{badge}</span>
              </text>
            );
          })
        )}
      </box>
      <text fg={palette.muted} wrapMode='none'>
        {below > 0 ? labels.moreBelow(below) : ' '}
      </text>
      <box style={{ flexDirection: 'column', height: descriptionLines }}>
        {description.map((line, index) => (
          <text key={index} fg={palette.muted} wrapMode='none'>
            {line}
          </text>
        ))}
      </box>
    </box>
  );
}
