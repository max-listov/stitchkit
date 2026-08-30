import { z } from 'zod';

export const TerminalPaneIdSchema = z.enum(['primary', 'secondary']);
export const TerminalPaneModeSchema = z.enum(['split', 'single']);

export const TerminalPaneStateSchema = z
  .object({
    mode: TerminalPaneModeSchema,
    focus: TerminalPaneIdSchema,
    primarySize: z.int().positive(),
    totalSize: z.int().positive(),
    minPrimary: z.int().positive(),
    minSecondary: z.int().positive(),
  })
  .strict();

export type TerminalPaneId = z.infer<typeof TerminalPaneIdSchema>;
export type TerminalPaneState = z.infer<typeof TerminalPaneStateSchema>;

export type TerminalPaneAction =
  | { type: 'focus'; pane: TerminalPaneId }
  | { type: 'toggle-focus' }
  | { type: 'resize'; primarySize: number }
  | { type: 'terminal-resize'; totalSize: number }
  | { type: 'mode'; mode: 'split' | 'single' };

function clampPrimary(input: {
  primarySize: number;
  totalSize: number;
  minPrimary: number;
  minSecondary: number;
}): number {
  const maximum = Math.max(input.minPrimary, input.totalSize - input.minSecondary);
  return Math.min(Math.max(input.minPrimary, input.primarySize), maximum);
}
export function createTerminalPaneState(input: {
  totalSize: number;
  primarySize: number;
  minPrimary: number;
  minSecondary: number;
  mode?: 'split' | 'single';
  focus?: TerminalPaneId;
}): TerminalPaneState {
  const values = z
    .object({
      totalSize: z.int().positive(),
      primarySize: z.int().positive(),
      minPrimary: z.int().positive(),
      minSecondary: z.int().positive(),
      mode: TerminalPaneModeSchema.default('split'),
      focus: TerminalPaneIdSchema.default('primary'),
    })
    .strict()
    .parse(input);
  if (values.mode === 'split' && values.totalSize < values.minPrimary + values.minSecondary) {
    throw new Error('Split terminal panes do not fit within the total size');
  }
  return TerminalPaneStateSchema.parse({
    ...values,
    primarySize: clampPrimary(values),
  });
}

export function reduceTerminalPaneState(
  state: TerminalPaneState,
  action: TerminalPaneAction,
): TerminalPaneState {
  const current = TerminalPaneStateSchema.parse(state);
  if (action.type === 'focus') return { ...current, focus: action.pane };
  if (action.type === 'toggle-focus') {
    return { ...current, focus: current.focus === 'primary' ? 'secondary' : 'primary' };
  }
  if (action.type === 'mode') {
    if (
      action.mode === 'split' &&
      current.totalSize < current.minPrimary + current.minSecondary
    ) {
      throw new Error('Split terminal panes do not fit within the total size');
    }
    return { ...current, mode: action.mode };
  }
  const totalSize = action.type === 'terminal-resize' ? action.totalSize : current.totalSize;
  const mode =
    current.mode === 'split' && totalSize < current.minPrimary + current.minSecondary
      ? 'single'
      : current.mode;
  const primarySize = action.type === 'resize' ? action.primarySize : current.primarySize;
  return TerminalPaneStateSchema.parse({
    ...current,
    totalSize,
    mode,
    primarySize: clampPrimary({
      primarySize,
      totalSize,
      minPrimary: current.minPrimary,
      minSecondary: current.minSecondary,
    }),
  });
}

export function visibleTerminalPanes(state: TerminalPaneState): readonly TerminalPaneId[] {
  const parsed = TerminalPaneStateSchema.parse(state);
  return parsed.mode === 'split' ? ['primary', 'secondary'] : [parsed.focus];
}
