import { z } from 'zod';

/** Why one model step stopped producing output. */
export const AgentModelFinishReasonSchema = z.enum([
  'stop',
  'length',
  'tool-calls',
  'content-filter',
  'error',
  'interrupted',
  'other',
]);

/** Optional provider-reported breakdown of cost and BYOK routing for one step. */
export const AgentModelCostDetailsSchema = z.strictObject({
  promptCostUsd: z.number().nonnegative().optional(),
  outputCostUsd: z.number().nonnegative().optional(),
  isByok: z.boolean().optional(),
});

/** Summary quantiles (ms) of intervals between consecutive output chunks in one model step. */
export const AgentStepChunkIntervalsSchema = z.strictObject({
  min: z.number().nonnegative(),
  p10: z.number().nonnegative(),
  median: z.number().nonnegative(),
  avg: z.number().nonnegative(),
  p90: z.number().nonnegative(),
  max: z.number().nonnegative(),
});

/** Measured wall-clock latency breakdown for one model step. */
export const AgentStepTimingsSchema = z.strictObject({
  stepTimeMs: z.number().nonnegative(),
  responseTimeMs: z.number().nonnegative(),
  toolExecutionMs: z.number().nonnegative(),
  ttftMs: z.number().nonnegative().optional(),
  chunkIntervalsMs: AgentStepChunkIntervalsSchema.optional(),
});
