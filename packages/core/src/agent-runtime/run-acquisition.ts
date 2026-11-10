import type { ToolSet } from 'ai';
import { createMutationQueue } from '../internal/mutation-queue';
import { agentDurableEventId } from './events';
import {
  adoptSnapshot,
  type RunExecution,
  type RunExecutionInput,
  type RunExecutorDependencies,
} from './run-execution-state';
import { createAgentRunOperationLifecycle } from './run-operation-lifecycle';
import { withStoreRetries } from './run-store-retry';
import { createIdleDeadline, findRun } from './runtime-internals';
import type { AgentRuntimeResult } from './runtime-result';
import { AgentMessageSchema } from './schemas';
import { AgentRuntimeConflictError, appliedSnapshot } from './terminal-commit';

/**
 * The first phase of `executeRun`: the durable record either already holds
 * this run's answer, or this executor now owns the run. Nothing after the
 * ownership write happens here, because from that write on a failure has a run
 * to close: {@link beginRunExecution} runs under the executor's `try`.
 */
export type RunAcquisition<CONTEXT, TOOLS extends ToolSet> =
  | { kind: 'absorbed'; result: AgentRuntimeResult }
  | { kind: 'acquired'; execution: RunExecution<CONTEXT, TOOLS> };

export async function acquireRun<CONTEXT, TOOLS extends ToolSet>(
  dependencies: RunExecutorDependencies<CONTEXT, TOOLS>,
  input: RunExecutionInput<CONTEXT>,
): Promise<RunAcquisition<CONTEXT, TOOLS>> {
  const { config, runtimeEpoch, now, idleTimeoutMs, injection } = dependencies;
  // This run is no longer a queued successor, whatever happens next, so it
  // stops being something another run may take on. First, before any I/O that
  // can throw: no ordering may let a run absorb the input it is itself about
  // to answer, and a read that fails must not leave a stale offer behind.
  injection?.withdraw(input.key, input.acceptedRun.id);
  // The run, not the conversation it lives in: all this needs is a revision
  // to acquire against.
  const queued = await withStoreRetries(() =>
    config.store.loadRun({
      conversationId: input.acceptedRun.conversationId,
      runId: input.acceptedRun.id,
    }),
  );
  if (!queued) throw new AgentRuntimeConflictError('run lookup');
  // Its input was taken on by a run that has already answered it. Nothing to
  // execute; the answer is on the absorbing run, and this is the path that
  // resolves it both in-process and after a restart, because it is reached
  // from the durable record rather than from anything held in memory.
  if (queued.run.terminalReason === 'absorbed') {
    const { absorbedIntoRunId } = queued.run;
    const absorbing = absorbedIntoRunId
      ? await withStoreRetries(() =>
          config.store.loadRun({
            conversationId: queued.run.conversationId,
            runId: absorbedIntoRunId,
          }),
        )
      : undefined;
    if (!absorbing?.assistant || !absorbing.run.terminalReason) {
      throw new AgentRuntimeConflictError('absorbed run resolution');
    }
    input.onAcquired?.();
    return {
      kind: 'absorbed',
      result: {
        run: absorbing.run,
        message: absorbing.assistant,
        reason: absorbing.run.terminalReason,
        snapshotVersion: absorbing.snapshotVersion,
        ...(absorbing.run.terminalPolicyName && {
          policyName: absorbing.run.terminalPolicyName,
        }),
      },
    };
  }
  const queuedRun = queued.run;
  const acquired = appliedSnapshot(
    await withStoreRetries(() =>
      config.store.acquireRun({
        conversationId: queuedRun.conversationId,
        runId: queuedRun.id,
        expectedRevision: queuedRun.revision,
        ownerId: runtimeEpoch,
      }),
    ),
    'run acquisition',
  );
  const run = findRun(acquired.runs, input.acceptedRun.id);
  input.onAcquired?.();
  const trace = config.observe?.rootTrace();
  const runStartedAt = performance.now();
  const assistant = AgentMessageSchema.parse({
    schemaVersion: 1,
    id: run.assistantMessageId,
    conversationId: run.conversationId,
    runId: run.id,
    role: 'assistant',
    status: 'streaming',
    parts: [],
    createdAt: now().toISOString(),
    updatedAt: now().toISOString(),
  });

  const state: RunExecution<CONTEXT, TOOLS>['state'] = {
    run,
    snapshot: acquired,
    observedVersion: acquired.version,
    assistant,
    parts: [],
    absorbed: new Map<string, string[]>(),
    eventsSinceCheckpoint: 0,
    sequence: 0,
    settledToolCalls: new Set<string>(),
    terminalReason: 'success',
    nonModelUsage: input.acceptedRun.usage,
    modelUsage: undefined,
    abandonedUsage: undefined,
    usage: input.acceptedRun.usage,
    sawProviderFinish: false,
    step: 0,
    selectedModel: undefined,
    internalCause: undefined,
    providerStreamCleanupFailure: undefined,
    reasoningPartIndex: undefined,
    firstOutputAt: undefined,
    terminalPolicyName: undefined,
    lastPromptTokens: { provenance: 'unavailable' },
  };
  const idleDeadline = createIdleDeadline(input.signal, idleTimeoutMs);
  const serialize = createMutationQueue();
  const operationLifecycle = createAgentRunOperationLifecycle({
    store: config.store,
    runtimeEpoch,
    serialize,
    currentRun: () => state.run,
    acceptSnapshot: (next) => adoptSnapshot(state, next),
    publish: dependencies.publish,
    now,
  });
  return {
    kind: 'acquired',
    execution: {
      dependencies,
      input,
      state,
      trace,
      runStartedAt,
      idleDeadline,
      executionSignal: idleDeadline.signal,
      serialize,
      operationLifecycle,
    },
  };
}

/**
 * The owned half of acquisition: tell the surfaces, and store the assistant
 * draft. A failure here reaches `classifyRunFailure` like any other, so the run
 * ends in a terminal instead of staying `running` with an owner that has left.
 */
export async function beginRunExecution<CONTEXT, TOOLS extends ToolSet>(
  execution: RunExecution<CONTEXT, TOOLS>,
): Promise<void> {
  const { config, publish, runtimeEpoch, generateId, now } = execution.dependencies;
  const { state, trace } = execution;
  const { run, assistant } = state;
  await publish({
    type: 'run-state',
    eventId: agentDurableEventId('run-state', run.id, state.observedVersion),
    conversationId: run.conversationId,
    runId: run.id,
    snapshotVersion: state.observedVersion,
    state: run.state,
    emittedAt: now().toISOString(),
  });
  config.observe?.emit({
    schemaVersion: 1,
    eventId: generateId(),
    type: 'run-started',
    conversationId: run.conversationId,
    runId: run.id,
    traceId: trace?.traceId ?? generateId(),
    spanId: trace?.spanId ?? generateId(),
    ...(trace?.parentSpanId && { parentSpanId: trace.parentSpanId }),
    state: run.state,
    queueWaitMs: Math.max(0, now().getTime() - new Date(run.createdAt).getTime()),
    emittedAt: now().toISOString(),
  });
  adoptSnapshot(
    state,
    appliedSnapshot(
      await config.store.checkpointRunAssistant({
        conversationId: run.conversationId,
        runId: run.id,
        expectedRevision: run.revision,
        ownerId: runtimeEpoch,
        ...(run.fencingToken !== undefined && { fencingToken: run.fencingToken }),
        assistant,
      }),
      'assistant draft',
    ),
  );
}
