import { useEffect, useMemo, useRef, useState } from 'react';
import type { TerminalKeyBinding } from '../core/key-hints';
import { terminalTableKey, terminalTableKeymap } from '../core/keys';
import {
  formatTerminalTableCell,
  layoutTerminalTableColumns,
  type TerminalTableAction,
  type TerminalTableRow,
  type TerminalTableState,
  terminalTableTreePrefix,
  visibleTerminalTableRows,
} from '../core/table';
import { fitTerminalText, sanitizeTerminalText, terminalTextEdit } from '../core/text';
import { useTerminalFocused, useTerminalLabels } from './context';
import { TerminalKeyPriority, useTerminalKeyboard } from './keyboard';
import { terminalToneAttributes, useTerminalPalette } from './theme';

export interface TerminalTableProps {
  state: TerminalTableState;
  /** Apply an action to the state the host owns (a `useReducer` dispatch). */
  onAction(action: TerminalTableAction): void;
  /** Enter on the selected row. */
  onActivate?(row: TerminalTableRow): void;
  width: number;
  /** Lines including the header and the footer; rows get `height - 2`. */
  height: number;
  focusId?: string;
  /** Whether this table answers the keyboard; overrides `focusId`. */
  focused?: boolean;
  keymap?: readonly TerminalKeyBinding[];
}

/**
 * A live table: one header line, a fixed window of rows and one footer line.
 * Only the rows inside the window are drawn and each line is rewritten in
 * place, so an update never changes the layout's height between ticks. While
 * the filter line is open it takes every key, so typing a digit never also
 * switches a tab.
 */
export function TerminalTable({
  state,
  onAction,
  onActivate,
  width,
  height,
  focusId,
  focused,
  keymap,
}: TerminalTableProps) {
  const palette = useTerminalPalette();
  const labels = useTerminalLabels();
  const active = useTerminalFocused(focusId, focused);
  const bindings = useMemo(() => keymap ?? terminalTableKeymap(labels), [keymap, labels]);
  // The filter line opens at once: a key right behind `/` in the same burst is
  // already filter text, before the render that shows the line.
  const [filtering, setFilteringState] = useState(false);
  const filteringNow = useRef(false);
  const setFiltering = (open: boolean) => {
    filteringNow.current = open;
    setFilteringState(open);
  };
  const capacity = Math.max(1, height - 2);

  useEffect(() => {
    if (state.collection.capacity !== capacity) onAction({ type: 'resize', capacity });
  }, [capacity, onAction, state.collection.capacity]);
  useEffect(() => {
    if (active) return;
    filteringNow.current = false;
    setFilteringState(false);
  }, [active]);

  const delivered = useRef(state.activation?.serial ?? 0);
  useEffect(() => {
    const activation = state.activation;
    if (!activation || activation.serial === delivered.current) return;
    delivered.current = activation.serial;
    const row = state.rows.find(({ key }) => key === activation.key);
    if (row) onActivate?.(row);
  }, [state.activation, state.rows, onActivate]);

  useTerminalKeyboard(
    (key) => {
      if (!filteringNow.current) return false;
      const edit = terminalTextEdit(key);
      if (edit === null) return false;
      if (edit.kind !== 'commit') onAction({ type: 'filter-edit', edit });
      if (edit.kind === 'commit' || edit.kind === 'clear') setFiltering(false);
      return true;
    },
    { active, priority: TerminalKeyPriority.input },
  );
  useTerminalKeyboard(
    (key) => {
      if (filteringNow.current) return false;
      const result = terminalTableKey(state, key, bindings);
      if (result === null) return false;
      if (result.kind === 'filter-start') setFiltering(true);
      else if (result.kind === 'activate') onAction({ type: 'activate' });
      else onAction(result.action);
      return true;
    },
    { active },
  );

  const widths = layoutTerminalTableColumns(state.columns, width);
  const columns = state.columns
    .map((column, index) => ({ column, width: widths[index]?.width ?? 0 }))
    .filter(({ width }) => width > 0);
  // Until the resize lands, the first frame still draws no more rows than fit.
  const rows = visibleTerminalTableRows(state).slice(0, capacity);
  const blank = Math.max(0, capacity - rows.length);
  const count = labels.rows(state.view.length, state.rows.length);
  const footer = filtering
    ? `/${sanitizeTerminalText(state.filter)}▏`
    : state.filter
      ? `${labels.filter}: ${sanitizeTerminalText(state.filter)}  ·  ${count}`
      : count;

  return (
    <box style={{ flexDirection: 'column', width, height }}>
      <text fg={palette.muted} wrapMode='none'>
        {columns.map(({ column, width }, index) => {
          const mark =
            state.sort?.columnId === column.id
              ? state.sort.direction === 'asc'
                ? '▲'
                : '▼'
              : '';
          const align = column.align ?? (column.kind === 'number' ? 'right' : 'left');
          return (
            <span
              key={column.id}
              fg={mark ? palette.accent : palette.muted}
            >{`${index === 0 ? '' : ' '}${fitTerminalText(column.title + mark, width, align)}`}</span>
          );
        })}
      </text>
      {rows.map((view, slot) => {
        const selected = view.row.key === state.collection.selectedKey;
        // An ancestor shown only for a filter match stays muted, whatever its state.
        const rowTone = view.matched ? view.row.tone : undefined;
        const tone = rowTone
          ? palette[rowTone]
          : (selected && active) || view.matched
            ? palette.primary
            : palette.muted;
        return (
          <text
            key={slot}
            fg={tone}
            {...(selected && { bg: palette.panelRaised })}
            wrapMode='none'
          >
            {columns.map(({ column, width }, index) => {
              const align = column.align ?? (column.kind === 'number' ? 'right' : 'left');
              const prefix = index === 0 ? terminalTableTreePrefix(view) : '';
              const text = formatTerminalTableCell(column, view.row.cells[column.id] ?? null);
              const cell =
                index === 0
                  ? fitTerminalText(prefix + text, width, align)
                  : ` ${fitTerminalText(text, width, align)}`;
              const value = view.row.cells[column.id] ?? null;
              const missing = value === null;
              const cellTone =
                missing || !view.matched ? undefined : column.tone?.(value, view.row);
              const fg = cellTone
                ? palette[cellTone]
                : missing && !selected
                  ? palette.muted
                  : undefined;
              return (
                <span
                  key={column.id}
                  {...(fg && { fg })}
                  attributes={terminalToneAttributes(cellTone ?? rowTone)}
                >
                  {cell}
                </span>
              );
            })}
          </text>
        );
      })}
      {blank > 0 && <box style={{ height: blank }} />}
      <text fg={filtering ? palette.accent : palette.muted} wrapMode='none'>
        {fitTerminalText(footer, width, 'left')}
      </text>
    </box>
  );
}
