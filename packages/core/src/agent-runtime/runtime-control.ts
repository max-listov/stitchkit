import type { ToolSet } from 'ai';
import {
  type AgentSessionCloseOptions,
  type AgentSessionCloseResult,
  assertCloseBudgets,
} from './coordinator';
import { agentDurableEventId } from './events';
import type { AgentRuntimeAbandonInput, AgentRuntimeInterruptInput } from './runtime';
import { findRun } from './runtime-internals';
import type { AgentRuntimeState } from './runtime-state';
import type { AgentStoreMutationResult } from './store';
import { AgentRuntimeConflictError } from './terminal-commit';

export async function interruptAgentRun<CONTEXT, TOOLS extends ToolSet>(
  state: AgentRuntimeState<CONTEXT, TOOLS>,
  input: AgentRuntimeInterruptInput,
): Promise<AgentStoreMutationResult> {
  const { store } = state.config;
  const view = await store.loadRun({
    conversationId: input.conversationId,
    runId: input.runId,
  });
  if (!view) throw new AgentRuntimeConflictError('run lookup');
  const requested = await store.requestRunInterrupt({
    conversationId: input.conversationId,
    runId: input.runId,
    expectedRevision: view.run.revision,
  });
  if (requested.outcome === 'applied') {
    const interruptedRun = findRun(requested.snapshot.runs, input.runId);
    await state.publish({
      type: 'run-state',
      eventId: agentDurableEventId('run-state', interruptedRun.id, requested.snapshot.version),
      conversationId: interruptedRun.conversationId,
      runId: interruptedRun.id,
      snapshotVersion: requested.snapshot.version,
      state: interruptedRun.state,
      emittedAt: state.now().toISOString(),
    });
    state.coordinator.stop(input.conversationKey ?? input.conversationId, 'user-interrupt');
  }
  return requested;
}

export async function abandonAgentRun<CONTEXT, TOOLS extends ToolSet>(
  state: AgentRuntimeState<CONTEXT, TOOLS>,
  input: AgentRuntimeAbandonInput,
): Promise<AgentStoreMutationResult> {
  if (input.staleOwner !== true) {
    throw new TypeError('Abandoning a run requires explicit staleOwner evidence');
  }
  const releaseAdmission = state.gate.begin();
  try {
    const abandoned = await state.config.store.recoverRun({
      conversationId: input.conversationId,
      runId: input.runId,
      expectedRevision: input.expectedRevision,
      action: 'abandon',
    });
    if (abandoned.outcome === 'applied') {
      const abandonedRun = findRun(abandoned.snapshot.runs, input.runId);
      await state.publish({
        type: 'run-state',
        eventId: agentDurableEventId('run-state', abandonedRun.id, abandoned.snapshot.version),
        conversationId: abandonedRun.conversationId,
        runId: abandonedRun.id,
        snapshotVersion: abandoned.snapshot.version,
        state: abandonedRun.state,
        emittedAt: state.now().toISOString(),
      });
    }
    return abandoned;
  } finally {
    releaseAdmission();
  }
}

export async function closeAgentRuntime<CONTEXT, TOOLS extends ToolSet>(
  state: AgentRuntimeState<CONTEXT, TOOLS>,
  options: AgentSessionCloseOptions,
): Promise<AgentSessionCloseResult> {
  // BEFORE the flag. A budget that is not a budget used to be discovered by
  // the coordinator, one await later — leaving a runtime that had stopped
  // admitting work and a caller holding a TypeError, with no way to undo
  // either. A refused call changes nothing.
  assertCloseBudgets(options);
  // Set before anything is awaited, so no admission can slip past while the
  // active runs are being drained.
  state.gate.closed = true;
  // Then wait for the ones already inside. Whatever this spends is taken
  // off the coordinator's budget rather than added to it.
  //
  // Measured monotonically, not with `config.now`: that clock is the
  // runtime's SEMANTIC one — a caller may set it to a fixed instant for
  // deterministic timestamps, and a wall clock steps backwards on its own.
  // Either makes the subtraction below meaningless.
  const startedAt = performance.now();
  // Nothing may be taken on after this point: an offer is only ever a
  // *permission* to absorb, and a closing runtime grants none. Every entry
  // dropped here is still a queued run in the store, so recovery answers it.
  state.injection?.clear();
  const stranded = await state.gate.drain(options.forceTimeoutMs);
  const spent = Math.max(0, Math.round(performance.now() - startedAt));
  const remainingBudget = (value: number | undefined): number | undefined =>
    value === undefined ? undefined : Math.max(0, value - spent);
  const grace = remainingBudget(options.gracePeriodMs);
  const force = remainingBudget(options.forceTimeoutMs);
  const result = await state.coordinator.close({
    ...(grace !== undefined && { gracePeriodMs: grace }),
    ...(force !== undefined && { forceTimeoutMs: force }),
  });
  // An admission that never handed off is work this close is walking away
  // from just as surely as an unfinished run, and it is counted as such.
  if (stranded === 0) return result;
  return { settled: false, timedOut: true, remaining: result.remaining + stranded };
}
