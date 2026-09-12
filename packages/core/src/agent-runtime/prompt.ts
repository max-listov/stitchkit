import type { Instructions } from 'ai';
import { z } from 'zod';
import { type AgentMessage, AgentProvenanceSchema } from './schemas';
import {
  type AgentHistoryEvidencePolicy,
  isAssistantHistoryEvidence,
  isCompleteAgentHistoryTurn,
} from './terminal-status';

/**
 * A token count made *before* a request, and how it came to be known.
 *
 * The words come from `AgentProvenanceSchema`, shared with `AgentUsage` so one
 * question has one vocabulary. The subset differs because the facts differ: no
 * provider has reported anything yet at prompt-composition time, so
 * `provider-reported` is not among the values this surface can produce, and a
 * count this process took with a tokenizer is `measured`.
 */
export const AgentTokenCountSchema = z.object({
  value: z.int().nonnegative().optional(),
  provenance: AgentProvenanceSchema.extract([
    'measured',
    'computed',
    'estimated',
    'unavailable',
  ]),
});

export type AgentTokenCount = z.infer<typeof AgentTokenCountSchema>;

export interface AgentPromptSectionContext<CONTEXT> {
  context: CONTEXT;
  signal: AbortSignal;
  event: 'session.started' | 'turn.started';
}

export interface AgentPromptSection<CONTEXT> {
  name: string;
  stability: 'stable' | 'dynamic';
  /**
   * Authority of this section. `system` (default) is framework policy: it stays
   * outside history and is rebuilt on every call. `user` is context an
   * application, a provider or a memory produced — it reaches the model as
   * ordinary user history, ahead of the durable conversation, never as system
   * authority. → ADR 0178
   */
  role?: 'system' | 'user';
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
  sections: readonly {
    name: string;
    stability: 'stable' | 'dynamic';
    role: 'system' | 'user';
    text: string;
  }[];
  /**
   * User-role sections, in declaration order. They are carried to the model as
   * user history before the durable conversation, so `instructions` never
   * contains them. Blank sections materialize nothing.
   */
  userInstructions?: readonly { name: string; text: string }[];
  instructionTokens: AgentTokenCount;
  userInstructionTokens?: AgentTokenCount;
  /** Reconcile the reservation after the runtime atomically seeds durable history. */
  finalizeSeed?(
    inserted: boolean,
  ): Pick<ComposedAgentPrompt, 'contextDecision' | 'availableHistoryTokens'>;
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
    /** The model never hears this record, so the budget does not count it. */
    | 'unspeakable';
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
  evidencePolicy?: AgentHistoryEvidencePolicy;
  estimateMessage(message: AgentMessage): AgentTokenCount | Promise<AgentTokenCount>;
}

interface BudgetTurn {
  messages: readonly AgentMessage[];
  complete: boolean;
  protectedSystem: boolean;
}

function budgetTurns(
  messages: readonly AgentMessage[],
  evidencePolicy: AgentHistoryEvidencePolicy | undefined,
): BudgetTurn[] {
  const turns: BudgetTurn[] = [];
  let current: AgentMessage[] = [];
  const flush = (): void => {
    if (current.length === 0) return;
    turns.push({
      messages: current,
      complete: isCompleteAgentHistoryTurn(current, evidencePolicy),
      protectedSystem: false,
    });
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
  // A record the model never hears is not conversation the budget has anything
  // to say about. Left in, it is worse than merely counted: `completeTurn` reads
  // it as an incomplete turn, which is the one class the eviction loop refuses
  // to touch — so it becomes permanently unevictable and pushes real, answered
  // turns out in its place.
  //
  // This filter named `superseded` alone, and the same trap was live for every
  // other unspeakable status: a `failed` assistant is never projected and was
  // still protected, so every provider failure in a long conversation
  // permanently reserved budget. The question has one home now, and this is one
  // of the three walkers that asks it.
  const spoken = options.messages.filter(
    (message) =>
      message.role !== 'assistant' ||
      isAssistantHistoryEvidence(message.status, options.evidencePolicy),
  );
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
          action:
            candidate.role === 'assistant' &&
            !isAssistantHistoryEvidence(candidate.status, options.evidencePolicy)
              ? 'removed'
              : 'kept',
          reason:
            candidate.role === 'assistant' &&
            !isAssistantHistoryEvidence(candidate.status, options.evidencePolicy)
              ? 'unspeakable'
              : 'token-count-unavailable',
          tokens: counts.get(candidate.id) ?? { provenance: 'unavailable' },
        })),
        totalTokens: { provenance: 'unavailable' },
        outcome: 'unavailable',
      };
    }
    total += value;
    if (count.provenance === 'estimated') estimated = true;
  }
  const turns = budgetTurns(spoken, options.evidencePolicy);
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
    if (
      message.role === 'assistant' &&
      !isAssistantHistoryEvidence(message.status, options.evidencePolicy)
    ) {
      return {
        messageId: message.id,
        action: 'removed',
        reason: 'unspeakable',
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
    // A total this code added up, not a count it took: `computed`, by the same
    // rule `addUsage` applies to a run's spend. It said `measured`, which is
    // what a tokenizer reports about one string — so a caller could not tell a
    // number that was counted from a number that was derived, on the one
    // surface where the difference decides whether the window fits.
    // An estimate survives arithmetic: one estimated part makes the sum an
    // estimate, which is a weaker claim than `computed` and therefore wins.
    totalTokens: { value: total, provenance: estimated ? 'estimated' : 'computed' },
    outcome:
      total > options.availableTokens ? 'oversized' : removed.size > 0 ? 'truncated' : 'fits',
  };
}

export interface ComposeAgentPromptOptions<CONTEXT> {
  context: CONTEXT;
  signal: AbortSignal;
  event?: 'session.started' | 'turn.started';
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
    const event = z
      .enum(['session.started', 'turn.started'])
      .parse(options.event ?? 'turn.started');
    const rendered: {
      name: string;
      stability: 'stable' | 'dynamic';
      role: 'system' | 'user';
      text: string;
    }[] = [];
    let systemTotal = 0;
    let userTotal = 0;
    let systemUnavailable = false;
    let userUnavailable = false;
    let systemEstimated = false;
    let userEstimated = false;

    for (const section of sections) {
      const role = section.role ?? 'system';
      const text = await section.render({
        context: options.context,
        signal: options.signal,
        event,
      });
      rendered.push({ name: section.name, stability: section.stability, role, text });
      // Parsed, like the per-message counts in `selectAgentHistory`: both come
      // from a consumer callback, and only one of them was checked. A
      // `3.5`-token section survived here and reached the window arithmetic.
      let count: AgentTokenCount;
      if (section.estimateTokens) {
        count = AgentTokenCountSchema.parse(await section.estimateTokens(text));
      } else if (options.estimateFallback) {
        count = AgentTokenCountSchema.parse(await options.estimateFallback(text));
      } else count = { provenance: 'unavailable' };
      const value = knownValue(count);
      if (role === 'user') {
        if (value === undefined) userUnavailable = true;
        else userTotal += value;
        if (count.provenance === 'estimated') userEstimated = true;
      } else {
        if (value === undefined) systemUnavailable = true;
        else systemTotal += value;
        if (count.provenance === 'estimated') systemEstimated = true;
      }
    }

    // A sum across sections, so `computed` — see the same call in
    // `selectAgentHistory`.
    const instructionTokens: AgentTokenCount = systemUnavailable
      ? { provenance: 'unavailable' }
      : { value: systemTotal, provenance: systemEstimated ? 'estimated' : 'computed' };
    const userInstructionTokens: AgentTokenCount = userUnavailable
      ? { provenance: 'unavailable' }
      : { value: userTotal, provenance: userEstimated ? 'estimated' : 'computed' };
    let availableHistoryTokens: number | undefined;
    let contextDecision: ComposedAgentPrompt['contextDecision'] = 'unavailable';
    if (options.budget) {
      // The budget is consumer-supplied and went straight into the window
      // arithmetic unchecked. A fractional reservation there produces a
      // fractional `availableHistoryTokens`, which is then compared against
      // integer history counts.
      if (
        !Number.isSafeInteger(options.budget.contextWindow) ||
        options.budget.contextWindow < 0 ||
        !Number.isSafeInteger(options.budget.reservedOutput) ||
        options.budget.reservedOutput < 0
      ) {
        throw new TypeError(
          'contextWindow and reservedOutput must be non-negative safe integers',
        );
      }
      const reserveValues = [
        options.budget.reservedOutput,
        knownValue(AgentTokenCountSchema.parse(options.budget.toolSchemas)),
        knownValue(AgentTokenCountSchema.parse(options.budget.attachments)),
        knownValue(AgentTokenCountSchema.parse(options.budget.providerOverhead)),
        knownValue(instructionTokens),
      ];
      if (reserveValues.every((value) => value !== undefined)) {
        // Keep the sign. Clamping here made an irreducible reservation deficit
        // indistinguishable from a window with exactly zero room for history:
        // empty history then "fit", and `compact` proposed work that could not
        // possibly repair the request.
        availableHistoryTokens =
          options.budget.contextWindow -
          reserveValues.reduce((sum, value) => sum + (value ?? 0), 0);
        const historyTokens = options.historyTokens
          ? knownValue(AgentTokenCountSchema.parse(options.historyTokens))
          : undefined;
        if (historyTokens !== undefined) {
          if (availableHistoryTokens < 0) contextDecision = 'oversized';
          else if (historyTokens <= availableHistoryTokens) contextDecision = 'fits';
          else
            contextDecision =
              options.oversizePolicy === 'compact' ? 'requires-compaction' : 'oversized';
        }
      }
    }

    const instructionText = rendered
      .filter((section) => section.role === 'system')
      .map((section) => section.text)
      .join('\n\n');
    const userInstructions = rendered
      .filter((section) => section.role === 'user' && section.text.trim().length > 0)
      .map((section) => ({ name: section.name, text: section.text }));
    return {
      instructions: options.adaptInstructions
        ? await options.adaptInstructions(instructionText)
        : instructionText,
      sections: rendered,
      userInstructions,
      instructionTokens,
      userInstructionTokens,
      finalizeSeed: (inserted) => {
        const seedTokens = inserted ? knownValue(userInstructionTokens) : 0;
        if (availableHistoryTokens === undefined || seedTokens === undefined)
          return { contextDecision: 'unavailable' };
        const available = availableHistoryTokens - seedTokens;
        const history = options.historyTokens ? knownValue(options.historyTokens) : undefined;
        const decision =
          history === undefined
            ? 'unavailable'
            : available < 0
              ? 'oversized'
              : history <= available
                ? 'fits'
                : options.oversizePolicy === 'compact'
                  ? 'requires-compaction'
                  : 'oversized';
        return { availableHistoryTokens: available, contextDecision: decision };
      },
      contextDecision,
      ...(availableHistoryTokens !== undefined && { availableHistoryTokens }),
    };
  };
}
