import { z } from 'zod';

/**
 * Which widget answers the keyboard. Widgets are named in a ring that Tab walks;
 * a dialog takes focus by opening a layer and gives it back, to the widget that
 * had it, when the layer closes.
 */
export interface TerminalFocusState {
  readonly order: readonly string[];
  readonly focused: string | null;
  /** Focus to return to when each open layer closes, innermost last. */
  readonly layers: readonly { id: string; returnTo: string | null }[];
}

export type TerminalFocusAction =
  | { type: 'order'; order: readonly string[] }
  | { type: 'focus'; id: string }
  | { type: 'move'; delta: number }
  | { type: 'open-layer'; id: string }
  | { type: 'close-layer'; id?: string };

export function createTerminalFocus(
  order: readonly string[],
  focused?: string,
): TerminalFocusState {
  const ids = z.array(z.string().min(1)).parse(order);
  if (new Set(ids).size !== ids.length) throw new Error('Terminal focus ids must be unique');
  return {
    order: ids,
    focused: focused !== undefined && ids.includes(focused) ? focused : (ids[0] ?? null),
    layers: [],
  };
}

export function reduceTerminalFocus(
  state: TerminalFocusState,
  action: TerminalFocusAction,
): TerminalFocusState {
  switch (action.type) {
    case 'order': {
      const next = createTerminalFocus(action.order, state.focused ?? undefined);
      if (state.layers.length === 0) return next;
      // An open layer keeps focus; each layer returns to a widget that still exists.
      const survivor = (id: string | null): string | null =>
        id !== null && next.order.includes(id) ? id : (next.order[0] ?? null);
      return {
        ...next,
        focused: state.focused,
        layers: state.layers.map((layer) => ({
          ...layer,
          returnTo: survivor(layer.returnTo),
        })),
      };
    }
    case 'focus':
      if (state.layers.length > 0) return state;
      if (!state.order.includes(action.id))
        throw new Error(`Unknown terminal focus id: ${action.id}`);
      return { ...state, focused: action.id };
    case 'move': {
      if (state.layers.length > 0 || state.order.length === 0) return state;
      const index = state.focused === null ? -1 : state.order.indexOf(state.focused);
      const count = state.order.length;
      const next = state.order[(((index + action.delta) % count) + count) % count];
      return next === undefined ? state : { ...state, focused: next };
    }
    case 'open-layer':
      return {
        ...state,
        focused: action.id,
        layers: [...state.layers, { id: action.id, returnTo: state.focused }],
      };
    case 'close-layer': {
      const index =
        action.id === undefined
          ? state.layers.length - 1
          : state.layers.findIndex(({ id }) => id === action.id);
      const layer = state.layers[index];
      if (!layer) return state;
      // Closing an inner layer also closes everything opened above it.
      return { ...state, focused: layer.returnTo, layers: state.layers.slice(0, index) };
    }
  }
}
