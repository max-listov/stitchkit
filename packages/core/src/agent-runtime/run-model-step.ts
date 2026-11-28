import type { AgentInstructions, AgentModelMessage } from '../agent-parts/model';
import { linkAbortSignals } from '../internal/abort-race';
import type { AgentToolSet } from '../tools/agent-tools';
import type {
  AgentModelDriver,
  AgentModelFinishReason,
  AgentModelRequest,
  AgentModelStream,
  AgentStepTimings,
} from './models-driver';
import type { AgentStepResult, AgentToolCallRepairFunction } from './models-driver-step';
import { AgentProviderStreamCutError } from './provider-failure';
import { markProviderOrigin } from './provider-origin';
import type { ConsumedStepStream } from './provider-stream-segments';
import type { RunExecution } from './run-execution-state';
import { failureThisRuntimeOwns } from './run-failure';
import type { AgentLoopEvent } from './run-loop-events';
import { consumeModelStepStream } from './run-model-stream';
import type { RunProviderLedger } from './run-provider-ledger';
import {
  assembleStepResult,
  buildActiveToolSpecs,
  buildStepTimings,
  isStepUnsafeForClientTools,
} from './run-step-helpers';
import { buildStepRequest, evaluateStopPolicies } from './run-step-prepare';
import { flushHeldStepTextWithOutcome } from './run-stream-step-text';
import {
  emptyStepToolExecutionResult,
  executeStepToolCalls,
  type StepToolExecutionResult,
} from './run-tool-executor';
import type { PreparedTurn } from './run-turn-preparation';
import { addUsage } from './runtime-internals';
import type { AgentUsage } from './schemas';
import { statedUsage } from './schemas-usage-state';

export interface StepRunState {
  currentMessages: AgentModelMessage[];
  responseMessages: AgentModelMessage[];
  steps: AgentStepResult[];
  attemptTotalUsage: AgentUsage | undefined;
  lastFinishReason: AgentModelFinishReason;
  continuationInstructions: AgentInstructions | undefined;
  activeDriver: AgentModelDriver;
}

async function recordCompletedStep<CONTEXT, TOOLS extends AgentToolSet>(input: {
  execution: RunExecution<CONTEXT, TOOLS>;
  stepNumber: number;
  callId: string;
  stepModel: { readonly modelId: string; readonly provider: string };
  consumed: ConsumedStepStream;
  finishPart: NonNullable<ConsumedStepStream['finishPart']>;
  toolExecution: StepToolExecutionResult;
  timings: AgentStepTimings;
  runState: StepRunState;
  emit: (event: AgentLoopEvent) => Promise<void>;
}): Promise<void> {
  const {
    execution,
    stepNumber,
    callId,
    stepModel,
    consumed,
    finishPart,
    toolExecution,
    timings,
    runState,
    emit,
  } = input;
  const stepToolCalls = [...consumed.providerToolCalls, ...toolExecution.toolCalls];
  const stepToolResults = [...consumed.providerToolResults, ...toolExecution.toolResults];
  let stepTextOverride: string | undefined;
  if (execution.dependencies.config.loop?.stepBarriers?.stepText === 'after-tools') {
    const flushed = await flushHeldStepTextWithOutcome(execution, false, {
      finishReason: finishPart.finishReason,
      toolCalls: stepToolCalls,
      toolResults: stepToolResults,
    });
    if (flushed.hadHeldText) {
      if (flushed.releasedText === undefined) {
        stepTextOverride = '';
      } else if (flushed.releasedText !== flushed.rawText) {
        stepTextOverride = flushed.releasedText;
      }
    }
  }
  const stepUsage = statedUsage(finishPart.usage);
  const { resolvedResponseId, stepResponseMessages, stepResult } = assembleStepResult({
    stepNumber,
    callId,
    model: stepModel,
    consumed,
    finishPart,
    toolExecution,
    timings,
    stepUsage,
    ...(stepTextOverride !== undefined && { stepTextOverride }),
  });

  runState.currentMessages = [...runState.currentMessages, ...stepResponseMessages];
  runState.responseMessages.push(...stepResponseMessages);
  runState.attemptTotalUsage = addUsage(runState.attemptTotalUsage, stepUsage);
  runState.lastFinishReason = finishPart.finishReason;
  runState.steps.push(stepResult);

  await emit({
    type: 'finish-step',
    finishReason: finishPart.finishReason,
    ...(finishPart.rawFinishReason !== undefined && {
      rawFinishReason: finishPart.rawFinishReason,
    }),
    responseId: resolvedResponseId,
    ...(consumed.responseModelId !== undefined && {
      responseModelId: consumed.responseModelId,
    }),
    ...(consumed.responseTimestamp !== undefined && {
      responseTimestamp: consumed.responseTimestamp,
    }),
    ...(finishPart.responseProvider !== undefined && {
      responseProvider: finishPart.responseProvider,
    }),
    toolCallCount: stepResult.toolCalls.length,
    usage: stepUsage,
    ...(finishPart.costDetails !== undefined && { costDetails: finishPart.costDetails }),
    timings,
  });
}

async function openStepStream<CONTEXT, TOOLS extends AgentToolSet>(
  execution: RunExecution<CONTEXT, TOOLS>,
  driver: AgentModelDriver,
  request: ReturnType<typeof buildStepRequest>,
  stepSignal: AbortSignal,
): Promise<AgentModelStream> {
  execution.idleDeadline.start();
  try {
    return await driver.stream(request, stepSignal);
  } catch (error) {
    execution.idleDeadline.stop();
    if (failureThisRuntimeOwns(error) === undefined && !execution.executionSignal.aborted) {
      markProviderOrigin(error);
    }
    throw error;
  }
}

async function streamStepWithIsolatedAbort<CONTEXT, TOOLS extends AgentToolSet>(input: {
  execution: RunExecution<CONTEXT, TOOLS>;
  turn: PreparedTurn<CONTEXT, TOOLS>;
  ledger: RunProviderLedger;
  effectiveDriver: AgentModelDriver;
  request: AgentModelRequest;
  callId: string;
  providerAttempt: number;
  stepStartedAt: number;
  stepModel: { readonly modelId: string; readonly provider: string };
  attemptSignal: AbortSignal;
  isDraining: () => boolean;
  onErrorPart: (error: unknown) => Promise<boolean>;
  onAbandonedUsage: (usage: AgentUsage) => void;
  emit: (event: AgentLoopEvent) => Promise<void>;
}): Promise<ConsumedStepStream> {
  const stepAbort = new AbortController();
  const stepLink = linkAbortSignals(input.attemptSignal, stepAbort.signal);
  try {
    const modelStream = await openStepStream(
      input.execution,
      input.effectiveDriver,
      input.request,
      stepLink.signal,
    );
    return await consumeModelStepStream({
      execution: input.execution,
      turn: input.turn,
      ledger: input.ledger,
      callId: input.callId,
      providerAttempt: input.providerAttempt,
      stepStartedAt: input.stepStartedAt,
      stepModel: input.stepModel,
      isDraining: input.isDraining,
      onErrorPart: input.onErrorPart,
      onAbandonedUsage: input.onAbandonedUsage,
      abortStepStream: () =>
        stepAbort.abort(new Error('Agent runtime released step provider stream')),
      modelStream,
      emit: input.emit,
    });
  } finally {
    stepLink.release();
  }
}

/** Execute one provider step: prepareStep, stream, tool execution, timings and finish-step. */
export async function executeOneModelStep<CONTEXT, TOOLS extends AgentToolSet>(input: {
  execution: RunExecution<CONTEXT, TOOLS>;
  turn: PreparedTurn<CONTEXT, TOOLS>;
  ledger: RunProviderLedger;
  baseMessages: readonly AgentModelMessage[];
  providerAttempt: number;
  isRetrying: () => boolean;
  isDraining: () => boolean;
  onErrorPart: (error: unknown) => Promise<boolean>;
  onAbandonedUsage: (usage: AgentUsage) => void;
  onStepDriver?: (model: { readonly modelId: string; readonly provider: string }) => void;
  takeInjectedMessages: () => Promise<AgentModelMessage[]>;
  attemptSignal: AbortSignal;
  emit: (event: AgentLoopEvent) => Promise<void>;
  stepNumber: number;
  initialInstructions: AgentInstructions;
  declaredToolNames: readonly string[];
  repairToolCall: AgentToolCallRepairFunction | undefined;
  runState: StepRunState;
}): Promise<'continue' | 'break' | 'return'> {
  const {
    execution,
    turn,
    ledger,
    baseMessages,
    attemptSignal,
    emit,
    stepNumber,
    initialInstructions,
    declaredToolNames,
    repairToolCall,
    runState,
  } = input;
  const { config, generateId } = execution.dependencies;
  const { state, operationLifecycle } = execution;

  attemptSignal.throwIfAborted();
  await emit({ type: 'start-step' });

  const defaultInstructions = runState.continuationInstructions ?? initialInstructions;
  runState.continuationInstructions = undefined;

  const prepared =
    (await config.loop?.prepareStep?.({
      stepNumber,
      steps: runState.steps,
      messages: runState.currentMessages,
      responseMessages: runState.responseMessages,
      initialMessages: baseMessages,
      initialInstructions,
      instructions: defaultInstructions,
      driver: runState.activeDriver,
      activeTools: declaredToolNames,
      ...turn.runtimeContext,
    })) ?? undefined;

  const injected = await input.takeInjectedMessages();
  runState.currentMessages = [
    ...(prepared?.messages ?? runState.currentMessages),
    ...injected,
  ];
  const stepInstructions = prepared?.instructions ?? defaultInstructions;
  const { activeNames, specs: toolSpecs } = buildActiveToolSpecs(
    turn.tools,
    prepared?.activeTools,
  );

  const baseDriver = prepared?.driver ?? runState.activeDriver;
  runState.activeDriver = baseDriver;
  const switchedDriver = baseDriver !== turn.selectedModel.driver;
  const stepModel = switchedDriver
    ? { modelId: baseDriver.modelId, provider: baseDriver.provider }
    : {
        modelId: turn.selectedModel.descriptor.modelId,
        provider: turn.selectedModel.descriptor.provider,
      };
  input.onStepDriver?.(stepModel);

  const callId = generateId();
  await ledger.recordRequest({
    stepNumber,
    attempt: input.providerAttempt,
    modelId: stepModel.modelId,
    instructions: stepInstructions,
    messages: runState.currentMessages,
  });
  await operationLifecycle.admitModelRequest(stepNumber, callId);

  const effectiveDriver = execution.invocation
    ? execution.invocation.wrap(turn.selectedModel, stepNumber, baseDriver)
    : baseDriver;

  const request = buildStepRequest({
    instructions: stepInstructions,
    messages: runState.currentMessages,
    toolSpecs,
    prepared,
    conversationId: state.run.conversationId,
    runId: state.run.id,
    attemptId: callId,
    stepNumber,
  });

  const stepStartedAt = performance.now();
  const consumed = await streamStepWithIsolatedAbort({
    execution,
    turn,
    ledger,
    effectiveDriver,
    request,
    callId,
    providerAttempt: input.providerAttempt,
    stepStartedAt,
    stepModel,
    attemptSignal,
    isDraining: input.isDraining,
    onErrorPart: input.onErrorPart,
    onAbandonedUsage: input.onAbandonedUsage,
    emit,
  });
  if (input.isRetrying()) return 'return';

  const responseFinishedAt = performance.now();
  if (!consumed.finishPart) {
    if (attemptSignal.aborted) {
      await emit({ type: 'abort' });
      return 'return';
    }
    if (consumed.sawErrorPart) return 'return';
    throw markProviderOrigin(
      new AgentProviderStreamCutError('Provider stream ended without a finish event', {
        provider: effectiveDriver.provider,
      }),
    );
  }

  const finishPart = consumed.finishPart;
  const unsafeForClientTools = isStepUnsafeForClientTools(
    finishPart.finishReason,
    consumed.sawErrorPart,
  );

  const toolStartedAt = performance.now();
  const toolExecution = unsafeForClientTools
    ? emptyStepToolExecutionResult()
    : await executeStepToolCalls({
        execution,
        stepNumber,
        rawCalls: consumed.rawToolCalls,
        tools: turn.tools,
        activeTools: activeNames,
        toolApproval: turn.toolApproval,
        repairToolCall,
        instructions: request.instructions,
        messages: runState.currentMessages,
        signal: attemptSignal,
        emit,
      });
  const stepFinishedAt = performance.now();
  const toolExecutionMs = unsafeForClientTools
    ? 0
    : Math.max(0, stepFinishedAt - toolStartedAt);
  const timings = buildStepTimings({
    stepStartedAt,
    responseFinishedAt,
    stepFinishedAt,
    firstOutputAt: consumed.firstOutputAt,
    toolExecutionMs,
    outputChunkTimestamps: consumed.outputChunkTimestamps,
  });

  await recordCompletedStep({
    execution,
    stepNumber,
    callId,
    stepModel,
    consumed,
    finishPart,
    toolExecution,
    timings,
    runState,
    emit,
  });

  const canContinue =
    !unsafeForClientTools &&
    toolExecution.clientToolCallCount > 0 &&
    toolExecution.settledClientToolCount === toolExecution.clientToolCallCount;

  if (!canContinue) return 'break';
  if (await evaluateStopPolicies(execution, turn, runState.steps)) return 'break';
  return 'continue';
}
