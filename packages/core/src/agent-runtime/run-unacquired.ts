import type { ToolSet } from 'ai';
import { agentDurableEventId } from './events';
import type { RunExecutionInput, RunExecutorDependencies } from './run-execution-state';
import { withStoreRetries } from './run-store-retry';
import { statedUsage } from './runtime-internals';
import type { AgentRuntimeResult } from './runtime-result';
import { isActiveRunState } from './store-driver-contract';
import {
  AgentRuntimeConflictError,
  AgentRunUnsettledError,
  terminalOfRunView,
  terminalOfSnapshot,
} from './terminal-commit';

/**
 * A run that never reached execution, closed from outside.
 *
 * Acquisition failed, so this executor has nothing to commit a terminal with,
 * and left alone the record blocks every later turn of the conversation: the
 * store refuses to acquire past an earlier active run. A store failure ends it
 * as `abandoned`, the state an operator's `abandon` would give it.
 *
 * Two records are not that run's to close. One executed here or by another
 * process is theirs to settle. One queued behind another run lost a real conflict:
 * it stays for `recover()`, and `AgentRunUnsettledError` says nothing in this
 * process is behind it. A run owned by this process with no executor here is the
 * remaining case: the reply to its own acquisition was lost, so it is closed too.
 */
export async function closeUnacquiredRun<CONTEXT, TOOLS extends ToolSet>(
  dependencies: RunExecutorDependencies<CONTEXT, TOOLS>,
  input: RunExecutionInput<CONTEXT>,
  failure: unknown,
  executing: ReadonlySet<string>,
): Promise<AgentRuntimeResult> {
  const { config, publish, runtimeEpoch, generateId, now } = dependencies;
  const { conversationId, id: runId } = input.acceptedRun;
  const view = await withStoreRetries(() =>
    config.store.loadRun({ conversationId, runId }),
  ).catch(() => {
    throw new AgentRunUnsettledError(input.acceptedRun, runtimeEpoch, failure);
  });
  if (!view || !isActiveRunState(view.run.state)) throw failure;
  const { run } = view;
  if (run.ownerId !== undefined && run.ownerId !== runtimeEpoch) throw failure;
  if (executing.has(runId)) throw failure;
  const unsettled = new AgentRunUnsettledError(run, runtimeEpoch, failure);
  if (failure instanceof AgentRuntimeConflictError && run.ownerId === undefined)
    throw unsettled;
  const abandoned = await withStoreRetries(() =>
    config.store.recoverRun({
      conversationId,
      runId,
      expectedRevision: run.revision,
      action: 'abandon',
    }),
  ).catch(() => undefined);
  // A reply lost after the write leaves nothing to read but the record itself.
  const terminal =
    abandoned?.outcome === 'applied'
      ? terminalOfSnapshot(abandoned.snapshot, runId)
      : await withStoreRetries(() => config.store.loadRun({ conversationId, runId })).then(
          (latest) => (latest ? terminalOfRunView(latest, conversationId) : undefined),
          () => undefined,
        );
  if (terminal?.reason !== 'abandoned') throw unsettled;
  input.onAcquired?.();
  const version = terminal.snapshotVersion;
  const usage = statedUsage(terminal.run.usage);
  const emittedAt = now().toISOString();
  await publish({
    type: 'run-state',
    eventId: agentDurableEventId('run-state', runId, version),
    conversationId,
    runId,
    snapshotVersion: version,
    state: terminal.run.state,
    emittedAt,
  });
  // The result says the run was abandoned; only the operator's channel says why.
  config.observe?.emit({
    schemaVersion: 1,
    eventId: agentDurableEventId('terminal', runId, version),
    type: 'run-terminal',
    conversationId,
    runId,
    traceId: generateId(),
    spanId: generateId(),
    state: terminal.run.state,
    terminalReason: terminal.reason,
    durationMs: 0,
    usage,
    internalCause: failure,
    emittedAt,
  });
  const metrics = { partial: true, durationMs: 0, usage };
  await publish({
    type: 'terminal',
    eventId: agentDurableEventId('terminal', runId, version),
    conversationId,
    runId,
    snapshotVersion: version,
    reason: terminal.reason,
    message: terminal.assistant,
    metrics,
    emittedAt,
  });
  return {
    run: terminal.run,
    message: terminal.assistant,
    reason: terminal.reason,
    snapshotVersion: version,
    metrics,
  };
}
