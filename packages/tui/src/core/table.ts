import { z } from 'zod';
import {
  createTerminalCollection,
  reduceTerminalCollection,
  type TerminalCollectionAction,
  type TerminalCollectionState,
} from './collection';
import { applyTerminalTextEdit, sanitizeTerminalText, type TerminalTextEdit } from './text';
import { type TerminalTone, TerminalToneSchema } from './theme';

export const TerminalTableColumnSchema = z
  .object({
    id: z.string().min(1),
    title: z.string(),
    /** What the cells hold: numbers sort numerically, text by a numeric-aware collation. */
    kind: z.enum(['number', 'text']),
    /** A fixed width in cells, or a share of what fixed columns leave. */
    width: z.union([z.int().positive(), z.object({ flex: z.int().positive() }).strict()]),
    /** Numbers default to the right, text to the left. */
    align: z.enum(['left', 'right']).optional(),
    sortable: z.boolean().default(true),
    /** Whether the filter searches this column's displayed text; text columns default to yes. */
    filterable: z.boolean().optional(),
  })
  .strict();

export type TerminalTableCellValue = string | number | null;

/** What a column says about one of its cells: the tone it is drawn in, or none for the row's. */
export type TerminalTableCellTone = (
  value: TerminalTableCellValue,
  row: TerminalTableRow,
) => TerminalTone | undefined;

/**
 * A column; `format` turns a present value into the text a reader sees and the
 * filter searches, and `tone` colours a cell by its value — a `fail` status in
 * `danger` — over the row's tone.
 */
export type TerminalTableColumn = z.input<typeof TerminalTableColumnSchema> & {
  format?: (value: string | number) => string;
  tone?: TerminalTableCellTone;
};

type ParsedColumn = z.output<typeof TerminalTableColumnSchema> & {
  format?: (value: string | number) => string;
  tone?: TerminalTableCellTone;
};

export const TerminalTableRowSchema = z
  .object({
    key: z.string().min(1),
    /** The row this one is a child of; an unknown parent makes it a root. */
    parentKey: z.string().min(1).nullable().default(null),
    /** One value per column id; `null` is "not measured" and shows as `—`. */
    cells: z.record(z.string(), z.union([z.string(), z.number(), z.null()])),
    /** The state of the whole row in colour: a stopped process `muted`, a failed one `danger`. */
    tone: TerminalToneSchema.optional(),
  })
  .strict();

export type TerminalTableRow = z.output<typeof TerminalTableRowSchema>;
export type TerminalTableRowInput = z.input<typeof TerminalTableRowSchema>;

export const TerminalTableSortSchema = z
  .object({ columnId: z.string().min(1), direction: z.enum(['asc', 'desc']) })
  .strict();

export type TerminalTableSort = z.infer<typeof TerminalTableSortSchema>;

/** One visible line of the table, in display order. */
export interface TerminalTableViewRow {
  row: TerminalTableRow;
  depth: number;
  hasChildren: boolean;
  expanded: boolean;
  /** Matched the filter itself, rather than shown as the ancestor of a match. */
  matched: boolean;
}

export interface TerminalTableState {
  readonly columns: readonly ParsedColumn[];
  readonly rows: readonly TerminalTableRow[];
  readonly sort: TerminalTableSort | null;
  /** Expanded row keys; only keys present in `rows` are kept. */
  readonly expanded: ReadonlySet<string>;
  readonly filter: string;
  /** The projection of rows, sort, tree and filter that the screen shows. */
  readonly view: readonly TerminalTableViewRow[];
  /** Selection and scroll window over `view`, keyed by row key. */
  readonly collection: TerminalCollectionState;
  /** The last row activated, numbered so a widget delivers each activation once. */
  readonly activation: { key: string; serial: number } | null;
}

export type TerminalTableAction =
  | { type: 'rows'; rows: readonly TerminalTableRowInput[] }
  | { type: 'sort'; columnId: string; direction?: 'asc' | 'desc' }
  | { type: 'sort-next'; delta: number }
  | { type: 'sort-invert' }
  | { type: 'expand'; key?: string }
  | { type: 'collapse'; key?: string }
  | { type: 'toggle'; key?: string }
  | { type: 'filter'; query: string }
  | { type: 'filter-edit'; edit: TerminalTextEdit }
  | { type: 'activate' }
  | Exclude<TerminalCollectionAction, { type: 'reconcile' }>;

const collator = new Intl.Collator(undefined, { numeric: true, sensitivity: 'base' });

function parseColumns(columns: readonly TerminalTableColumn[]): ParsedColumn[] {
  if (columns.length === 0) throw new Error('A terminal table needs at least one column');
  const parsed = columns.map((column) => {
    const { format, tone, ...shape } = column;
    const value = TerminalTableColumnSchema.parse(shape);
    return {
      ...value,
      ...(format !== undefined && { format }),
      ...(tone !== undefined && { tone }),
    };
  });
  if (new Set(parsed.map(({ id }) => id)).size !== parsed.length) {
    throw new Error('Terminal table column ids must be unique');
  }
  return parsed;
}

function parseRows(
  columns: readonly ParsedColumn[],
  rows: readonly TerminalTableRowInput[],
): TerminalTableRow[] {
  const parsed = z.array(TerminalTableRowSchema).parse(rows);
  const byKey = new Map<string, TerminalTableRow>();
  for (const row of parsed) {
    if (byKey.has(row.key))
      throw new Error(`Terminal table row keys must be unique: ${row.key}`);
    byKey.set(row.key, row);
    for (const column of columns) {
      if (!(column.id in row.cells)) {
        throw new Error(`Terminal table row ${row.key} has no cell for column ${column.id}`);
      }
      const value = row.cells[column.id];
      if (
        value !== null &&
        typeof value !== (column.kind === 'number' ? 'number' : 'string')
      ) {
        throw new Error(
          `Terminal table row ${row.key} holds a ${typeof value} in ${column.kind} column ${column.id}`,
        );
      }
    }
  }
  for (const row of parsed) {
    const seen = new Set([row.key]);
    for (let parent = row.parentKey; parent !== null; ) {
      if (seen.has(parent))
        throw new Error(`Terminal table rows form a cycle through ${parent}`);
      seen.add(parent);
      parent = byKey.get(parent)?.parentKey ?? null;
    }
  }
  return parsed;
}

/** The text a reader sees in a cell: `—` for a missing value, `format` otherwise. */
export function formatTerminalTableCell(
  column: Pick<TerminalTableColumn, 'format'>,
  value: TerminalTableCellValue,
): string {
  if (value === null) return '—';
  // Cell text is data: a process name or a log line may carry escapes or newlines.
  return sanitizeTerminalText(column.format ? column.format(value) : String(value)).replace(
    /\n/g,
    ' ',
  );
}

function sortColumn(state: Pick<TerminalTableState, 'columns' | 'sort'>): ParsedColumn | null {
  if (state.sort === null) return null;
  return state.columns.find(({ id }) => id === state.sort?.columnId) ?? null;
}

function compareRows(
  column: ParsedColumn | null,
  direction: 'asc' | 'desc',
): (a: TerminalTableRow, b: TerminalTableRow) => number {
  return (a, b) => {
    if (column !== null) {
      const left = a.cells[column.id] ?? null;
      const right = b.cells[column.id] ?? null;
      // A missing value is last whichever way the column sorts.
      if (left === null && right !== null) return 1;
      if (right === null && left !== null) return -1;
      if (left !== null && right !== null) {
        const order =
          typeof left === 'number' && typeof right === 'number'
            ? left - right
            : collator.compare(String(left), String(right));
        if (order !== 0) return direction === 'asc' ? order : -order;
      }
    }
    // Equal values keep one order between ticks, so rows never trade places at rest.
    return a.key < b.key ? -1 : a.key > b.key ? 1 : 0;
  };
}

/** Rows in display order: sorted among siblings, children under expanded parents, filtered. */
export function projectTerminalTable(
  state: Pick<TerminalTableState, 'columns' | 'rows' | 'sort' | 'expanded' | 'filter'>,
): TerminalTableViewRow[] {
  const keys = new Set(state.rows.map(({ key }) => key));
  const children = new Map<string | null, TerminalTableRow[]>();
  for (const row of state.rows) {
    const parent = row.parentKey !== null && keys.has(row.parentKey) ? row.parentKey : null;
    const siblings = children.get(parent);
    if (siblings) siblings.push(row);
    else children.set(parent, [row]);
  }
  const compare = compareRows(sortColumn(state), state.sort?.direction ?? 'asc');
  for (const siblings of children.values()) siblings.sort(compare);

  const query = state.filter.trim().toLocaleLowerCase();
  const matched = new Set<string>();
  const shown = new Set<string>();
  if (query !== '') {
    const searched = state.columns.filter(
      (column) => column.filterable ?? column.kind === 'text',
    );
    const byKey = new Map(state.rows.map((row) => [row.key, row]));
    for (const row of state.rows) {
      const hit = searched.some((column) =>
        formatTerminalTableCell(column, row.cells[column.id] ?? null)
          .toLocaleLowerCase()
          .includes(query),
      );
      if (!hit) continue;
      matched.add(row.key);
      for (let key: string | null = row.key; key !== null && !shown.has(key); ) {
        shown.add(key);
        const parent: string | null = byKey.get(key)?.parentKey ?? null;
        key = parent !== null && keys.has(parent) ? parent : null;
      }
    }
  }

  const view: TerminalTableViewRow[] = [];
  const visit = (parent: string | null, depth: number): void => {
    for (const row of children.get(parent) ?? []) {
      if (query !== '' && !shown.has(row.key)) continue;
      const hasChildren = (children.get(row.key) ?? []).some(
        (child) => query === '' || shown.has(child.key),
      );
      // While filtering, ancestors of a match open without touching what the reader expanded.
      const expanded = hasChildren && (query !== '' || state.expanded.has(row.key));
      view.push({
        row,
        depth,
        hasChildren,
        expanded,
        matched: query === '' || matched.has(row.key),
      });
      if (expanded) visit(row.key, depth + 1);
    }
  };
  visit(null, 0);
  return view;
}

function withView(
  state: Omit<TerminalTableState, 'view' | 'collection' | 'activation'> &
    Partial<Pick<TerminalTableState, 'activation'>>,
  collection: TerminalCollectionState,
  /** Where the selection goes when its own row left the view. */
  fallback?: string,
): TerminalTableState {
  const view = projectTerminalTable(state);
  const keys = view.map(({ row }) => row.key);
  const lost = collection.selectedKey !== null && !keys.includes(collection.selectedKey);
  let next = reduceTerminalCollection(collection, { type: 'reconcile', keys });
  if (lost && fallback !== undefined && keys.includes(fallback)) {
    next = reduceTerminalCollection(next, { type: 'select', key: fallback });
  }
  return { ...state, activation: state.activation ?? null, view, collection: next };
}

export function createTerminalTable(input: {
  columns: readonly TerminalTableColumn[];
  rows?: readonly TerminalTableRowInput[];
  /** Visible rows; the renderer resizes it to the space it has. */
  capacity: number;
  sort?: TerminalTableSort | null;
  expanded?: readonly string[];
}): TerminalTableState {
  const columns = parseColumns(input.columns);
  const rows = parseRows(columns, input.rows ?? []);
  const sort = input.sort ? TerminalTableSortSchema.parse(input.sort) : null;
  if (sort && !columns.some(({ id, sortable }) => id === sort.columnId && sortable)) {
    throw new Error(`Terminal table cannot sort by column ${sort.columnId}`);
  }
  const keys = new Set(rows.map(({ key }) => key));
  return withView(
    {
      columns,
      rows,
      sort,
      expanded: new Set((input.expanded ?? []).filter((key) => keys.has(key))),
      filter: '',
    },
    createTerminalCollection([], input.capacity),
  );
}

function selectedRow(state: TerminalTableState, key?: string): TerminalTableViewRow | null {
  const target = key ?? state.collection.selectedKey;
  return state.view.find(({ row }) => row.key === target) ?? null;
}

export function reduceTerminalTable(
  state: TerminalTableState,
  action: TerminalTableAction,
): TerminalTableState {
  const { collection } = state;
  const base = {
    columns: state.columns,
    rows: state.rows,
    sort: state.sort,
    expanded: state.expanded,
    filter: state.filter,
    activation: state.activation,
  };
  switch (action.type) {
    case 'rows': {
      const rows = parseRows(base.columns, action.rows);
      const keys = new Set(rows.map(({ key }) => key));
      const expanded = new Set([...base.expanded].filter((key) => keys.has(key)));
      return withView({ ...base, rows, expanded }, collection);
    }
    case 'sort': {
      const column = base.columns.find(({ id }) => id === action.columnId);
      if (!column?.sortable)
        throw new Error(`Terminal table cannot sort by column ${action.columnId}`);
      const direction =
        action.direction ??
        (base.sort?.columnId === column.id
          ? base.sort.direction === 'asc'
            ? 'desc'
            : 'asc'
          : column.kind === 'number'
            ? 'desc'
            : 'asc');
      return withView({ ...base, sort: { columnId: column.id, direction } }, collection);
    }
    case 'sort-next': {
      const sortable = base.columns.filter(({ sortable }) => sortable);
      if (sortable.length === 0) return state;
      const index = sortable.findIndex(({ id }) => id === base.sort?.columnId);
      const step = z.int().parse(action.delta);
      const next =
        sortable[
          ((((index < 0 ? (step > 0 ? -1 : 0) : index) + step) % sortable.length) +
            sortable.length) %
            sortable.length
        ];
      if (!next) return state;
      return withView(
        {
          ...base,
          sort: { columnId: next.id, direction: next.kind === 'number' ? 'desc' : 'asc' },
        },
        collection,
      );
    }
    case 'sort-invert': {
      if (base.sort === null) return state;
      return withView(
        {
          ...base,
          sort: { ...base.sort, direction: base.sort.direction === 'asc' ? 'desc' : 'asc' },
        },
        collection,
      );
    }
    case 'expand':
    case 'collapse':
    case 'toggle': {
      const target = selectedRow(state, action.key);
      // While a filter is on, every ancestor of a match is open by the filter;
      // the reader's own expansion waits, untouched, until the filter is cleared.
      if (target === null || state.filter.trim() !== '') return state;
      const open =
        action.type === 'expand'
          ? true
          : action.type === 'collapse'
            ? false
            : !target.expanded;
      if (!target.hasChildren || target.expanded === open) {
        // Left on a leaf or a closed row climbs to its parent, as in htop's tree view.
        if (action.type === 'collapse' && action.key === undefined && target.row.parentKey) {
          const parent = state.view.find(({ row }) => row.key === target.row.parentKey);
          if (parent) {
            return {
              ...state,
              collection: reduceTerminalCollection(collection, {
                type: 'select',
                key: parent.row.key,
              }),
            };
          }
        }
        return state;
      }
      const expanded = new Set(base.expanded);
      if (open) expanded.add(target.row.key);
      else expanded.delete(target.row.key);
      // Collapsing over the selection moves it to the row closed, not to a stranger.
      return withView({ ...base, expanded }, collection, open ? undefined : target.row.key);
    }
    case 'filter':
      return withView({ ...base, filter: z.string().parse(action.query) }, collection);
    case 'activate': {
      const key = state.collection.selectedKey;
      if (key === null) return state;
      return { ...state, activation: { key, serial: (state.activation?.serial ?? 0) + 1 } };
    }
    case 'filter-edit': {
      const filter = applyTerminalTextEdit(state.filter, action.edit);
      return filter === state.filter ? state : withView({ ...base, filter }, collection);
    }
    default:
      return { ...state, collection: reduceTerminalCollection(collection, action) };
  }
}

/** The rows inside the scroll window, the only ones a renderer draws. */
export function visibleTerminalTableRows(state: TerminalTableState): TerminalTableViewRow[] {
  const { start, capacity } = state.collection;
  return state.view.slice(start, start + capacity);
}

export function selectedTerminalTableRow(state: TerminalTableState): TerminalTableRow | null {
  return selectedRow(state)?.row ?? null;
}

/** Cell widths for the columns in `width` cells, `gap` cells apart; a column that does not fit gets 0. */
export function layoutTerminalTableColumns(
  columns: readonly Pick<TerminalTableColumn, 'id' | 'width'>[],
  width: number,
  gap = 1,
): { id: string; width: number }[] {
  const total = z.int().nonnegative().parse(width);
  let remaining = total;
  const widths = columns.map((column, index) => {
    if (typeof column.width !== 'number') return { id: column.id, width: 0 };
    const needed = column.width + (index === 0 ? 0 : gap);
    // A fixed column that does not fit is hidden and leaves its space to the rest.
    if (needed > remaining) return { id: column.id, width: 0 };
    remaining -= needed;
    return { id: column.id, width: column.width };
  });
  const flexible = columns
    .map((column, index) => ({ column, index }))
    .filter(({ column }) => typeof column.width !== 'number');
  const gaps = flexible.filter(({ index }) => index > 0).length * gap;
  const share = Math.max(0, remaining - gaps);
  const weights = flexible.reduce(
    (sum, { column }) => sum + (typeof column.width === 'number' ? 0 : column.width.flex),
    0,
  );
  let given = 0;
  flexible.forEach(({ column, index }, position) => {
    if (typeof column.width === 'number') return;
    const cells =
      position === flexible.length - 1
        ? share - given
        : Math.floor((share * column.width.flex) / Math.max(1, weights));
    given += cells;
    widths[index] = { id: column.id, width: Math.max(0, cells) };
  });
  return widths;
}

/** The indent and disclosure mark in front of a tree row's first cell. */
export function terminalTableTreePrefix(row: TerminalTableViewRow): string {
  const mark = row.hasChildren ? (row.expanded ? '▾ ' : '▸ ') : '  ';
  return '  '.repeat(row.depth) + mark;
}
