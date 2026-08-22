import type { Instructions } from 'ai';
import { z } from 'zod';

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
