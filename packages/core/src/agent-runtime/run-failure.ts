import type { ToolSet } from 'ai';
import { isToolExecutionControlError } from '../tools/execute';
import { AgentContextOverflowError } from './context-refusal';
import { InvocationReceiptError } from './invocation-failure';
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
  if (error instanceof InvocationReceiptError) return 'runtime_failure';
  if (error instanceof AgentContextOverflowError) return 'context_overflow';
  if (error instanceof AgentRuntimeConflictError) return 'storage_conflict';
  if (isOwnInputRefusal(error)) return 'runtime_failure';
  return undefined;
}

/**
 * Both failures, with the primary one still leading. An object literal here
 * would stop being an `Error`: a sink that prints `internalCause` renders
 * `[object Object]` and loses the stack, and the message a reader needs is the
 * first failure, not what followed it. The conformance kit composes a primary
 * with a teardown failure the same way.
 */
function withLaterFailure(primary: unknown, later: unknown, what: string): unknown {
  return new AggregateError(
    [primary, later],
    `${primary instanceof Error ? primary.message : String(primary)} (${what} also failed: ${
      later instanceof Error ? later.message : String(later)
    })`,
  );
}

/**
 * A throw out of preparation or the stream, turned into the terminal the run
 * will commit. It never rethrows: every failure that reaches here ends as a
 * durable terminal with its cause attached, or as `AgentRunUnsettledError` when
 * the store refuses that terminal too. The two reads below are therefore
 * guarded: a store that fails them is the likely reason to be here, and what
 * they would have added is not worth the run's terminal.
 */
export async function classifyRunFailure<CONTEXT, TOOLS extends ToolSet>(
  execution: RunExecution<CONTEXT, TOOLS>,
  error: unknown,
): Promise<void> {
  const { config, runtimeEpoch } = execution.dependencies;
  const { state, operationLifecycle, executionSignal } = execution;
  operationLifecycle.failStepCheckpoints(error);
  const cleanupFailure = state.providerStreamCleanupFailure;
  state.internalCause =
    cleanupFailure === undefined
      ? error
      : withLaterFailure(error, cleanupFailure, 'provider stream cleanup');
  let latest: Awaited<ReturnType<typeof config.store.loadRun>>;
  try {
    latest = await config.store.loadRun({
      conversationId: state.run.conversationId,
      runId: state.run.id,
    });
  } catch (readFailure) {
    state.internalCause = withLaterFailure(state.internalCause, readFailure, 'the run read');
  }
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
    try {
      await operationLifecycle.finish(
        executionSignal.aborted || durableInterrupt ? 'cancelled' : 'failed',
      );
    } catch (finishFailure) {
      state.internalCause = withLaterFailure(
        state.internalCause,
        finishFailure,
        'closing the operations',
      );
    }
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
