import type { ToolSet } from 'ai';
import { type AgentRuntimeEvent, agentDurableEventId } from './events';
import type { AgentInjectionRegistry } from './injection';
import type { AgentResolvedModel } from './models';
import type { RunMutationQueue } from './run-mutation-queue';
import type { createAgentRunOperationLifecycle } from './run-operation-lifecycle';
import type { AgentRuntimeConfig } from './runtime';
import {
  addUsage,
  type createIdleDeadline,
  findRun,
  providerEnvelope,
  statedUsage,
} from './runtime-internals';
import {
  type AgentMessage,
  type AgentMessagePart,
  AgentMessagePartSchema,
  AgentMessageSchema,
  type AgentRun,
  type AgentSnapshot,
  type AgentTerminalReason,
  type AgentUsage,
  type AgentUsageValue,
} from './schemas';
import { AgentRuntimeConflictError, appliedSnapshot } from './terminal-commit';

/** Everything one run needs from the factory that owns it. */
export interface RunExecutorDependencies<CONTEXT, TOOLS extends ToolSet> {
  config: AgentRuntimeConfig<CONTEXT, TOOLS>;
  publish(event: AgentRuntimeEvent): Promise<void>;
  runtimeEpoch: string;
  generateId(): string;
  now(): Date;
  checkpointEveryEvents: number;
  maxSteps: number;
  idleTimeoutMs?: number;
  /**
   * Present only when this runtime's `inputPolicy` can ever produce `inject`.
   *
   * `undefined` keeps the executor on exactly the path it had before: no
   * `prepareStep` is installed unless the application asked for one, and no
   * boundary does any work.
   */
  injection?: AgentInjectionRegistry;
}

/** What the runtime hands `executeRun` for one accepted run. */
export interface RunExecutionInput<CONTEXT> {
  acceptedRun: AgentRun;
  context: CONTEXT;
  signal: AbortSignal;
  /** The admission lane this run belongs to — the key injection is offered on. */
  key: string;
  /** Recovery uses this to distinguish queue handoff from durable acquisition. */
  onAcquired?(): void;
}

/**
 * What every phase of one run reads and writes.
 *
 * These were locals of one closure; they are one object now so each phase
 * names what it touches by taking it, rather than by being written inside the
 * scope that declares it. Mutable on purpose: a phase that learns a newer run
 * revision leaves it here for the next phase, exactly as the closure did.
 */
export interface RunExecutionState {
  run: AgentRun;
  /**
   * The history the prompt was built from. Reassigned only from a read that
   * carries the conversation's messages.
   */
  snapshot: AgentSnapshot;
  /**
   * The conversation version this executor last observed.
   *
   * It tracks `snapshot` while there is one to track, and outlives it: after
   * the stream, both the durable-interrupt path and the terminal resolution
   * learn a newer version from a one-run read that carries no messages at
   * all. `snapshot` stays what it has always been — the history the prompt
   * was built from — and is not reassigned from a read that has no history in
   * it.
   */
  observedVersion: number;
  assistant: AgentMessage;
  readonly parts: AgentMessagePart[];
  /**
   * Inputs this run took on at a step boundary, and has not yet committed.
   *
   * Local until the terminal commit. A run that ends any other way — a crash,
   * a close, an interrupt — leaves every one of these an ordinary queued run,
   * which is what makes the ordering safe (→ ADR 0113).
   */
  readonly absorbed: Map<string, string[]>;
  eventsSinceCheckpoint: number;
  sequence: number;
  terminalReason: AgentTerminalReason;
  // A requeued run re-executes from scratch and pays the provider again, so
  // its figure continues the one the earlier attempt persisted rather than
  // replacing it. Without the durable field there was nothing to continue
  // from: the crashed attempt's tokens lived only in an event its executor
  // never survived to emit.
  nonModelUsage: AgentUsage | undefined;
  modelUsage: AgentUsage | undefined;
  /**
   * What retried attempts cost. Kept apart from `modelUsage` because the
   * SDK's `finish` part carries the total for the attempt that finished and
   * `mergeModelTotals` takes that total as authoritative — folding an
   * abandoned attempt into the same figure lost it on the next `finish`.
   */
  abandonedUsage: AgentUsage | undefined;
  usage: AgentUsage | undefined;
  // Whether the provider ever told us the run was over. It is the difference
  // between a total and a floor, and it is the only thing `partial` can
  // honestly mean on a terminal event — it used to be a constant per event
  // kind, `true` on every checkpoint and `false` on every terminal including
  // the ones that were abandoned mid-stream.
  sawProviderFinish: boolean;
  step: number;
  selectedModel: AgentResolvedModel | undefined;
  internalCause: unknown;
  providerStreamCleanupFailure: unknown;
  reasoningPartIndex: number | undefined;
  firstOutputAt: number | undefined;
  terminalPolicyName: string | undefined;
  // The prompt size of the last completed step — the one number that says
  // how full the window is. Cumulative `usage.inputTokens` counts every
  // step's prompt again and is several times this; substituting it would
  // report a model as overflowing while it had room.
  lastPromptTokens: AgentUsageValue;
}

type RootTrace<CONTEXT, TOOLS extends ToolSet> = ReturnType<
  NonNullable<AgentRuntimeConfig<CONTEXT, TOOLS>['observe']>['rootTrace']
>;

/** One acquired run: its dependencies, its input, its state and its owned machinery. */
export interface RunExecution<CONTEXT, TOOLS extends ToolSet> {
  readonly dependencies: RunExecutorDependencies<CONTEXT, TOOLS>;
  readonly input: RunExecutionInput<CONTEXT>;
  readonly state: RunExecutionState;
  readonly trace: RootTrace<CONTEXT, TOOLS> | undefined;
  readonly runStartedAt: number;
  readonly idleDeadline: ReturnType<typeof createIdleDeadline>;
  readonly executionSignal: AbortSignal;
  /**
   * Owned mutations of this run take their turn here.
   *
   * The assistant checkpoint and the model-request admission are written by
   * two independent schedules — the stream consumer and the SDK's model
   * middleware — against one compare-and-set revision.
   */
  readonly serialize: RunMutationQueue;
  readonly operationLifecycle: ReturnType<typeof createAgentRunOperationLifecycle>;
}

/** A snapshot this run's own mutation produced becomes the one it continues from. */
export function adoptSnapshot(state: RunExecutionState, next: AgentSnapshot): void {
  state.snapshot = next;
  state.observedVersion = next.version;
  state.run = findRun(next.runs, state.run.id);
}

/**
 * The next transient sequence — taken only when something is published.
 *
 * It used to advance on every stream part, published or not, so a run's
 * first delta arrived as sequence 4 behind an unpublished `text-start`:
 * every subscriber's cursor saw a gap on the first delta of every run,
 * flagged a resync and stopped accumulating the text it was for.
 */
export function transientSequence(state: RunExecutionState): number {
  state.sequence += 1;
  return state.sequence;
}

export function billedUsage(state: RunExecutionState): AgentUsage | undefined {
  return state.abandonedUsage && state.modelUsage
    ? addUsage(state.abandonedUsage, state.modelUsage)
    : (state.abandonedUsage ?? state.modelUsage);
}

export function updateReasoning(
  state: RunExecutionState,
  text: string,
  metadata?: unknown,
): void {
  const { parts } = state;
  const provider = providerEnvelope(metadata);
  if (state.reasoningPartIndex === undefined) {
    state.reasoningPartIndex = parts.length;
    parts.push(
      AgentMessagePartSchema.parse({
        type: 'reasoning',
        text,
        ...(provider && { provider }),
      }),
    );
    return;
  }
  const current = parts[state.reasoningPartIndex];
  if (current?.type !== 'reasoning') {
    throw new AgentRuntimeConflictError('reasoning accumulator');
  }
  parts.splice(
    state.reasoningPartIndex,
    1,
    AgentMessagePartSchema.parse({
      ...current,
      text: current.text + text,
      ...(provider && { provider }),
    }),
  );
}

export function checkpoint<CONTEXT, TOOLS extends ToolSet>(
  execution: RunExecution<CONTEXT, TOOLS>,
): Promise<void> {
  const { config, runtimeEpoch, publish, now } = execution.dependencies;
  const { state } = execution;
  return execution.serialize(async () => {
    state.assistant = AgentMessageSchema.parse({
      ...state.assistant,
      parts: state.parts,
      updatedAt: now().toISOString(),
    });
    const run = state.run;
    adoptSnapshot(
      state,
      appliedSnapshot(
        await config.store.checkpointRunAssistant({
          conversationId: run.conversationId,
          runId: run.id,
          expectedRevision: run.revision,
          ownerId: runtimeEpoch,
          ...(run.fencingToken !== undefined && { fencingToken: run.fencingToken }),
          assistant: state.assistant,
          usage: statedUsage(state.usage),
        }),
        'assistant checkpoint',
      ),
    );
    const checkpointMetrics = {
      // Always true here, and now for a reason rather than by construction:
      // a checkpoint is by definition taken before the provider has finished.
      partial: true,
      durationMs: performance.now() - execution.runStartedAt,
      usage: statedUsage(state.usage),
      ...(state.firstOutputAt !== undefined && {
        ttftMs: state.firstOutputAt - execution.runStartedAt,
      }),
    };
    await publish({
      type: 'assistant-checkpoint',
      eventId: agentDurableEventId(
        'assistant-checkpoint',
        state.run.id,
        state.observedVersion,
      ),
      conversationId: state.run.conversationId,
      runId: state.run.id,
      snapshotVersion: state.observedVersion,
      message: state.assistant,
      metrics: checkpointMetrics,
      emittedAt: now().toISOString(),
    });
  });
}
