import { z } from 'zod';

export const AgentTuiComposerSchema = z
  .object({
    draft: z.string(),
    history: z.array(z.string()),
    historyIndex: z.int().nonnegative().optional(),
    preservedDraft: z.string(),
  })
  .strict();

export type AgentTuiComposer = z.infer<typeof AgentTuiComposerSchema>;

export function createAgentTuiComposer(): AgentTuiComposer {
  return { draft: '', history: [], preservedDraft: '' };
}

export function setAgentTuiDraft(state: AgentTuiComposer, draft: string): AgentTuiComposer {
  const { historyIndex: _historyIndex, ...rest } = state;
  return { ...rest, draft, preservedDraft: draft };
}

export function submitAgentTuiComposer(state: AgentTuiComposer): {
  state: AgentTuiComposer;
  text?: string;
} {
  const text = state.draft.trim();
  if (!text) return { state };
  const history = state.history.at(-1) === text ? state.history : [...state.history, text];
  return { state: { draft: '', history, preservedDraft: '' }, text };
}

export function navigateAgentTuiHistory(
  state: AgentTuiComposer,
  direction: 'older' | 'newer',
): AgentTuiComposer {
  if (state.history.length === 0) return state;
  if (direction === 'older') {
    const index =
      state.historyIndex === undefined
        ? state.history.length - 1
        : Math.max(0, state.historyIndex - 1);
    return { ...state, historyIndex: index, draft: state.history[index] ?? state.draft };
  }
  if (state.historyIndex === undefined) return state;
  const index = state.historyIndex + 1;
  if (index >= state.history.length) {
    const { historyIndex: _historyIndex, ...rest } = state;
    return { ...rest, draft: state.preservedDraft };
  }
  return { ...state, historyIndex: index, draft: state.history[index] ?? state.draft };
}
