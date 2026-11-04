import { z } from 'zod';

/**
 * A stack of screens. Each level keeps the state its screen had — selection,
 * query, scroll — so going back lands where the reader was, not at the top.
 */
export interface TerminalNavigationEntry<STATE = unknown> {
  readonly id: string;
  readonly label: string;
  readonly state: STATE;
}

export interface TerminalNavigationState<STATE = unknown> {
  readonly stack: readonly TerminalNavigationEntry<STATE>[];
}

export type TerminalNavigationAction<STATE = unknown> =
  | { type: 'push'; entry: TerminalNavigationEntry<STATE> }
  | { type: 'pop' }
  | { type: 'replace'; entry: TerminalNavigationEntry<STATE> }
  | { type: 'update'; state: STATE }
  | { type: 'reset'; entry: TerminalNavigationEntry<STATE> };

const EntrySchema = z.object({ id: z.string().min(1), label: z.string().min(1) }).loose();

export function createTerminalNavigation<STATE>(
  root: TerminalNavigationEntry<STATE>,
): TerminalNavigationState<STATE> {
  EntrySchema.parse(root);
  return { stack: [root] };
}

export function reduceTerminalNavigation<STATE>(
  state: TerminalNavigationState<STATE>,
  action: TerminalNavigationAction<STATE>,
): TerminalNavigationState<STATE> {
  switch (action.type) {
    case 'push':
      EntrySchema.parse(action.entry);
      return { stack: [...state.stack, action.entry] };
    case 'pop':
      // The root stays: back from the first screen is the application's exit decision.
      return state.stack.length > 1 ? { stack: state.stack.slice(0, -1) } : state;
    case 'replace':
      EntrySchema.parse(action.entry);
      return { stack: [...state.stack.slice(0, -1), action.entry] };
    case 'update': {
      const top = state.stack.at(-1);
      if (!top) return state;
      return { stack: [...state.stack.slice(0, -1), { ...top, state: action.state }] };
    }
    case 'reset':
      EntrySchema.parse(action.entry);
      return { stack: [action.entry] };
  }
}

export function currentTerminalScreen<STATE>(
  state: TerminalNavigationState<STATE>,
): TerminalNavigationEntry<STATE> {
  const top = state.stack.at(-1);
  if (!top) throw new Error('Terminal navigation stack is empty');
  return top;
}

/** `Base / Methods / content_document`: every label from the root to the current screen. */
export function terminalBreadcrumbs(state: TerminalNavigationState<unknown>): string[] {
  return state.stack.map(({ label }) => label);
}
