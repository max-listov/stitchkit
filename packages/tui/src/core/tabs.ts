import { z } from 'zod';

export const TerminalTabSchema = z
  .object({
    id: z.string().min(1),
    label: z.string().min(1),
    /** A count shown beside the label; `null` shows none. */
    badge: z.int().nonnegative().nullable().default(null),
  })
  .strict();

export type TerminalTab = z.infer<typeof TerminalTabSchema>;

export const TerminalTabsStateSchema = z
  .object({
    tabs: z.array(TerminalTabSchema).min(1),
    selectedId: z.string().min(1),
  })
  .strict();

export type TerminalTabsState = z.infer<typeof TerminalTabsStateSchema>;

export type TerminalTabsAction =
  | { type: 'select'; id: string }
  | { type: 'select-index'; index: number }
  | { type: 'move'; delta: number }
  | { type: 'badge'; id: string; badge: number | null }
  | { type: 'reconcile'; tabs: readonly z.input<typeof TerminalTabSchema>[] };

function parseTabs(tabs: readonly z.input<typeof TerminalTabSchema>[]): TerminalTab[] {
  const parsed = z.array(TerminalTabSchema).min(1).parse(tabs);
  if (new Set(parsed.map(({ id }) => id)).size !== parsed.length) {
    throw new Error('Terminal tab ids must be unique');
  }
  return parsed;
}

export function createTerminalTabs(
  tabs: readonly z.input<typeof TerminalTabSchema>[],
  selectedId?: string,
): TerminalTabsState {
  const parsed = parseTabs(tabs);
  const selected = parsed.find(({ id }) => id === selectedId) ?? parsed[0];
  if (!selected) throw new Error('Terminal tabs need at least one tab');
  return { tabs: parsed, selectedId: selected.id };
}

export function reduceTerminalTabs(
  state: TerminalTabsState,
  action: TerminalTabsAction,
): TerminalTabsState {
  const current = TerminalTabsStateSchema.parse(state);
  const index = current.tabs.findIndex(({ id }) => id === current.selectedId);
  if (action.type === 'select') {
    if (!current.tabs.some(({ id }) => id === action.id)) {
      throw new Error(`Unknown terminal tab: ${action.id}`);
    }
    return { ...current, selectedId: action.id };
  }
  if (action.type === 'select-index') {
    // A digit key past the last tab does nothing rather than failing the keypress.
    const tab = current.tabs[action.index];
    return tab ? { ...current, selectedId: tab.id } : current;
  }
  if (action.type === 'move') {
    const count = current.tabs.length;
    const next = current.tabs[(((index + action.delta) % count) + count) % count];
    return next ? { ...current, selectedId: next.id } : current;
  }
  if (action.type === 'badge') {
    if (!current.tabs.some(({ id }) => id === action.id)) {
      throw new Error(`Unknown terminal tab: ${action.id}`);
    }
    const badge = z.int().nonnegative().nullable().parse(action.badge);
    return {
      ...current,
      tabs: current.tabs.map((tab) => (tab.id === action.id ? { ...tab, badge } : tab)),
    };
  }
  const tabs = parseTabs(action.tabs);
  const survivor =
    tabs.find(({ id }) => id === current.selectedId) ??
    tabs[Math.min(Math.max(0, index), tabs.length - 1)];
  if (!survivor) throw new Error('Terminal tabs need at least one tab');
  return { tabs, selectedId: survivor.id };
}

export function selectedTerminalTab(state: TerminalTabsState): TerminalTab {
  const tab = state.tabs.find(({ id }) => id === state.selectedId);
  if (!tab) throw new Error(`Terminal tab selection is unavailable: ${state.selectedId}`);
  return tab;
}
