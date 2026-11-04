import { z } from 'zod';
import {
  createTerminalCollection,
  reduceTerminalCollection,
  type TerminalCollectionState,
} from './collection';
import { searchTerminalItems, type TerminalSearchMatch } from './search';
import { applyTerminalTextEdit, type TerminalTextEdit } from './text';
import { TerminalToneSchema } from './theme';

export const TerminalListItemSchema = z
  .object({
    key: z.string().min(1),
    title: z.string().min(1),
    /** A dim note after the title: a group, a count, a version. */
    meta: z.string().optional(),
    /** Shown for the selected item under the list. */
    description: z.string().optional(),
    /** The section this item is listed under; items without one come first. */
    section: z.string().min(1).optional(),
    /** A count or label at the right edge. */
    badge: z.union([z.string(), z.int()]).optional(),
    tone: TerminalToneSchema.optional(),
    /** Listed, but cannot be activated or picked. */
    disabled: z.boolean().default(false),
    /** Extra text the search reads but the list does not show (aliases, ids). */
    keywords: z.array(z.string()).default([]),
  })
  .strict();

export type TerminalListItem = z.output<typeof TerminalListItemSchema>;
export type TerminalListItemInput = z.input<typeof TerminalListItemSchema>;

/** One line of a list as drawn: a section heading or an item with its match. */
export type TerminalListLine =
  | { kind: 'section'; key: string; title: string; count: number }
  | {
      kind: 'item';
      key: string;
      item: TerminalListItem;
      /** Ranges in `title` to highlight for the current query. */
      titleRanges: [number, number][];
    };

export interface TerminalListState {
  readonly items: readonly TerminalListItem[];
  /** Section order and titles; a section with no visible items is not drawn. */
  readonly sections: readonly { id: string; title: string }[];
  readonly query: string;
  /** Picked keys for a multi-select list; empty for a single choice. */
  readonly picked: ReadonlySet<string>;
  readonly multiple: boolean;
  readonly lines: readonly TerminalListLine[];
  /** Selection over item lines only: a heading is never selected. */
  readonly collection: TerminalCollectionState;
  /**
   * The last item the reader activated, numbered so the same item activated
   * twice is two activations. A widget delivers it once per `serial`.
   */
  readonly activation: { key: string; serial: number } | null;
}

export type TerminalListAction =
  | {
      type: 'items';
      items: readonly TerminalListItemInput[];
      sections?: readonly { id: string; title: string }[];
    }
  | { type: 'query'; query: string }
  | { type: 'query-edit'; edit: TerminalTextEdit }
  | { type: 'move'; delta: number; wrap?: boolean }
  | { type: 'select'; key: string }
  | { type: 'section'; delta: number }
  | { type: 'toggle'; key?: string }
  | { type: 'pick-all'; picked: boolean }
  | { type: 'activate' };

function parseItems(items: readonly TerminalListItemInput[]): TerminalListItem[] {
  const parsed = z.array(TerminalListItemSchema).parse(items);
  const keys = new Set<string>();
  for (const item of parsed) {
    if (keys.has(item.key)) throw new Error(`Terminal list keys must be unique: ${item.key}`);
    keys.add(item.key);
  }
  return parsed;
}

function project(
  state: Pick<TerminalListState, 'items' | 'sections' | 'query'>,
): TerminalListLine[] {
  const searching = state.query.trim() !== '';
  const results = searchTerminalItems(state.items, state.query, (item) =>
    [item.title, item.meta ?? '', item.description ?? '', ...item.keywords].join(' · '),
  );
  const titleMatch = (
    item: TerminalListItem,
    match: TerminalSearchMatch,
  ): [number, number][] => {
    const width = Array.from(item.title).length;
    return match.ranges
      .filter(([start]) => start < width)
      .map(([start, end]): [number, number] => [start, Math.min(end, width)]);
  };
  // While searching, the best matches lead and sections step aside.
  if (searching) {
    return results.map(({ item, match }) => ({
      kind: 'item',
      key: item.key,
      item,
      titleRanges: titleMatch(item, match),
    }));
  }
  const order = new Map(state.sections.map(({ id }, index) => [id, index]));
  const groups = new Map<string | null, TerminalListItem[]>();
  for (const { item } of results) {
    const section = item.section ?? null;
    const group = groups.get(section);
    if (group) group.push(item);
    else groups.set(section, [item]);
  }
  const ids = [...groups.keys()].sort((a, b) => {
    if (a === null) return -1;
    if (b === null) return 1;
    return (
      (order.get(a) ?? Number.MAX_SAFE_INTEGER) - (order.get(b) ?? Number.MAX_SAFE_INTEGER)
    );
  });
  const lines: TerminalListLine[] = [];
  for (const id of ids) {
    const group = groups.get(id) ?? [];
    if (id !== null) {
      const title = state.sections.find((section) => section.id === id)?.title ?? id;
      lines.push({ kind: 'section', key: `§${id}`, title, count: group.length });
    }
    for (const item of group)
      lines.push({ kind: 'item', key: item.key, item, titleRanges: [] });
  }
  return lines;
}

function withLines(
  state: Omit<TerminalListState, 'lines' | 'collection'>,
  collection: TerminalCollectionState,
  /** A changed query starts at its best match; new data keeps the reader's selection. */
  queryChanged = false,
): TerminalListState {
  const lines = project(state);
  const keys = lines.filter((line) => line.kind === 'item').map(({ key }) => key);
  let next = reduceTerminalCollection(collection, { type: 'reconcile', keys });
  if (queryChanged && state.query.trim() !== '' && keys[0] !== undefined) {
    next = reduceTerminalCollection(next, { type: 'select', key: keys[0] });
  }
  return { ...state, lines, collection: next };
}

export function createTerminalList(input: {
  items: readonly TerminalListItemInput[];
  sections?: readonly { id: string; title: string }[];
  multiple?: boolean;
  selectedKey?: string;
}): TerminalListState {
  const items = parseItems(input.items);
  const base = {
    items,
    sections: input.sections ?? [],
    query: '',
    picked: new Set<string>(),
    multiple: input.multiple ?? false,
    activation: null,
  };
  // The collection holds selection only; the drawn window is `visibleTerminalListLines`.
  const state = withLines(base, createTerminalCollection([], 1));
  return input.selectedKey !== undefined && state.collection.keys.includes(input.selectedKey)
    ? {
        ...state,
        collection: reduceTerminalCollection(state.collection, {
          type: 'select',
          key: input.selectedKey,
        }),
      }
    : state;
}

export function reduceTerminalList(
  state: TerminalListState,
  action: TerminalListAction,
): TerminalListState {
  const base = {
    items: state.items,
    sections: state.sections,
    query: state.query,
    picked: state.picked,
    multiple: state.multiple,
    activation: state.activation,
  };
  switch (action.type) {
    case 'items': {
      const items = parseItems(action.items);
      const keys = new Set(items.map(({ key }) => key));
      return withLines(
        {
          ...base,
          items,
          sections: action.sections ?? state.sections,
          picked: new Set([...state.picked].filter((key) => keys.has(key))),
        },
        state.collection,
      );
    }
    case 'query':
    case 'query-edit': {
      const query =
        action.type === 'query'
          ? z.string().parse(action.query)
          : applyTerminalTextEdit(state.query, action.edit);
      return query === state.query
        ? state
        : withLines({ ...base, query }, state.collection, true);
    }
    case 'activate': {
      const item = selectedTerminalListItem(state);
      if (!item || item.disabled) return state;
      return {
        ...state,
        activation: { key: item.key, serial: (state.activation?.serial ?? 0) + 1 },
      };
    }
    case 'section': {
      const items = state.lines.filter((line) => line.kind === 'item');
      const current = items.findIndex(({ key }) => key === state.collection.selectedKey);
      const sectionOf = (index: number): string | undefined => {
        const line = items[index];
        return line?.kind === 'item' ? (line.item.section ?? '') : undefined;
      };
      const here = sectionOf(current);
      let index = current;
      const step = Math.sign(action.delta);
      if (step === 0) return state;
      // Leave the current section, then (going back) rewind to the start of the one reached.
      while (index + step >= 0 && index + step < items.length && sectionOf(index) === here)
        index += step;
      if (step < 0) {
        const target = sectionOf(index);
        while (index - 1 >= 0 && sectionOf(index - 1) === target) index -= 1;
      }
      const key = items[index]?.key;
      return key === undefined
        ? state
        : {
            ...state,
            collection: reduceTerminalCollection(state.collection, { type: 'select', key }),
          };
    }
    case 'toggle': {
      if (!state.multiple) return state;
      const key = action.key ?? state.collection.selectedKey;
      const item = state.items.find((candidate) => candidate.key === key);
      if (!item || item.disabled) return state;
      const picked = new Set(state.picked);
      if (picked.has(item.key)) picked.delete(item.key);
      else picked.add(item.key);
      return { ...state, picked };
    }
    case 'pick-all': {
      if (!state.multiple) return state;
      const visible = state.lines.flatMap((line) =>
        line.kind === 'item' && !line.item.disabled ? [line.key] : [],
      );
      const picked = new Set(state.picked);
      for (const key of visible) {
        if (action.picked) picked.add(key);
        else picked.delete(key);
      }
      return { ...state, picked };
    }
    default:
      return { ...state, collection: reduceTerminalCollection(state.collection, action) };
  }
}

export function selectedTerminalListItem(state: TerminalListState): TerminalListItem | null {
  return state.items.find(({ key }) => key === state.collection.selectedKey) ?? null;
}

/**
 * The lines a list of `height` rows draws: headings are kept with the items
 * under them, and the window follows the selection.
 */
export function visibleTerminalListLines(
  state: TerminalListState,
  height: number,
): { lines: TerminalListLine[]; above: number; below: number } {
  const rows = Math.max(1, height);
  const index = state.lines.findIndex(
    (line) => line.kind === 'item' && line.key === state.collection.selectedKey,
  );
  const anchor = Math.max(0, index);
  let start = Math.max(0, Math.min(anchor - Math.floor(rows / 2), state.lines.length - rows));
  // Show the heading of the selected item's section when it sits just above the window.
  if (start > 0 && state.lines[start - 1]?.kind === 'section' && anchor - start < rows - 1)
    start -= 1;
  const lines = state.lines.slice(start, start + rows);
  return {
    lines,
    above: start,
    below: Math.max(0, state.lines.length - start - lines.length),
  };
}
