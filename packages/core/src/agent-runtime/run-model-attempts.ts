import { setTimeout as delay } from 'node:timers/promises';
import type { AgentModelMessage } from '../agent-parts/model';
import type { AgentToolSet } from '../tools/agent-tools';
import { deferredToolRepair } from './deferred-tools-internal';
import type { AgentInjectableInput } from './injection';
import type { AgentToolCallRepairFunction } from './models-driver-step';
import { type AgentProviderFailureReason, classifyProviderFailure } from './provider-failure';
import { hasProviderOrigin } from './provider-origin';
import { recordAgentRetryDecision } from './retry-policy';
import {
  checkpoint,
  type RunExecution,
  runUsage,
  transientSequence,
} from './run-execution-state';
import { failureThisRuntimeOwns } from './run-failure';
import type { AgentLoopEvent } from './run-loop-events';
import { executeOneModelStep, type StepRunState } from './run-model-step';
import { createRunProviderLedger, type RunProviderLedger } from './run-provider-ledger';
import { evaluateTerminalContinuation } from './run-step-prepare';
import {
  applyStreamPart,
  isOutputPart,
  STRUCTURAL_BOUNDARY_PARTS,
  type StreamPartScope,
  TOOL_STATUS_PARTS,
} from './run-stream-parts';
import { resetStepTextTracking } from './run-stream-step-text';
import { executeApprovalContinuations } from './run-tool-approval-flow';
import type { PreparedTurn } from './run-turn-preparation';
import { addUsage } from './runtime-internals';
import type { AgentUsage } from './schemas';
import { unknownUsage } from './schemas-usage-state';

const DEFAULT_MAX_CONTINUATIONS = 3;

interface AttemptLoopState {
  retryAttempt: number;
  retryWindowStart: number;
  takenThisAttempt: AgentInjectableInput[];
}

interface ModelAttempt {
  readonly providerAttempt: number;
  readonly attemptPartStart: number;
  retrying: boolean;
  draining: boolean;
  retryDelayMs: number;
  discardReason?: AgentProviderFailureReason;
  discardUsage?: AgentUsage;
}

interface AttemptContext<CONTEXT, TOOLS extends AgentToolSet> {
  execution: RunExecution<CONTEXT, TOOLS>;
  turn: PreparedTurn<CONTEXT, TOOLS>;
  loop: AttemptLoopState;
  ledger: RunProviderLedger;
  baseMessages: readonly AgentModelMessage[];
}

function chainRepairHooks(
  primary: AgentToolCallRepairFunction | undefined,
  secondary: AgentToolCallRepairFunction | undefined,
): AgentToolCallRepairFunction | undefined {
  if (!primary) return secondary;
  if (!secondary) return primary;
  return async (input) => (await primary(input)) ?? secondary(input);
}

async function takeInjectedMessages<CONTEXT, TOOLS extends AgentToolSet>(
  context: AttemptContext<CONTEXT, TOOLS>,
): Promise<AgentModelMessage[]> {
  const { execution, turn, loop } = context;
  const { state } = execution;
  const taken =
    execution.dependencies.injection?.take(execution.input.key, state.run.id) ?? [];
  if (taken.length === 0) return [];
  loop.takenThisAttempt.push(...taken);
  const messages: AgentModelMessage[] = [];
  for (const entry of taken) {
    messages.push(...(await turn.projection.projectInputs([entry.input])));
    const ids = state.absorbed.get(entry.runId) ?? [];
    ids.push(entry.input.id);
    state.absorbed.set(entry.runId, ids);
  }
  return messages;
}

async function retryAfterProviderError<CONTEXT, TOOLS extends AgentToolSet>(
  context: AttemptContext<CONTEXT, TOOLS>,
  attempt: ModelAttempt,
  error: unknown,
  attemptTotalUsage?: AgentUsage,
): Promise<boolean> {
  const { execution, loop } = context;
  const { config, injection } = execution.dependencies;
  const { state, executionSignal } = execution;
  const retry = config.loop?.retry;
  if (!retry || failureThisRuntimeOwns(error) !== undefined || executionSignal.aborted) {
    return false;
  }
  const invokedTool = state.parts
    .slice(attempt.attemptPartStart)
    .some((candidate) => candidate.type === 'tool-call' || candidate.type === 'tool-result');
  const failure = classifyProviderFailure(error);
  const decision = invokedTool
    ? { retry: false, delayMs: 0 }
    : await recordAgentRetryDecision({
        store: config.store,
        conversationId: state.run.conversationId,
        attempt: loop.retryAttempt,
        failure,
        policy: retry,
        elapsedMs: Math.max(0, performance.now() - loop.retryWindowStart),
      });
  if (!decision.retry) return false;
  await execution.operationLifecycle.finish('failed');
  if (state.modelUsage !== undefined) {
    state.abandonedUsage = state.abandonedUsage
      ? addUsage(state.abandonedUsage, state.modelUsage)
      : state.modelUsage;
    state.modelUsage = undefined;
    state.usage = runUsage(state);
  }
  state.parts.splice(attempt.attemptPartStart);
  state.reasoningPartIndex = undefined;
  state.reasoningPartIndexes.clear();
  state.textPartIndex = undefined;
  state.textPartIndexes.clear();
  for (const entry of loop.takenThisAttempt) {
    injection?.offer(execution.input.key, entry);
    const ids = state.absorbed.get(entry.runId);
    if (ids) {
      const kept = ids.filter((id) => id !== entry.input.id);
      if (kept.length === 0) state.absorbed.delete(entry.runId);
      else state.absorbed.set(entry.runId, kept);
    }
  }
  loop.takenThisAttempt = [];
  await checkpoint(execution);
  state.eventsSinceCheckpoint = 0;
  attempt.retrying = true;
  attempt.draining = true;
  attempt.retryDelayMs = decision.delayMs;
  attempt.discardReason = failure.reason;
  if (attemptTotalUsage !== undefined) {
    attempt.discardUsage = attempt.discardUsage
      ? addUsage(attempt.discardUsage, attemptTotalUsage)
      : attemptTotalUsage;
  }
  return true;
}

async function dispatchLoopEvent<CONTEXT, TOOLS extends AgentToolSet>(
  context: AttemptContext<CONTEXT, TOOLS>,
  scope: StreamPartScope,
  part: AgentLoopEvent,
): Promise<void> {
  const { execution } = context;
  const { checkpointEveryEvents } = execution.dependencies;
  const { state, operationLifecycle } = execution;
  state.eventsSinceCheckpoint += 1;
  const held =
    part.type === 'text-delta' &&
    execution.dependencies.config.loop?.stepBarriers?.stepText === 'after-tools';
  if (isOutputPart(part) && !held) {
    if (state.firstOutputAt === undefined) state.firstOutputAt = performance.now();
    await operationLifecycle.firstOutput();
  }
  await applyStreamPart(execution, scope, part);
  const preliminaryToolResult = part.type === 'tool-result' && part.preliminary === true;
  if (TOOL_STATUS_PARTS.includes(part.type) && !preliminaryToolResult) {
    state.eventsSinceCheckpoint = 0;
    return;
  }
  const structuralBoundary =
    STRUCTURAL_BOUNDARY_PARTS.includes(part.type) && !preliminaryToolResult;
  if (structuralBoundary || state.eventsSinceCheckpoint >= checkpointEveryEvents) {
    await checkpoint(execution);
    state.eventsSinceCheckpoint = 0;
    if (part.type === 'finish-step') operationLifecycle.checkpointStep(state.step - 1);
  }
}

async function runSingleAttempt<CONTEXT, TOOLS extends AgentToolSet>(
  context: AttemptContext<CONTEXT, TOOLS>,
  attempt: ModelAttempt,
  attemptSignal: AbortSignal,
): Promise<void> {
  const { execution, turn, ledger } = context;
  const { config } = execution.dependencies;
  const scope: StreamPartScope = {
    selectedModel: turn.selectedModel,
    ledger,
    providerAttempt: attempt.providerAttempt,
  };
  const emit = (event: AgentLoopEvent) => dispatchLoopEvent(context, scope, event);
  const initialInstructions = turn.projection.withCarriedSystem(turn.prompt.instructions);
  const declaredToolNames = Object.keys(turn.tools);
  const repairToolCall = chainRepairHooks(
    config.loop?.repairToolCall,
    deferredToolRepair(config.loop?.prepareStep),
  );
  const maxContinuations = config.loop?.maxContinuations ?? DEFAULT_MAX_CONTINUATIONS;
  let continuations = 0;

  const runState: StepRunState = {
    currentMessages: [...context.baseMessages],
    responseMessages: [],
    steps: [],
    attemptTotalUsage: undefined,
    lastFinishReason: 'stop',
    continuationInstructions: undefined,
    activeDriver: turn.selectedModel.driver,
  };

  for (let stepNumber = 0; ; stepNumber += 1) {
    let stepOutcome: 'continue' | 'break' | 'return';
    try {
      stepOutcome = await executeOneModelStep({
        execution,
        turn,
        ledger,
        baseMessages: context.baseMessages,
        providerAttempt: attempt.providerAttempt,
        isRetrying: () => attempt.retrying,
        isDraining: () => attempt.draining,
        onErrorPart: (error) =>
          retryAfterProviderError(context, attempt, error, runState.attemptTotalUsage),
        onAbandonedUsage: (usage) => {
          attempt.discardUsage = attempt.discardUsage
            ? addUsage(attempt.discardUsage, usage)
            : usage;
        },
        onStepDriver: (stepModel) => {
          scope.stepModel = stepModel;
        },
        takeInjectedMessages: () => takeInjectedMessages(context),
        attemptSignal,
        emit,
        stepNumber,
        initialInstructions,
        declaredToolNames,
        repairToolCall,
        runState,
      });
    } catch (error) {
      if (
        hasProviderOrigin(error) &&
        failureThisRuntimeOwns(error) === undefined &&
        !execution.executionSignal.aborted
      ) {
        const retried = await retryAfterProviderError(
          context,
          attempt,
          error,
          runState.attemptTotalUsage,
        );
        if (retried) return;
      }
      throw error;
    }

    if (stepOutcome === 'return') return;
    if (stepOutcome === 'continue') continue;

    const terminalVerdict = await evaluateTerminalContinuation({
      execution,
      lastFinishReason: runState.lastFinishReason,
      steps: runState.steps,
      continuations,
      maxContinuations,
      attemptSignal,
    });
    if (terminalVerdict.action === 'continue') {
      continuations += 1;
      runState.currentMessages = [...runState.currentMessages, terminalVerdict.message];
      runState.responseMessages.push(terminalVerdict.message);
      runState.continuationInstructions = terminalVerdict.instructions;
      continue;
    }
    break;
  }

  await emit({
    type: 'finish',
    finishReason: runState.lastFinishReason,
    totalUsage: runState.attemptTotalUsage ?? unknownUsage(),
  });
}

/** Every provider attempt of the run, until one ends without being retried. */
export async function runModelAttempts<CONTEXT, TOOLS extends AgentToolSet>(
  execution: RunExecution<CONTEXT, TOOLS>,
  turn: PreparedTurn<CONTEXT, TOOLS>,
): Promise<void> {
  const { config, publish, now } = execution.dependencies;
  const { state } = execution;
  const loop: AttemptLoopState = {
    retryAttempt: 1,
    retryWindowStart: performance.now(),
    takenThisAttempt: [],
  };
  const ledger = await createRunProviderLedger({
    store: config.store,
    state,
    selectedModel: turn.selectedModel,
    audited: execution.invocation !== undefined,
  });

  // Execute pending approval continuations ONCE before the retry loop so retries never
  // replay approved side-effects or splice away their durable tool results.
  const baseMessages: AgentModelMessage[] = [...turn.history];
  const context: AttemptContext<CONTEXT, TOOLS> = {
    execution,
    turn,
    loop,
    ledger,
    baseMessages,
  };
  const continuationScope: StreamPartScope = {
    selectedModel: turn.selectedModel,
    ledger,
    providerAttempt: 1,
  };
  await executeApprovalContinuations({
    execution,
    tools: turn.tools,
    toolApproval: turn.toolApproval,
    messages: baseMessages,
    signal: execution.executionSignal,
    emit: (event) => dispatchLoopEvent(context, continuationScope, event),
  });

  for (;;) {
    const attempt: ModelAttempt = {
      providerAttempt: loop.retryAttempt,
      attemptPartStart: state.parts.length,
      retrying: false,
      draining: false,
      retryDelayMs: 0,
    };
    await runSingleAttempt(context, attempt, execution.executionSignal);
    if (!attempt.retrying) break;
    await config.loop?.onAttemptDiscarded?.({
      attempt: attempt.providerAttempt,
      reason: attempt.discardReason ?? 'unknown',
      ...(attempt.discardUsage !== undefined && { usage: attempt.discardUsage }),
    });
    if (attempt.retryDelayMs > 0) {
      await delay(attempt.retryDelayMs, undefined, { signal: execution.executionSignal });
    }
    loop.retryAttempt += 1;
    await config.store.appendEvent({
      conversationId: state.run.conversationId,
      kind: 'retry/started',
      payload: { attempt: loop.retryAttempt },
    });
    state.step = 0;
    execution.operationLifecycle.resetCheckpointStep();
    state.lastPromptTokens = { provenance: 'unavailable' };
    state.terminalDecision = undefined;
    state.terminalPolicyName = undefined;
    state.textPartIndex = undefined;
    state.stepGuard = { text: '', toolFailed: false, reasoningChars: 0 };
    resetStepTextTracking(state);
    await publish({
      type: 'attempt-reset',
      conversationId: state.run.conversationId,
      runId: state.run.id,
      runtimeEpoch: execution.dependencies.runtimeEpoch,
      sequence: transientSequence(state),
      attempt: loop.retryAttempt,
      emittedAt: now().toISOString(),
    });
  }
}
