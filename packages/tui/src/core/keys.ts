import { defineTerminalKeymap, matchTerminalKey, type TerminalKeyBinding } from './key-hints';
import { type TerminalLabels, terminalLabelsEn } from './labels';
import type { TerminalTableAction, TerminalTableState } from './table';
import type { TerminalTabsAction } from './tabs';

/** The parts of a terminal key event the bindings read. */
export interface TerminalKey {
  name: string;
  shift?: boolean;
  ctrl?: boolean;
  meta?: boolean;
  sequence?: string;
}

/**
 * htop's bindings over a table: arrows and `j`/`k` move, PgUp/PgDn page,
 * Home/End jump, Enter activates, Right/Left (or `+`/`-`) open and close a tree
 * row, `<`/`>` pick the sort column, `I` inverts it and `/` starts a filter.
 * The same list draws the footer hints.
 */
export function terminalTableKeymap(
  labels: TerminalLabels = terminalLabelsEn,
): TerminalKeyBinding[] {
  return defineTerminalKeymap([
    {
      id: 'up',
      keys: ['up', 'k'],
      shift: false,
      display: '↑↓',
      label: labels.move,
      priority: 0,
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
      id: 'activate',
      keys: ['return', 'enter'],
      display: 'Enter',
      label: labels.open,
      priority: 0,
    },
    { id: 'filter', keys: ['/'], display: '/', label: labels.filter, priority: 1 },
    {
      id: 'expand',
      keys: ['right', '+'],
      display: '→←',
      label: `${labels.expand}/${labels.collapse}`,
      short: labels.expand,
      priority: 2,
    },
    {
      id: 'collapse',
      keys: ['left', '-'],
      display: '←',
      label: labels.collapse,
      hidden: true,
    },
    { id: 'sort-next', keys: ['>', '.'], display: '<>', label: labels.sort, priority: 2 },
    { id: 'sort-previous', keys: ['<', ','], display: '<', label: labels.sort, hidden: true },
    { id: 'sort-invert', keys: ['I'], display: 'I', label: labels.invert, priority: 4 },
    { id: 'page-up', keys: ['pageup'], display: 'PgUp/PgDn', label: labels.page, priority: 3 },
    { id: 'page-down', keys: ['pagedown'], display: 'PgDn', label: labels.page, hidden: true },
    { id: 'home', keys: ['home'], display: 'Home', label: labels.top, hidden: true },
    { id: 'end', keys: ['end'], display: 'End', label: labels.bottom, hidden: true },
  ]);
}

export type TerminalTableKeyResult =
  | { kind: 'action'; action: TerminalTableAction }
  | { kind: 'activate' }
  | { kind: 'filter-start' }
  | null;

const defaultTableKeymap = terminalTableKeymap();

export function terminalTableKey(
  state: Pick<TerminalTableState, 'collection'>,
  key: TerminalKey,
  keymap: readonly TerminalKeyBinding[] = defaultTableKeymap,
): TerminalTableKeyResult {
  if (key.meta) return null;
  const binding = matchTerminalKey(keymap, key);
  if (binding === null) return null;
  const page = state.collection.capacity;
  const all = Math.max(1, state.collection.keys.length);
  const act = (action: TerminalTableAction): TerminalTableKeyResult => ({
    kind: 'action',
    action,
  });
  switch (binding.id) {
    case 'up':
      return act({ type: 'move', delta: -1 });
    case 'down':
      return act({ type: 'move', delta: 1 });
    case 'page-up':
      return act({ type: 'move', delta: -page });
    case 'page-down':
      return act({ type: 'move', delta: page });
    case 'home':
      return act({ type: 'move', delta: -all });
    case 'end':
      return act({ type: 'move', delta: all });
    case 'activate':
      return { kind: 'activate' };
    case 'expand':
      return act({ type: 'expand' });
    case 'collapse':
      return act({ type: 'collapse' });
    case 'sort-next':
      return act({ type: 'sort-next', delta: 1 });
    case 'sort-previous':
      return act({ type: 'sort-next', delta: -1 });
    case 'sort-invert':
      return act({ type: 'sort-invert' });
    case 'filter':
      return { kind: 'filter-start' };
    default:
      return null;
  }
}

/** Tab and Shift-Tab cycle tabs; digits 1–9 pick one directly. */
export function terminalTabsKeymap(
  labels: TerminalLabels = terminalLabelsEn,
): TerminalKeyBinding[] {
  return defineTerminalKeymap([
    {
      id: 'next',
      keys: ['tab'],
      shift: false,
      display: 'Tab',
      label: labels.tabs,
      priority: 1,
    },
    {
      id: 'previous',
      keys: ['tab'],
      shift: true,
      display: '⇧Tab',
      label: labels.tabs,
      hidden: true,
    },
    ...Array.from({ length: 9 }, (_, index) => ({
      id: `tab-${index + 1}`,
      keys: [String(index + 1)],
      display: index === 0 ? '1–9' : String(index + 1),
      label: labels.tabs,
      hidden: index > 0,
      priority: 3,
    })),
  ]);
}

const defaultTabsKeymap = terminalTabsKeymap();

export function terminalTabsKey(
  key: TerminalKey,
  keymap: readonly TerminalKeyBinding[] = defaultTabsKeymap,
): TerminalTabsAction | null {
  if (key.meta) return null;
  const binding = matchTerminalKey(keymap, key);
  if (binding === null) return null;
  if (binding.id === 'next') return { type: 'move', delta: 1 };
  if (binding.id === 'previous') return { type: 'move', delta: -1 };
  const digit = /^tab-([1-9])$/.exec(binding.id)?.[1];
  return digit ? { type: 'select-index', index: Number(digit) - 1 } : null;
}
