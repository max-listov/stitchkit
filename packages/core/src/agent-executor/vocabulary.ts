import { z } from 'zod';
import {
  AgentReasoningPartSchema,
  AgentTextPartSchema,
  AgentToolCallPartSchema,
  AgentToolResultPartSchema,
} from '../agent-parts/parts';

/**
 * What an engine said, as the executor streams it: the blocks of
 * `agent-parts`, each tagged with the turn, the item it belongs to and the
 * engine's own record it came from.
 *
 * `raw` names the source dialect and the record type (`claude/assistant`,
 * `codex/item/completed`), never its content: a reader that needs the engine's
 * bytes reads the engine's transcript. Ids: `turnId` and `threadId` are the
 * server's, `itemId` is the assembler's, a native id is only a join key.
 */
export const ExecutorRawSchema = z.strictObject({
  source: z.string().min(1),
  type: z.string().min(1),
});

const base = {
  turnId: z.string().min(1),
  itemId: z.string().min(1),
  raw: ExecutorRawSchema,
};

/** Text and reasoning arrive as chunks appended to their item, in order. */
export const ExecutorTextDeltaSchema = AgentTextPartSchema.extend(base).strict();
export const ExecutorReasoningDeltaSchema = AgentReasoningPartSchema.extend(base).strict();
export const ExecutorToolCallDeltaSchema = AgentToolCallPartSchema.extend(base).strict();
/** `toolName` is required, as in a message: a dialect that omits it (Claude's `tool_result`) is mapped by `callId`. */
export const ExecutorToolResultDeltaSchema = AgentToolResultPartSchema.extend(base).strict();

/** The engine asks: approve a tool call, or give it input. Answered with `respond()`. */
export const ExecutorRequestDeltaSchema = z.strictObject({
  type: z.literal('request'),
  ...base,
  interactionId: z.string().min(1),
  kind: z.enum(['approval', 'input']),
  callId: z.string().min(1).optional(),
  toolName: z.string().min(1).optional(),
  input: z.json().optional(),
  prompt: z.string().optional(),
});

/** A request was answered, or withdrawn by the engine; either way it needs no answer any more. */
export const ExecutorRequestResolvedDeltaSchema = z.strictObject({
  type: z.literal('request-resolved'),
  ...base,
  interactionId: z.string().min(1),
});

const TokenCountSchema = z.int().nonnegative();
const MAX_MODEL_USAGE_ENTRIES = 64;

/** Token counters for a turn step or cumulative thread total; an unreported figure is absent, not zero. */
export const ExecutorTokenUsageSchema = z.strictObject({
  inputTokens: TokenCountSchema.optional(),
  outputTokens: TokenCountSchema.optional(),
  cachedInputTokens: TokenCountSchema.optional(),
  cacheCreationInputTokens: TokenCountSchema.optional(),
  thinkingTokens: TokenCountSchema.optional(),
  totalTokens: TokenCountSchema.optional(),
});

/** Per-model cumulative token and cost breakdown reported on an engine turn result. */
export const ExecutorModelUsageSchema = z.strictObject({
  inputTokens: TokenCountSchema,
  outputTokens: TokenCountSchema,
  cacheReadInputTokens: TokenCountSchema.optional(),
  cacheCreationInputTokens: TokenCountSchema.optional(),
  thinkingTokens: TokenCountSchema.optional(),
  cacheCreationEphemeral5mInputTokens: TokenCountSchema.optional(),
  cacheCreationEphemeral1hInputTokens: TokenCountSchema.optional(),
  webSearchRequests: TokenCountSchema.optional(),
  costUsd: z.number().nonnegative().optional(),
  contextWindow: TokenCountSchema.optional(),
  maxOutputTokens: TokenCountSchema.optional(),
  canonicalModel: z.string().min(1).max(256).optional(),
  provider: z.string().min(1).max(128).optional(),
  costBasis: z.enum(['list', 'managed', 'unknown']).optional(),
});

/** What the turn cost so far, as the engine reported it; a figure it did not report is absent, not zero. */
export const ExecutorUsageDeltaSchema = z.strictObject({
  type: z.literal('usage'),
  ...base,
  inputTokens: TokenCountSchema.optional(),
  outputTokens: TokenCountSchema.optional(),
  cachedInputTokens: TokenCountSchema.optional(),
  cacheCreationInputTokens: TokenCountSchema.optional(),
  thinkingTokens: TokenCountSchema.optional(),
  totalTokens: TokenCountSchema.optional(),
  costUsd: z.number().nonnegative().optional(),
  total: ExecutorTokenUsageSchema.optional(),
  modelUsage: z
    .record(z.string().min(1).max(256), ExecutorModelUsageSchema)
    .refine(
      (entries) => Object.keys(entries).length <= MAX_MODEL_USAGE_ENTRIES,
      `modelUsage must carry at most ${MAX_MODEL_USAGE_ENTRIES} models`,
    )
    .optional(),
});

/**
 * How full the engine's context window is, as it reported: a gauge read
 * between steps, not a cost — it does not add up across a turn.
 */
export const ExecutorContextUsageDeltaSchema = z.strictObject({
  type: z.literal('context-usage'),
  ...base,
  usedTokens: TokenCountSchema,
  windowTokens: TokenCountSchema,
});

/** Whether a thread's native history remains reusable after a turn finishes, or is broken. */
export const ExecutorThreadDispositionSchema = z.enum(['reusable', 'broken']);

/** Open bounded startup or lifecycle phase label (`1..64` trimmed characters). */
export const ExecutorStartupPhaseSchema = z.string().trim().min(1).max(64);

/** Non-content status update reporting a startup or preparation phase during a turn. */
export const ExecutorStatusDeltaSchema = z.strictObject({
  type: z.literal('status'),
  ...base,
  phase: ExecutorStartupPhaseSchema,
});

export const ExecutorTurnEndDeltaSchema = z.strictObject({
  type: z.literal('turn-end'),
  ...base,
  outcome: z.enum(['completed', 'interrupted', 'failed']),
  threadDisposition: ExecutorThreadDispositionSchema.optional(),
});

/**
 * A failure the reader acts on by its kind, never by its text: `authRequired`
 * — sign the profile in; `rateLimited` — wait for the plan window;
 * `restartRecommended` — the engine is in a state a new process cures;
 * `staleTurn` — the turn is no longer this executor's; `unhandled` — a record
 * the driver does not know, carried with `raw` rather than dropped.
 */
export const ExecutorErrorKindSchema = z.enum([
  'authRequired',
  'rateLimited',
  'restartRecommended',
  'staleTurn',
  'unhandled',
]);

export const ExecutorErrorDeltaSchema = z.strictObject({
  type: z.literal('error'),
  ...base,
  kind: ExecutorErrorKindSchema,
  message: z.string().min(1),
});

/**
 * Throw away what was assembled for this turn and rebuild from what follows:
 * `initial` — the first window; `gap` — deltas were lost; `generation` — the
 * engine process was replaced; `context` — the engine compacted its context.
 */
export const ExecutorWindowDeltaSchema = z.strictObject({
  type: z.literal('window'),
  ...base,
  reset: z.enum(['initial', 'gap', 'generation', 'context']),
});

/** Discriminated union schema of all executor turn delta events. */
export const ExecutorDeltaSchema = z.discriminatedUnion('type', [
  ExecutorTextDeltaSchema,
  ExecutorReasoningDeltaSchema,
  ExecutorToolCallDeltaSchema,
  ExecutorToolResultDeltaSchema,
  ExecutorRequestDeltaSchema,
  ExecutorRequestResolvedDeltaSchema,
  ExecutorUsageDeltaSchema,
  ExecutorContextUsageDeltaSchema,
  ExecutorStatusDeltaSchema,
  ExecutorTurnEndDeltaSchema,
  ExecutorErrorDeltaSchema,
  ExecutorWindowDeltaSchema,
]);

/** Executor turn delta event inferred from `ExecutorDeltaSchema`. */
export type ExecutorDelta = z.infer<typeof ExecutorDeltaSchema>;
/** Executor delta error category inferred from `ExecutorErrorKindSchema`. */
export type ExecutorErrorKind = z.infer<typeof ExecutorErrorKindSchema>;
/** Thread reusability disposition inferred from `ExecutorThreadDispositionSchema`. */
export type ExecutorThreadDisposition = z.infer<typeof ExecutorThreadDispositionSchema>;
/** Bounded startup or preparation phase label inferred from `ExecutorStartupPhaseSchema`. */
export type ExecutorStartupPhase = z.infer<typeof ExecutorStartupPhaseSchema>;
/** Token usage counters inferred from `ExecutorTokenUsageSchema`. */
export type ExecutorTokenUsage = z.infer<typeof ExecutorTokenUsageSchema>;
/** Per-model cumulative usage breakdown inferred from `ExecutorModelUsageSchema`. */
export type ExecutorModelUsage = z.infer<typeof ExecutorModelUsageSchema>;
