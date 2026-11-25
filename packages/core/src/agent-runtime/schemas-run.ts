import { z } from 'zod';
import { AgentRecordIdSchema } from '../durability/events';
import { AgentMessageSchema } from './schemas-message';
import { AgentRecordVersionSchema, AgentTimestampSchema } from './schemas-records';
import { AgentUsageSchema } from './schemas-usage';

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

export const AgentRunOperationKindSchema = z.enum(['model-request', 'compaction']);
export const AgentRunOperationPhaseSchema = z.enum([
  'started',
  'first-output',
  'completed',
  'failed',
  'cancelled',
]);

const AgentRunOperationFieldsSchema = z.object({
  operationId: AgentRecordIdSchema,
  kind: AgentRunOperationKindSchema,
  phase: AgentRunOperationPhaseSchema,
  /** Present only for a provider model request; zero-based within the run. */
  step: z.int().nonnegative().optional(),
  startedAt: AgentTimestampSchema,
  /** First non-empty text/reasoning/tool-argument delta or complete tool call. */
  firstOutputAt: AgentTimestampSchema.optional(),
  finishedAt: AgentTimestampSchema.optional(),
});

/** The last runtime operation, with timestamps that survive reconnect. */
export const AgentRunOperationSchema = AgentRunOperationFieldsSchema.superRefine(
  (operation, ctx) => {
    if ((operation.kind === 'model-request') !== (operation.step !== undefined)) {
      ctx.addIssue({
        code: 'custom',
        path: ['step'],
        message: 'Only a model request has a step identity',
      });
    }
    if (operation.kind === 'compaction' && operation.phase === 'first-output') {
      ctx.addIssue({
        code: 'custom',
        path: ['phase'],
        message: 'Compaction has no first-output phase',
      });
    }
    if (
      (operation.phase === 'first-output' && operation.firstOutputAt === undefined) ||
      (operation.phase === 'started' && operation.firstOutputAt !== undefined) ||
      (operation.kind === 'compaction' && operation.firstOutputAt !== undefined)
    ) {
      ctx.addIssue({
        code: 'custom',
        path: ['firstOutputAt'],
        message: 'Only model output phases carry the observed first-output timestamp',
      });
    }
    const terminal = ['completed', 'failed', 'cancelled'].includes(operation.phase);
    if (terminal !== (operation.finishedAt !== undefined)) {
      ctx.addIssue({
        code: 'custom',
        path: ['finishedAt'],
        message: 'A terminal operation phase carries its observed finish timestamp',
      });
    }
  },
);

export type AgentRunOperation = z.infer<typeof AgentRunOperationSchema>;

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
   * An owned mutation of this run lost its compare-and-set, or the store
   * refused it. Nothing upstream failed, and the provider may never have been
   * contacted: the durable record is what came apart.
   */
  'storage_conflict',
  /**
   * The application's own acceptance — `protocol.acceptTerminal` — refused the
   * finished message. The provider answered; this run's own reader rejected the
   * answer.
   */
  'output_rejected',
  /**
   * This runtime, or an application callback it awaits, failed before the
   * provider was ever admitted. Kept apart from `provider_failure` for the
   * reason `context_overflow` is: a durable record must not blame an upstream
   * that was never contacted.
   */
  'runtime_failure',
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
  /** Latest model-request or compaction lifecycle fact, durable across reconnect. */
  lastOperation: AgentRunOperationSchema.optional(),
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
