import { z } from 'zod';

export const AgentRecordIdSchema = z.string().min(1);
export const AgentRecordVersionSchema = z.int().nonnegative();
export const AgentTimestampSchema = z.iso.datetime({ offset: true });
export const AgentJsonObjectSchema = z.record(z.string(), z.json());

export const AgentProviderEnvelopeSchema = z.object({
  schemaVersion: z.int().positive(),
  provider: z.string().min(1),
  data: AgentJsonObjectSchema,
});

export type AgentProviderEnvelope = z.infer<typeof AgentProviderEnvelopeSchema>;

export const AgentTextPartSchema = z.object({
  type: z.literal('text'),
  text: z.string(),
});

export const AgentReasoningPartSchema = z.object({
  type: z.literal('reasoning'),
  text: z.string(),
  provider: AgentProviderEnvelopeSchema.optional(),
});

export const AgentFilePartSchema = z.object({
  type: z.literal('file'),
  mediaType: z.string().min(1),
  reference: z.string().min(1),
  filename: z.string().min(1).optional(),
});

export const AgentSourcePartSchema = z.object({
  type: z.literal('source'),
  sourceId: z.string().min(1),
  url: z.url().optional(),
  title: z.string().optional(),
});

export const AgentToolCallPartSchema = z.object({
  type: z.literal('tool-call'),
  callId: z.string().min(1),
  toolName: z.string().min(1),
  input: z.json(),
  provider: AgentProviderEnvelopeSchema.optional(),
});

export const AgentToolResultPartSchema = z.object({
  type: z.literal('tool-result'),
  callId: z.string().min(1),
  toolName: z.string().min(1),
  outcome: z.enum(['success', 'error', 'interrupted']),
  output: z.json().optional(),
});

export const AgentOpaquePartSchema = z.object({
  type: z.literal('provider'),
  envelope: AgentProviderEnvelopeSchema,
});

export const AgentControlPartSchema = z.object({
  type: z.literal('control'),
  reason: z.enum(['run-interrupted', 'stale-run']),
});

export const AgentMessagePartSchema = z.discriminatedUnion('type', [
  AgentTextPartSchema,
  AgentReasoningPartSchema,
  AgentFilePartSchema,
  AgentSourcePartSchema,
  AgentToolCallPartSchema,
  AgentToolResultPartSchema,
  AgentOpaquePartSchema,
  AgentControlPartSchema,
]);

export type AgentMessagePart = z.infer<typeof AgentMessagePartSchema>;

export const AgentMessageRoleSchema = z.enum(['user', 'assistant', 'system', 'summary']);
export const AgentMessageStatusSchema = z.enum([
  'committed',
  'streaming',
  'completed',
  'interrupted',
  'superseded',
  'failed',
]);

export const AgentMessageSchema = z.object({
  schemaVersion: z.literal(1),
  id: AgentRecordIdSchema,
  conversationId: AgentRecordIdSchema,
  runId: AgentRecordIdSchema.optional(),
  role: AgentMessageRoleSchema,
  status: AgentMessageStatusSchema,
  parts: z.array(AgentMessagePartSchema),
  metadata: AgentJsonObjectSchema.optional(),
  createdAt: AgentTimestampSchema,
  updatedAt: AgentTimestampSchema,
});

export type AgentMessage = z.infer<typeof AgentMessageSchema>;

export const AgentAssistantPlaceholderSchema = z.object({
  schemaVersion: z.literal(1),
  id: AgentRecordIdSchema,
  conversationId: AgentRecordIdSchema,
  runId: AgentRecordIdSchema,
  status: z.literal('pending'),
  createdAt: AgentTimestampSchema,
  updatedAt: AgentTimestampSchema,
});

export type AgentAssistantPlaceholder = z.infer<typeof AgentAssistantPlaceholderSchema>;

export const AgentRunStateSchema = z.enum([
  'queued',
  'running',
  'interrupt_requested',
  'completed',
  'interrupted',
  'superseded',
  'failed',
  'cancelled',
  'abandoned',
]);

export const AgentRunQueuePrioritySchema = z.enum(['interrupt-next']);
export type AgentRunQueuePriority = z.infer<typeof AgentRunQueuePrioritySchema>;

export const AgentTerminalReasonSchema = z.enum([
  'success',
  'policy_stop',
  'provider_stop',
  'interrupted',
  'superseded',
  'cancelled',
  'timeout',
  'shutdown',
  'provider_failure',
  /** This runtime refused to call the provider — the context did not fit. */
  'context_overflow',
  /**
   * This run's input was taken on by a run already in flight, which answered it.
   *
   * Never passed to `commitRunTerminal` as an operation's own reason: it is
   * written as a **side effect** of the absorbing run's terminal commit, in the
   * same transaction, which is the whole point (→ ADR 0113). A run that ends
   * this way produces no assistant message of its own — the answer is on the run
   * named by `absorbedIntoRunId`.
   */
  'absorbed',
  'abandoned',
]);

export type AgentTerminalReason = z.infer<typeof AgentTerminalReasonSchema>;

/**
 * The state a run ends in, given why it ended.
 *
 * Beside the enum rather than inside the store driver, because `AgentRunSchema`
 * now enforces the agreement and a schema cannot import a reducer. Two readers
 * derive from one statement instead of asserting the same thing twice.
 */
export function runStateForTerminalReason(
  reason: AgentTerminalReason,
): z.infer<typeof AgentRunStateSchema> {
  if (reason === 'success' || reason === 'policy_stop' || reason === 'provider_stop') {
    return 'completed';
  }
  if (reason === 'interrupted') return 'interrupted';
  // `absorbed` shares `superseded`'s state, and for `superseded`'s reason: this
  // run contributed nothing the model will ever hear. Sharing an existing state
  // instead of minting one is deliberate — the withdrawn 0.63.0 design gave
  // absorption a state of its own, and it was the only run state that was
  // neither active, nor recoverable, nor terminal. The reason still says which
  // of the two happened, and `absorbedIntoRunId` says where the answer went.
  if (reason === 'superseded' || reason === 'absorbed') return 'superseded';
  if (reason === 'cancelled' || reason === 'shutdown' || reason === 'timeout') {
    return 'cancelled';
  }
  if (reason === 'abandoned') return 'abandoned';
  return 'failed';
}

/**
 * How a number came to be known — one vocabulary for the whole entrypoint.
 *
 * There used to be two, and they did not share a word: a spend figure could be
 * `provider-reported` or `computed`, a prompt-budget count `measured`, and
 * neither type accepted the other's terms. A consumer holding both — and it
 * holds both for the *same request*, `AgentPromptBudget.toolSchemas` beside
 * `AgentUsage.inputTokens` — wrote two switches over one question, and the
 * difference between `measured` and `provider-reported` could not be explained
 * without reading both files.
 *
 * The words are now defined once, here, and each surface declares the subset it
 * can produce with `.extract`. No surface widened: a reader's exhaustive switch
 * still sees exactly the values that surface emits, and adding a word to the
 * vocabulary does not silently add it to a surface.
 *
 * `measured` and `provider-reported` are **not** the same fact, which is why
 * both survive:
 *
 * - `provider-reported` — the provider stated this number about a request it
 *   served. Nothing else can produce it.
 * - `measured` — this process counted it exactly, before any request was made.
 *   A tokenizer over a string is the case.
 * - `computed` — arithmetic over other values. A sum of exact numbers is still
 *   `computed`, because what a caller filtering for a billable figure wants is
 *   a number it can bill against unchanged, and a sum is not that.
 * - `estimated` — a heuristic. Not exact and not claimed to be.
 * - `unavailable` — not known. `value` is then absent, and that is a different
 *   fact from a reported zero.
 */
export const AgentProvenanceSchema = z.enum([
  'provider-reported',
  'measured',
  'computed',
  'estimated',
  'unavailable',
]);

export type AgentProvenance = z.infer<typeof AgentProvenanceSchema>;

/**
 * A token count, and how it came to be known.
 *
 * `z.int()` rather than `z.number()`: a fractional token is not a thing, and
 * accepting `3.5` is how a bad estimator's output survives validation and turns
 * up later as a context-window decision nobody can reproduce.
 */
export const AgentUsageValueSchema = z.object({
  value: z.int().nonnegative().optional(),
  provenance: AgentProvenanceSchema.extract([
    'provider-reported',
    'computed',
    'estimated',
    'unavailable',
  ]),
});

/**
 * Money, which is fractional by nature — so `value` stays `z.number()` here and
 * only here. Everything counted in tokens is an integer.
 */
export const AgentCostValueSchema = z.object({
  value: z.number().nonnegative().optional(),
  currency: z.string().length(3).optional(),
  provenance: AgentProvenanceSchema.extract([
    'provider-reported',
    'computed',
    'estimated',
    'unavailable',
  ]),
});

export const AgentUsageSchema = z.object({
  inputTokens: AgentUsageValueSchema,
  outputTokens: AgentUsageValueSchema,
  reasoningTokens: AgentUsageValueSchema.optional(),
  cacheReadTokens: AgentUsageValueSchema.optional(),
  cacheWriteTokens: AgentUsageValueSchema.optional(),
  cost: AgentCostValueSchema.optional(),
});

export type AgentUsage = z.infer<typeof AgentUsageSchema>;

const AgentRunFieldsSchema = z.object({
  schemaVersion: z.literal(1),
  id: AgentRecordIdSchema,
  conversationId: AgentRecordIdSchema,
  inputMessageIds: z.array(AgentRecordIdSchema).min(1),
  assistantMessageId: AgentRecordIdSchema,
  state: AgentRunStateSchema,
  revision: AgentRecordVersionSchema,
  /** Absent means ordinary FIFO; urgent input remains a distinct durable run. */
  queuePriority: AgentRunQueuePrioritySchema.optional(),
  /** Conversation-head version at first durable acquisition; preserves execution order. */
  executionSequence: AgentRecordVersionSchema.optional(),
  /**
   * Which runtime instance holds this run.
   *
   * The same value a runtime publishes as `runtimeEpoch` on its events — one
   * identity generated per `createAgentRuntime()`, named for its role in each
   * place: on a run it answers "who owns this", on an event "which runtime
   * produced this". Fencing compares the two: `run.ownerId !== runtimeEpoch`
   * means another instance took the run over.
   */
  ownerId: z.string().min(1).optional(),
  fencingToken: AgentRecordVersionSchema.optional(),
  terminalReason: AgentTerminalReasonSchema.optional(),
  terminalPolicyName: z.string().min(1).optional(),
  /**
   * The run that took this run's input on and answered it.
   *
   * Present exactly when `terminalReason` is `'absorbed'`, and written in the
   * same transaction as that reason. It is the only way back to the answer: an
   * absorbed run has no assistant message of its own, and the store follows this
   * pointer when a duplicate submission arrives on the absorbed run's
   * idempotency key.
   */
  absorbedIntoRunId: AgentRecordIdSchema.optional(),
  /**
   * What this run has cost, written with its terminal record.
   *
   * The figure used to exist only on two bounded, fire-and-forget event sinks
   * that drop under load — and they drop by arrival order, so the event
   * carrying nothing survives while the one carrying the money does not. With
   * nowhere durable to read it back from, a dropped event was a lost number.
   *
   * It is deliberately **not** a ledger (→ ADR 0110): one figure, on the run
   * that produced it, never aggregated and never reconciled against a provider
   * invoice by the core. Absent on a run that has not terminated.
   */
  usage: AgentUsageSchema.optional(),
  createdAt: AgentTimestampSchema,
  updatedAt: AgentTimestampSchema,
});

/**
 * A run record whose fields agree with each other.
 *
 * The object accepted every combination: `state: 'completed'` beside
 * `terminalReason: 'interrupted'`, a terminal state with no reason at all, a
 * `queued` run carrying a terminal reason, and `policy_stop` with no policy —
 * the last of which the changelog had already promised could not happen. A
 * driver is the supported extension point and may hand any of these back, and
 * nothing downstream checked, so the contradiction surfaced later as a
 * conflict error or as a lie in an operator's console.
 */
export const AgentRunSchema = AgentRunFieldsSchema.superRefine((run, ctx) => {
  if (run.terminalReason !== 'absorbed' && run.absorbedIntoRunId !== undefined) {
    ctx.addIssue({
      code: 'custom',
      path: ['absorbedIntoRunId'],
      message: 'Only an absorbed run names the run that answered it',
    });
  }
  if (run.terminalReason === undefined) {
    if (TERMINAL_RUN_STATES.has(run.state)) {
      ctx.addIssue({
        code: 'custom',
        path: ['terminalReason'],
        message: `A run in terminal state "${run.state}" must say why it ended`,
      });
    }
    return;
  }
  const expected = runStateForTerminalReason(run.terminalReason);
  if (run.state !== expected) {
    ctx.addIssue({
      code: 'custom',
      path: ['state'],
      message: `Terminal reason "${run.terminalReason}" ends a run in state "${expected}", not "${run.state}"`,
    });
  }
  if (run.terminalReason === 'policy_stop' && run.terminalPolicyName === undefined) {
    ctx.addIssue({
      code: 'custom',
      path: ['terminalPolicyName'],
      message: 'A policy stop names the policy that stopped the run',
    });
  }
  if (run.terminalReason === 'absorbed' && run.absorbedIntoRunId === undefined) {
    ctx.addIssue({
      code: 'custom',
      path: ['absorbedIntoRunId'],
      message: 'An absorbed run names the run that answered its input',
    });
  }
  if (run.absorbedIntoRunId === run.id) {
    ctx.addIssue({
      code: 'custom',
      path: ['absorbedIntoRunId'],
      message: 'A run cannot absorb itself',
    });
  }
});

const TERMINAL_RUN_STATES = new Set<z.infer<typeof AgentRunStateSchema>>([
  'completed',
  'interrupted',
  'superseded',
  'cancelled',
  'abandoned',
  'failed',
]);

export type AgentRun = z.infer<typeof AgentRunSchema>;

export const AgentSnapshotSchema = z.object({
  schemaVersion: z.literal(1),
  conversationId: AgentRecordIdSchema,
  version: AgentRecordVersionSchema,
  /** In history order, oldest first. */
  messages: z.array(AgentMessageSchema),
  /**
   * Oldest first — by creation time, and within one millisecond by the
   * position of the earliest message the run owns.
   *
   * The second key exists because the first cannot separate a successor from
   * the run it queues behind: coalescing creates both inside one millisecond,
   * and an ISO timestamp has nothing finer. Position therefore carries
   * meaning, and a reader may rely on it.
   */
  runs: z.array(AgentRunSchema),
});

export type AgentSnapshot = z.infer<typeof AgentSnapshotSchema>;

export const AgentRunMetricsSchema = z.object({
  /**
   * The provider never reported this run finished, so the figure beside it is
   * not a confirmed total. Always `true` on a checkpoint, by construction.
   */
  partial: z.boolean(),
  /**
   * Required, like its counterpart on the operator event.
   *
   * 0.64.0 split the operator event into a union so a terminal could not omit
   * what it spent, and stopped there — leaving the *delivery* events, which
   * carry the same `AgentRunMetrics`, free to omit it while the changelog said
   * they always carried it. An invariant held on one of two channels is an
   * invariant a reader cannot rely on.
   */
  usage: AgentUsageSchema,
  durationMs: z.number().nonnegative().optional(),
  ttftMs: z.number().nonnegative().optional(),
});

export type AgentRunMetrics = z.infer<typeof AgentRunMetricsSchema>;
