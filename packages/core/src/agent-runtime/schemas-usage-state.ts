import type { AgentUsage } from './schemas-usage';

/** Every field `unavailable` — a run that reported nothing, said out loud. */
export function unknownUsage(): AgentUsage {
  const nothing = { provenance: 'unavailable' } as const;
  return {
    inputTokens: nothing,
    outputTokens: nothing,
    reasoningTokens: nothing,
    cacheReadTokens: nothing,
    cacheWriteTokens: nothing,
    cost: nothing,
  };
}

/** Every field present, so a reader never has to tell an absent key from a reported zero. */
export function statedUsage(usage: AgentUsage | undefined): AgentUsage {
  const stated = (value: AgentUsage['inputTokens'] | undefined): AgentUsage['inputTokens'] =>
    value ?? { provenance: 'unavailable' };
  if (!usage) return unknownUsage();
  return {
    inputTokens: stated(usage.inputTokens),
    outputTokens: stated(usage.outputTokens),
    reasoningTokens: stated(usage.reasoningTokens),
    cacheReadTokens: stated(usage.cacheReadTokens),
    cacheWriteTokens: stated(usage.cacheWriteTokens),
    cost: stated(usage.cost),
  };
}
