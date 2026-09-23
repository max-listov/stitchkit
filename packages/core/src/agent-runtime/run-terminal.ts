import type { ToolSet } from 'ai';
import { agentDurableEventId } from './events';
import type { RunExecution } from './run-execution-state';
import { abortTerminalReason, statedUsage } from './runtime-internals';
import type { AgentRuntimeResult } from './runtime-result';
import {
  AgentMessageSchema,
  type AgentRun,
  type AgentTerminalReason,
  runStateForTerminalReason,
} from './schemas';
import { commitAgentRunTerminal } from './terminal-commit';
import { assistantStatus } from './terminal-status';

/**
 * The terminal reason of a stream that ended without a throw: a stop policy,
 * an abort, and the protocol's verdict on the output all have their say.
 */
export async function settleStreamOutcome<CONTEXT, TOOLS extends ToolSet>(
  execution: RunExecution<CONTEXT, TOOLS>,
): Promise<void> {
  const { config, now } = execution.dependencies;
  const { state, executionSignal } = execution;
  await execution.operationLifecycle.finish(
    executionSignal.aborted
      ? 'cancelled'
      : state.terminalReason === 'provider_failure'
        ? 'failed'
        : 'completed',
  );
  if (state.terminalPolicyName !== undefined) state.terminalReason = 'policy_stop';
  if (executionSignal.aborted) state.terminalReason = abortTerminalReason(executionSignal);
  const awaitsApproval = state.parts.some((part) => part.type === 'tool-approval-request');
  if (
    !awaitsApproval &&
    config.protocol.acceptTerminal &&
    (state.terminalReason === 'success' ||
      state.terminalReason === 'policy_stop' ||
      state.terminalReason === 'provider_stop')
  ) {
    const candidate = AgentMessageSchema.parse({
      ...state.assistant,
      status: assistantStatus(state.terminalReason),
      parts: state.parts,
      updatedAt: now().toISOString(),
    });
    if (
      !(await config.protocol.acceptTerminal({
        message: candidate,
        reason: state.terminalReason,
        ...(state.terminalPolicyName && { policyName: state.terminalPolicyName }),
      }))
    ) {
      state.terminalReason = 'output_rejected';
      state.internalCause = new Error('Agent terminal output was rejected by the protocol');
    }
  }
}

/** The operator's record of what this executor spent, whoever settled the run. */
function emitSpend<CONTEXT, TOOLS extends ToolSet>(
  execution: RunExecution<CONTEXT, TOOLS>,
  report: {
    eventId: string;
    state: AgentRun['state'];
    reason: AgentTerminalReason;
    usage: ReturnType<typeof statedUsage>;
  },
): void {
  const { config, generateId, now } = execution.dependencies;
  const { state, trace, runStartedAt } = execution;
  config.observe?.emit({
    schemaVersion: 1,
    eventId: report.eventId,
    type: 'run-terminal',
    conversationId: state.run.conversationId,
    runId: state.run.id,
    traceId: trace?.traceId ?? generateId(),
    spanId: trace?.spanId ?? generateId(),
    ...(trace?.parentSpanId && { parentSpanId: trace.parentSpanId }),
    state: report.state,
    terminalReason: report.reason,
    ...(state.selectedModel && { modelId: state.selectedModel.descriptor.modelId }),
    durationMs: performance.now() - runStartedAt,
    usage: report.usage,
    ...(state.internalCause !== undefined && { internalCause: state.internalCause }),
    ...(state.firstOutputAt !== undefined && { ttftMs: state.firstOutputAt - runStartedAt }),
    emittedAt: now().toISOString(),
  });
}

/**
 * The parent's terminal is durable by now. Children belong to the
 * conversation, not to this run: they are stopped when this run ended by
 * an explicit stop — interrupted, cancelled, timed out, shut down — and
 * left alone when the conversation goes on without it (a successful or
 * policy-stopped answer, a successor that superseded it, a failure a
 * retry may follow), bounded by their own budgets. A failure here is this
 * run's to report, not to hide and not to fail the committed terminal
 * with — it rides into the operator event as the cause.
 */
async function stopChildrenAfterExplicitStop<CONTEXT, TOOLS extends ToolSet>(
  execution: RunExecution<CONTEXT, TOOLS>,
  committedByCaller: boolean,
): Promise<void> {
  const { config } = execution.dependencies;
  const { state } = execution;
  if (
    config.children &&
    committedByCaller &&
    (state.terminalReason === 'interrupted' ||
      state.terminalReason === 'cancelled' ||
      state.terminalReason === 'timeout' ||
      state.terminalReason === 'shutdown')
  ) {
    try {
      await config.children.stopChildren(state.run.conversationId);
    } catch (error) {
      state.internalCause ??= error;
    }
  }
}

/** Commit the terminal the earlier phases decided, and report it on both channels. */
export async function commitRunTerminal<CONTEXT, TOOLS extends ToolSet>(
  execution: RunExecution<CONTEXT, TOOLS>,
): Promise<AgentRuntimeResult> {
  const { config, publish, runtimeEpoch, now } = execution.dependencies;
  const { state, runStartedAt } = execution;
  state.assistant = AgentMessageSchema.parse({
    ...state.assistant,
    status: assistantStatus(state.terminalReason),
    parts: state.parts,
    updatedAt: now().toISOString(),
  });
  // Never absent. An omitted `usage` said the same thing about a run that
  // never reached the provider and a run that burned a minute of the most
  // expensive model available — and only one of those spent money.
  const spent = statedUsage(state.usage);
  // A losing executor reports a DIFFERENT fact — its own spend for a run it
  // did not settle — so its event must not wear the winner's identity. Both
  // used to derive `${runId}:terminal:${version}` from the same post-commit
  // snapshot, and the sink's default deduplication then dropped whichever
  // arrived second, discarding one of the two spend figures. Qualified by the
  // epoch, the id is still stable for this executor and unique between them.
  const unsettledEventId = (version: number): string =>
    agentDurableEventId('terminal', `${state.run.id}:${runtimeEpoch}`, version);

  let terminal: Awaited<ReturnType<typeof commitAgentRunTerminal>>;
  try {
    terminal = await commitAgentRunTerminal({
      store: config.store,
      runtimeEpoch,
      candidate: {
        run: state.run,
        assistant: state.assistant,
        reason: state.terminalReason,
        ...(state.terminalPolicyName && { policyName: state.terminalPolicyName }),
        usage: spent,
        // Only a run that finished may claim to have answered somebody
        // else's input. Anything else leaves the successor queued, to be
        // answered by its own run — which is what makes a crash, a close or
        // an interrupt between the boundary and here safe.
        ...(state.absorbed.size > 0 &&
          runStateForTerminalReason(state.terminalReason) === 'completed' && {
            absorb: [...state.absorbed].map(([runId, inputMessageIds]) => ({
              runId,
              inputMessageIds,
            })),
          }),
      },
      now,
    });
  } catch (error) {
    // Where the record ends up is now someone else's to decide — the lease
    // was taken, or the row moved under us. What this executor SPENT getting
    // here is not in doubt, and dropping it is how a stolen run produced four
    // fully billed steps and no row on either channel. `state` is the run as
    // this executor last knew it, which is exactly the claim being made: an
    // execution stopped here, and it did not settle the record.
    emitSpend(execution, {
      eventId: unsettledEventId(state.observedVersion),
      state: state.run.state,
      reason: state.terminalReason,
      usage: spent,
    });
    throw error;
  }
  state.observedVersion = terminal.snapshotVersion;
  state.run = terminal.run;
  state.assistant = terminal.assistant;
  state.terminalReason = terminal.reason;
  state.terminalPolicyName = terminal.policyName;
  const terminalMetrics = terminal.committedByCaller
    ? {
        partial: !state.sawProviderFinish,
        durationMs: performance.now() - runStartedAt,
        usage: spent,
        ...(state.firstOutputAt !== undefined && {
          ttftMs: state.firstOutputAt - runStartedAt,
        }),
      }
    : undefined;
  // The two channels are not gated alike, because they are not for the same
  // reader. Observability is the operator's, and it is about what THIS
  // executor spent — money that is real whether or not this executor won the
  // terminal CAS. Delivery carries the assistant message to the application's
  // transport, so emitting it for a run someone else committed would deliver
  // the same turn twice. Gating both on `committedByCaller` is why an
  // executor that lost the race reported nothing at all.
  await stopChildrenAfterExplicitStop(execution, terminal.committedByCaller);
  emitSpend(execution, {
    eventId: terminal.committedByCaller
      ? agentDurableEventId('terminal', state.run.id, state.observedVersion)
      : unsettledEventId(state.observedVersion),
    state: state.run.state,
    reason: state.terminalReason,
    usage: spent,
  });
  // A run that was admitted as `queued` and then absorbed publishes nothing
  // else on its own — it never enters the executor's body. Without this a
  // surface following that runId waits for a state that never comes.
  for (const settled of terminal.absorbed ?? []) {
    await publish({
      type: 'run-state',
      eventId: agentDurableEventId('run-state', settled.id, state.observedVersion),
      conversationId: settled.conversationId,
      runId: settled.id,
      snapshotVersion: state.observedVersion,
      state: settled.state,
      emittedAt: now().toISOString(),
    });
  }
  if (terminalMetrics) {
    await publish({
      type: 'terminal',
      eventId: agentDurableEventId('terminal', state.run.id, state.observedVersion),
      conversationId: state.run.conversationId,
      runId: state.run.id,
      snapshotVersion: state.observedVersion,
      reason: state.terminalReason,
      ...(state.terminalPolicyName && { policyName: state.terminalPolicyName }),
      message: state.assistant,
      metrics: terminalMetrics,
      emittedAt: now().toISOString(),
    });
  }
  return {
    run: state.run,
    message: state.assistant,
    reason: state.terminalReason,
    snapshotVersion: state.observedVersion,
    ...(terminalMetrics && { metrics: terminalMetrics }),
    ...(state.terminalPolicyName && { policyName: state.terminalPolicyName }),
  };
}
