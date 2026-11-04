import { z } from 'zod';

export const TerminalCollectionStateSchema = z
  .object({
    keys: z.array(z.string().min(1)),
    selectedKey: z.string().min(1).nullable(),
    start: z.int().nonnegative(),
    capacity: z.int().positive(),
  })
  .strict();

export type TerminalCollectionState = z.infer<typeof TerminalCollectionStateSchema>;

export type TerminalCollectionAction =
  | { type: 'reconcile'; keys: readonly string[] }
  | { type: 'select'; key: string }
  | { type: 'move'; delta: number; wrap?: boolean }
  | { type: 'scroll'; lines: number }
  | { type: 'resize'; capacity: number };

function maximumStart(total: number, capacity: number): number {
  return Math.max(0, total - capacity);
}

function reveal(start: number, capacity: number, index: number, total: number): number {
  const bounded = Math.min(Math.max(0, start), maximumStart(total, capacity));
  if (index < bounded) return index;
  if (index >= bounded + capacity) return index - capacity + 1;
  return bounded;
}

function uniqueKeys(keys: readonly string[]): string[] {
  const result = z.array(z.string().min(1)).parse(keys);
  if (new Set(result).size !== result.length) {
    throw new Error('Terminal collection keys must be unique');
  }
  return result;
}

export function createTerminalCollection(
  keys: readonly string[],
  capacity: number,
  selectedKey?: string,
): TerminalCollectionState {
  const parsedKeys = uniqueKeys(keys);
  const parsedCapacity = z.int().positive().parse(capacity);
  const selected =
    selectedKey !== undefined && parsedKeys.includes(selectedKey)
      ? selectedKey
      : (parsedKeys[0] ?? null);
  const index = selected === null ? -1 : parsedKeys.indexOf(selected);
  return TerminalCollectionStateSchema.parse({
    keys: parsedKeys,
    selectedKey: selected,
    start: index < 0 ? 0 : reveal(0, parsedCapacity, index, parsedKeys.length),
    capacity: parsedCapacity,
  });
}

export function reduceTerminalCollection(
  state: TerminalCollectionState,
  action: TerminalCollectionAction,
): TerminalCollectionState {
  // State came out of `create` or this reducer and is typed; only new keys and
  // sizes are validated, so a cursor step over a large collection stays O(1).
  const current = state;
  if (action.type === 'reconcile') {
    const keys = uniqueKeys(action.keys);
    if (keys.length === 0)
      return { keys, selectedKey: null, start: 0, capacity: current.capacity };
    const previousIndex =
      current.selectedKey === null
        ? 0
        : Math.max(0, current.keys.indexOf(current.selectedKey));
    const selectedKey =
      current.selectedKey !== null && keys.includes(current.selectedKey)
        ? current.selectedKey
        : keys[Math.min(previousIndex, keys.length - 1)];
    if (!selectedKey) throw new Error('Terminal collection survivor is unavailable');
    const index = keys.indexOf(selectedKey);
    return {
      ...current,
      keys,
      selectedKey,
      start: reveal(current.start, current.capacity, index, keys.length),
    };
  }
  if (action.type === 'resize') {
    const capacity = z.int().positive().parse(action.capacity);
    const index =
      current.selectedKey === null ? -1 : current.keys.indexOf(current.selectedKey);
    return {
      ...current,
      capacity,
      start: index < 0 ? 0 : reveal(current.start, capacity, index, current.keys.length),
    };
  }
  if (action.type === 'scroll') {
    return {
      ...current,
      start: Math.min(
        Math.max(0, current.start + z.int().parse(action.lines)),
        maximumStart(current.keys.length, current.capacity),
      ),
    };
  }
  if (current.keys.length === 0) return current;
  const currentIndex =
    current.selectedKey === null ? 0 : Math.max(0, current.keys.indexOf(current.selectedKey));
  const nextIndex =
    action.type === 'select'
      ? current.keys.indexOf(action.key)
      : action.wrap
        ? (((currentIndex + action.delta) % current.keys.length) + current.keys.length) %
          current.keys.length
        : Math.min(Math.max(0, currentIndex + action.delta), current.keys.length - 1);
  if (nextIndex < 0) {
    throw new Error(
      action.type === 'select'
        ? `Unknown terminal collection key: ${action.key}`
        : 'Terminal collection movement could not resolve a selection',
    );
  }
  const selectedKey = current.keys[nextIndex];
  if (!selectedKey) throw new Error('Terminal collection selection is unavailable');
  return {
    ...current,
    selectedKey,
    start: reveal(current.start, current.capacity, nextIndex, current.keys.length),
  };
}

export function visibleTerminalCollectionRange(state: TerminalCollectionState): {
  start: number;
  end: number;
} {
  return {
    start: state.start,
    end: Math.min(state.keys.length, state.start + state.capacity),
  };
}
