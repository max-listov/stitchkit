import type { Instructions } from 'ai';
import { z } from 'zod';
import type { AgentMessage } from './schemas';

export const AgentTokenCountSchema = z.object({
  value: z.int().nonnegative().optional(),
  provenance: z.enum(['measured', 'estimated', 'unavailable']),
});

export type AgentTokenCount = z.infer<typeof AgentTokenCountSchema>;

export interface AgentPromptSectionContext<CONTEXT> {
  context: CONTEXT;
  signal: AbortSignal;
}

export interface AgentPromptSection<CONTEXT> {
  name: string;
  stability: 'stable' | 'dynamic';
  render(input: AgentPromptSectionContext<CONTEXT>): string | Promise<string>;
  estimateTokens?(text: string): AgentTokenCount | Promise<AgentTokenCount>;
}

export interface AgentPromptBudget {
  contextWindow: number;
  reservedOutput: number;
  toolSchemas: AgentTokenCount;
  attachments: AgentTokenCount;
  providerOverhead: AgentTokenCount;
}

export interface ComposedAgentPrompt {
  instructions: Instructions;
  sections: readonly { name: string; stability: 'stable' | 'dynamic'; text: string }[];
  instructionTokens: AgentTokenCount;
  availableHistoryTokens?: number;
  contextDecision: 'fits' | 'requires-compaction' | 'oversized' | 'unavailable';
}

export interface AgentHistoryBudgetDecision {
  messageId: string;
  action: 'kept' | 'removed';
  reason:
    | 'within-budget'
    | 'protected-system'
    | 'protected-recent-turn'
    | 'protected-incomplete-turn'
    | 'oldest-eligible-turn'
    | 'token-count-unavailable'
    | 'superseded';
  tokens: AgentTokenCount;
}

export interface AgentHistoryBudgetResult {
  messages: readonly AgentMessage[];
  decisions: readonly AgentHistoryBudgetDecision[];
  totalTokens: AgentTokenCount;
  outcome: 'fits' | 'truncated' | 'oversized' | 'unavailable';
}

export interface SelectAgentHistoryOptions {
  messages: readonly AgentMessage[];
  availableTokens: number;
  keepRecentTurns?: number;
  estimateMessage(message: AgentMessage): AgentTokenCount | Promise<AgentTokenCount>;
}

interface BudgetTurn {
  messages: readonly AgentMessage[];
  complete: boolean;
  protectedSystem: boolean;
}

function completeTurn(messages: readonly AgentMessage[]): boolean {
  if (messages[0]?.role !== 'user') return false;
  const assistant = messages.find((message) => message.role === 'assistant');
  if (assistant?.status !== 'completed') return false;
  const calls = new Set(
    assistant.parts.filter((part) => part.type === 'tool-call').map((part) => part.callId),
  );
  const results = new Set(
    assistant.parts.filter((part) => part.type === 'tool-result').map((part) => part.callId),
  );
  return (
    [...calls].every((callId) => results.has(callId)) &&
    [...results].every((callId) => calls.has(callId))
  );
}

function budgetTurns(messages: readonly AgentMessage[]): BudgetTurn[] {
  const turns: BudgetTurn[] = [];
  let current: AgentMessage[] = [];
  const flush = (): void => {
    if (current.length === 0) return;
    turns.push({ messages: current, complete: completeTurn(current), protectedSystem: false });
    current = [];
  };
  for (const message of messages) {
    if (message.role === 'system' || message.role === 'summary') {
      flush();
      turns.push({ messages: [message], complete: true, protectedSystem: true });
      continue;
    }
    if (message.role === 'user') flush();
    current.push(message);
  }
  flush();
  return turns;
}

/** Select whole provider-valid turns and explain every retained or removed record. */
export async function selectAgentHistory(
  options: SelectAgentHistoryOptions,
): Promise<AgentHistoryBudgetResult> {
  if (!Number.isSafeInteger(options.availableTokens) || options.availableTokens < 0) {
    throw new TypeError('availableTokens must be a non-negative safe integer');
  }
  const keepRecentTurns = options.keepRecentTurns ?? 1;
  if (!Number.isSafeInteger(keepRecentTurns) || keepRecentTurns < 0) {
    throw new TypeError('keepRecentTurns must be a non-negative safe integer');
  }
  // A superseded record never reaches the model, so it is not conversation the
  // budget has anything to say about. Left in, it was worse than merely
  // counted: `completeTurn` reads it as an incomplete turn, which is the one
  // class the eviction loop refuses to touch — so an abandoned fragment became
  // permanently unevictable and pushed real, answered turns out in its place.
  const spoken = options.messages.filter((message) => message.status !== 'superseded');
  const counts = new Map<string, AgentTokenCount>();
  let total = 0;
  let estimated = false;
  for (const message of spoken) {
    const count = AgentTokenCountSchema.parse(await options.estimateMessage(message));
    counts.set(message.id, count);
    const value = knownValue(count);
    if (value === undefined) {
      return {
        messages: [...spoken],
        decisions: options.messages.map((candidate) => ({
          messageId: candidate.id,
          action: candidate.status === 'superseded' ? 'removed' : 'kept',
          reason: candidate.status === 'superseded' ? 'superseded' : 'token-count-unavailable',
          tokens: counts.get(candidate.id) ?? { provenance: 'unavailable' },
        })),
        totalTokens: { provenance: 'unavailable' },
        outcome: 'unavailable',
      };
    }
    total += value;
    if (count.provenance === 'estimated') estimated = true;
  }
  const turns = budgetTurns(spoken);
  const completeIndexes = turns
    .map((turn, index) => ({ turn, index }))
    .filter(({ turn }) => turn.complete && !turn.protectedSystem)
    .map(({ index }) => index);
  const protectedRecent = new Set(completeIndexes.slice(-keepRecentTurns));
  const removed = new Set<string>();
  for (let index = 0; index < turns.length && total > options.availableTokens; index += 1) {
    const turn = turns[index];
    if (!turn || turn.protectedSystem || !turn.complete || protectedRecent.has(index))
      continue;
    for (const message of turn.messages) {
      removed.add(message.id);
      total -= knownValue(counts.get(message.id) ?? { provenance: 'unavailable' }) ?? 0;
    }
  }
  const messages = spoken.filter((message) => !removed.has(message.id));
  const decisions = options.messages.map((message): AgentHistoryBudgetDecision => {
    if (message.status === 'superseded') {
      return {
        messageId: message.id,
        action: 'removed',
        reason: 'superseded',
        tokens: { provenance: 'unavailable' },
      };
    }
    const turnIndex = turns.findIndex((turn) =>
      turn.messages.some((item) => item.id === message.id),
    );
    const turn = turns[turnIndex];
    let reason: AgentHistoryBudgetDecision['reason'] = 'within-budget';
    if (removed.has(message.id)) reason = 'oldest-eligible-turn';
    else if (turn?.protectedSystem) reason = 'protected-system';
    else if (turn && !turn.complete) reason = 'protected-incomplete-turn';
    else if (protectedRecent.has(turnIndex)) reason = 'protected-recent-turn';
    return {
      messageId: message.id,
      action: removed.has(message.id) ? 'removed' : 'kept',
      reason,
      tokens: counts.get(message.id) ?? { provenance: 'unavailable' },
    };
  });
  return {
    messages,
    decisions,
    totalTokens: { value: total, provenance: estimated ? 'estimated' : 'measured' },
    outcome:
      total > options.availableTokens ? 'oversized' : removed.size > 0 ? 'truncated' : 'fits',
  };
}

export interface ComposeAgentPromptOptions<CONTEXT> {
  context: CONTEXT;
  signal: AbortSignal;
  budget?: AgentPromptBudget;
  historyTokens?: AgentTokenCount;
  oversizePolicy?: 'reject' | 'compact';
  estimateFallback?: (text: string) => AgentTokenCount | Promise<AgentTokenCount>;
  adaptInstructions?: (text: string) => Instructions | Promise<Instructions>;
}

function knownValue(value: AgentTokenCount): number | undefined {
  return value.provenance === 'unavailable' ? undefined : value.value;
}

export function composeAgentPrompt<CONTEXT>(sections: readonly AgentPromptSection<CONTEXT>[]) {
  return async (options: ComposeAgentPromptOptions<CONTEXT>): Promise<ComposedAgentPrompt> => {
    const rendered: { name: string; stability: 'stable' | 'dynamic'; text: string }[] = [];
    let total = 0;
    let unavailable = false;
    let estimated = false;

    for (const section of sections) {
      const text = await section.render({ context: options.context, signal: options.signal });
      rendered.push({ name: section.name, stability: section.stability, text });
      let count: AgentTokenCount;
      if (section.estimateTokens) count = await section.estimateTokens(text);
      else if (options.estimateFallback) count = await options.estimateFallback(text);
      else count = { provenance: 'unavailable' };
      const value = knownValue(count);
      if (value === undefined) unavailable = true;
      else total += value;
      if (count.provenance === 'estimated') estimated = true;
    }

    const instructionTokens: AgentTokenCount = unavailable
      ? { provenance: 'unavailable' }
      : { value: total, provenance: estimated ? 'estimated' : 'measured' };
    let availableHistoryTokens: number | undefined;
    let contextDecision: ComposedAgentPrompt['contextDecision'] = 'unavailable';
    if (options.budget) {
      const reserveValues = [
        options.budget.reservedOutput,
        knownValue(options.budget.toolSchemas),
        knownValue(options.budget.attachments),
        knownValue(options.budget.providerOverhead),
        knownValue(instructionTokens),
      ];
      if (reserveValues.every((value) => value !== undefined)) {
        availableHistoryTokens = Math.max(
          0,
          options.budget.contextWindow -
            reserveValues.reduce((sum, value) => sum + (value ?? 0), 0),
        );
        const historyTokens = options.historyTokens
          ? knownValue(options.historyTokens)
          : undefined;
        if (historyTokens !== undefined) {
          if (historyTokens <= availableHistoryTokens) contextDecision = 'fits';
          else
            contextDecision =
              options.oversizePolicy === 'compact' ? 'requires-compaction' : 'oversized';
        }
      }
    }

    const instructionText = rendered.map((section) => section.text).join('\n\n');
    return {
      instructions: options.adaptInstructions
        ? await options.adaptInstructions(instructionText)
        : instructionText,
      sections: rendered,
      instructionTokens,
      contextDecision,
      ...(availableHistoryTokens !== undefined && { availableHistoryTokens }),
    };
  };
}
