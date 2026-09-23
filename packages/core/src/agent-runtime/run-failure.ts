import type { ToolSet } from 'ai';
import { isToolExecutionControlError } from '../tools/execute';
import { AgentContextOverflowError } from './context-refusal';
import { hasProviderOrigin, isOwnInputRefusal } from './provider-origin';
import type { RunExecution } from './run-execution-state';
import { abortTerminalReason } from './runtime-internals';
import { AgentMessagePartSchema, type AgentTerminalReason } from './schemas';
import { AgentRuntimeConflictError } from './terminal-commit';

/**
 * The terminal reason for a failure this runtime raises on its own behalf.
 *
 * `undefined` means the runtime cannot claim the failure — which, at both call
 * sites, leaves it the provider's. One function because both sites answer the
 * same question and used to answer it differently.
 */
export function failureThisRuntimeOwns(error: unknown): AgentTerminalReason | undefined {
  if (error instanceof AgentContextOverflowError) return 'context_overflow';
  if (error instanceof AgentRuntimeConflictError) return 'storage_conflict';
  if (isOwnInputRefusal(error)) return 'runtime_failure';
  return undefined;
}

/**
 * A throw out of preparation or the stream, turned into the terminal the run
 * will commit. It never rethrows: every failure that reaches here ends as a
 * durable terminal with its cause attached.
 */
export async function classifyRunFailure<CONTEXT, TOOLS extends ToolSet>(
  execution: RunExecution<CONTEXT, TOOLS>,
  error: unknown,
): Promise<void> {
  const { config, runtimeEpoch } = execution.dependencies;
  const { state, operationLifecycle, executionSignal } = execution;
  operationLifecycle.failStepCheckpoints(error);
  // Both failures, with the primary one still leading. An object literal
  // here would stop being an `Error`: a sink that prints `internalCause`
  // renders `[object Object]` and loses the stack, and the message a reader
  // needs is the storage failure, not the cleanup that followed it. The
  // conformance kit already composes a primary with a teardown failure this
  // way, and one shape for one idea is the whole rule.
  const cleanupFailure = state.providerStreamCleanupFailure;
  state.internalCause =
    cleanupFailure === undefined
      ? error
      : new AggregateError(
          [error, cleanupFailure],
          `${error instanceof Error ? error.message : String(error)} (provider stream cleanup also failed: ${
            cleanupFailure instanceof Error ? cleanupFailure.message : String(cleanupFailure)
          })`,
        );
  const latest = await config.store.loadRun({
    conversationId: state.run.conversationId,
    runId: state.run.id,
  });
  const latestRun = latest?.run;
  const durableInterrupt =
    latestRun?.ownerId === runtimeEpoch && latestRun.state === 'interrupt_requested';
  if (durableInterrupt && latest && latestRun) {
    // Only the version, never the messages: history was projected before
    // the stream started and nothing reads it again from here on.
    state.observedVersion = latest.snapshotVersion;
    state.run = latestRun;
  }
  const staleOwner = isToolExecutionControlError(error) && error.reason === 'stale_run';
  if (!staleOwner) {
    await operationLifecycle.finish(
      executionSignal.aborted || durableInterrupt ? 'cancelled' : 'failed',
    );
  }
  if (isToolExecutionControlError(error) || executionSignal.aborted || durableInterrupt) {
    state.terminalReason = executionSignal.aborted
      ? abortTerminalReason(executionSignal)
      : 'interrupted';
    state.parts.push(
      AgentMessagePartSchema.parse({
        type: 'control',
        reason:
          isToolExecutionControlError(error) && error.reason === 'stale_run'
            ? 'stale-run'
            : 'run-interrupted',
      }),
    );
  } else if (error instanceof AgentContextOverflowError) {
    state.terminalReason = 'context_overflow';
  } else if (error instanceof AgentRuntimeConflictError) {
    // The store refused an owned mutation. Nothing upstream failed, and in
    // the case this was written for the provider was never called at all.
    state.terminalReason = 'storage_conflict';
  } else {
    // A throw reaching here is the runtime's own unless it was marked at
    // the provider boundary — the same argument as `context_overflow`
    // above, applied to every failure this runtime raises on its behalf.
    state.terminalReason =
      failureThisRuntimeOwns(error) ??
      (hasProviderOrigin(error) ? 'provider_failure' : 'runtime_failure');
  }
}
