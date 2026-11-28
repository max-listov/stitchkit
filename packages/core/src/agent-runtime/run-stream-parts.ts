import { isAgentToolError } from '../tools/agent-tool-error';
import type { AgentToolSet } from '../tools/agent-tools';
import { isToolExecutionControlError } from '../tools/execute';
import type { AgentResolvedModel } from './models';
import { isToolResultFailure } from './provider-failure';
import { normalizePersistedToolInput } from './run-approval';
import {
  checkpoint,
  mergeProviderEnvelopes,
  type RunExecution,
  runUsage,
  transientSequence,
  updateReasoning,
  updateTextBlock,
} from './run-execution-state';
import { failureThisRuntimeOwns } from './run-failure';
import type { AgentLoopEvent } from './run-loop-events';
import type { RunProviderLedger } from './run-provider-ledger';
import { AgentStepBarrierError } from './run-step-barriers';
import { recordStepSpend } from './run-step-spend';
import { applyRecordedPart } from './run-stream-recorded';
import {
  type FlushHeldStepTextContext,
  flushHeldStepTextWithOutcome,
  markHeldStepTextPosition,
  recordStepToolCallForTextBarrier,
  recordStepToolResultForTextBarrier,
  resetStepTextTracking,
} from './run-stream-step-text';
import { abortTerminalReason, jsonValue, mergeModelTotals } from './runtime-internals';
import { AgentMessagePartSchema } from './schemas';

/** What one stream part needs beyond the run: the model and the attempt it belongs to. */
export interface StreamPartScope {
  selectedModel: AgentResolvedModel;
  stepModel?: { readonly modelId: string; readonly provider: string };
  ledger: RunProviderLedger;
  providerAttempt: number;
}

/** The identity every transient event of this run carries, with the next sequence. */
export function transientHead<CONTEXT, TOOLS extends AgentToolSet>(
  execution: RunExecution<CONTEXT, TOOLS>,
) {
  const { state } = execution;
  return {
    conversationId: state.run.conversationId,
    runId: state.run.id,
    runtimeEpoch: execution.dependencies.runtimeEpoch,
    sequence: transientSequence(state),
  };
}

/** A part that is the provider producing output, as opposed to framing it. */
export function isOutputPart(part: AgentLoopEvent): boolean {
  return (
    (part.type === 'text-delta' && part.text.length > 0) ||
    (part.type === 'reasoning-delta' && part.text.length > 0) ||
    (part.type === 'tool-input-delta' && part.delta.length > 0) ||
    part.type === 'tool-call'
  );
}

/** Tool parts whose own `tool-status` checkpoint already holds them. */
export const TOOL_STATUS_PARTS: readonly string[] = [
  'tool-call',
  'tool-result',
  'tool-error',
  'tool-output-denied',
];

/** Parts after which the durable draft is checkpointed regardless of the event count. */
export const STRUCTURAL_BOUNDARY_PARTS: readonly string[] = [
  ...TOOL_STATUS_PARTS,
  'tool-approval-request',
  'tool-approval-response',
  'finish-step',
];

async function applyTextPart<CONTEXT, TOOLS extends AgentToolSet>(
  execution: RunExecution<CONTEXT, TOOLS>,
  part: Extract<
    AgentLoopEvent,
    {
      type:
        | 'text-start'
        | 'text-delta'
        | 'text-end'
        | 'reasoning-start'
        | 'reasoning-delta'
        | 'reasoning-end';
    }
  >,
): Promise<void> {
  const { publish, now } = execution.dependencies;
  const { state } = execution;
  const barriers = execution.dependencies.config.loop?.stepBarriers;
  const holdText = barriers?.stepText === 'after-tools';
  if (part.type === 'text-start') {
    if (holdText) {
      const merged = mergeProviderEnvelopes(state.stepGuard.textProvider, part.provider);
      if (merged !== undefined) state.stepGuard.textProvider = merged;
      return;
    }
    if (part.id !== undefined) state.textPartIndexes.delete(part.id);
    state.textPartIndex = undefined;
    if (part.provider) updateTextBlock(state, '', part.provider, part.id);
  } else if (part.type === 'text-delta' && holdText) {
    if (part.text.length > 0) markHeldStepTextPosition(state);
    state.stepGuard.text += part.text;
    const merged = mergeProviderEnvelopes(state.stepGuard.textProvider, part.provider);
    if (merged !== undefined) state.stepGuard.textProvider = merged;
  } else if (part.type === 'text-delta') {
    updateTextBlock(state, part.text, part.provider, part.id);
    await publish({
      type: 'assistant-delta',
      ...transientHead(execution),
      textDelta: part.text,
      emittedAt: now().toISOString(),
    });
  } else if (part.type === 'text-end') {
    if (holdText) {
      const merged = mergeProviderEnvelopes(state.stepGuard.textProvider, part.provider);
      if (merged !== undefined) state.stepGuard.textProvider = merged;
      return;
    }
    if (part.provider) updateTextBlock(state, '', part.provider, part.id);
    state.textPartIndex = undefined;
    if (part.id !== undefined) state.textPartIndexes.delete(part.id);
  } else if (part.type === 'reasoning-start') {
    if (part.id !== undefined) state.reasoningPartIndexes.delete(part.id);
    state.reasoningPartIndex = undefined;
    updateReasoning(state, '', part.provider, part.id);
    await publish({
      type: 'reasoning-start',
      ...transientHead(execution),
      ...(part.provider && { provider: part.provider }),
      emittedAt: now().toISOString(),
    });
  } else if (part.type === 'reasoning-delta') {
    const limit = barriers?.maxReasoningCharsPerStep;
    state.stepGuard.reasoningChars += part.text.length;
    if (limit !== undefined && state.stepGuard.reasoningChars > limit) {
      const action = barriers?.onMaxReasoningChars ?? 'abort';
      if (action === 'abort')
        state.terminalPolicyName = 'stepBarriers.maxReasoningCharsPerStep';
      throw new AgentStepBarrierError(
        'reasoning',
        `A step reasoned past its bound of ${limit} characters`,
        action,
      );
    }
    updateReasoning(state, part.text, part.provider, part.id);
    await publish({
      type: 'reasoning-delta',
      ...transientHead(execution),
      textDelta: part.text,
      ...(part.provider && { provider: part.provider }),
      emittedAt: now().toISOString(),
    });
  } else if (part.type === 'reasoning-end') {
    updateReasoning(state, '', part.provider, part.id);
    state.reasoningPartIndex = undefined;
    await publish({
      type: 'reasoning-end',
      ...transientHead(execution),
      ...(part.provider && { provider: part.provider }),
      emittedAt: now().toISOString(),
    });
  }
}

async function applyToolPart<CONTEXT, TOOLS extends AgentToolSet>(
  execution: RunExecution<CONTEXT, TOOLS>,
  part: Extract<
    AgentLoopEvent,
    { type: 'tool-call' | 'tool-result' | 'tool-error' | 'tool-output-denied' }
  >,
): Promise<void> {
  const { state } = execution;
  if (part.type === 'tool-call') {
    const persistedInput = normalizePersistedToolInput(part.input);
    recordStepToolCallForTextBarrier(state, {
      type: 'tool-call',
      toolCallId: part.toolCallId,
      toolName: part.toolName,
      input: persistedInput,
    });
    state.parts.push(
      AgentMessagePartSchema.parse({
        type: 'tool-call',
        callId: part.toolCallId,
        toolName: part.toolName,
        input: persistedInput,
        ...(part.provider && { provider: part.provider }),
      }),
    );
    await checkpoint(execution, {
      callId: part.toolCallId,
      toolName: part.toolName,
      status: 'started',
      input: persistedInput,
    });
  } else if (part.type === 'tool-result') {
    if (part.preliminary === true) return;
    state.settledToolCalls.add(part.toolCallId);
    if (isToolResultFailure(part.output)) state.stepGuard.toolFailed = true;
    recordStepToolResultForTextBarrier(state, {
      type: 'tool-result',
      toolCallId: part.toolCallId,
      toolName: part.toolName,
      input: part.input,
      output: part.output,
    });
    state.parts.push(
      AgentMessagePartSchema.parse({
        type: 'tool-result',
        callId: part.toolCallId,
        toolName: part.toolName,
        outcome: 'success',
        output: jsonValue(part.output),
        ...(part.provider && { provider: part.provider }),
      }),
    );
    await checkpoint(execution, {
      callId: part.toolCallId,
      toolName: part.toolName,
      status: 'completed',
      output: jsonValue(part.output),
    });
  } else if (part.type === 'tool-error') {
    state.settledToolCalls.add(part.toolCallId);
    if (isToolExecutionControlError(part.error)) {
      state.internalCause = part.error;
      await checkpoint(execution, {
        callId: part.toolCallId,
        toolName: part.toolName,
        status: 'interrupted',
      });
      throw part.error;
    }
    state.stepGuard.toolFailed = true;
    const output = isAgentToolError(part.error)
      ? jsonValue(part.error.output)
      : { message: 'Tool execution failed' };
    state.parts.push(
      AgentMessagePartSchema.parse({
        type: 'tool-result',
        callId: part.toolCallId,
        toolName: part.toolName,
        outcome: 'error',
        output,
        ...(part.provider && { provider: part.provider }),
      }),
    );
    await checkpoint(execution, {
      callId: part.toolCallId,
      toolName: part.toolName,
      status: 'failed',
      output,
    });
  } else if (part.type === 'tool-output-denied') {
    state.settledToolCalls.add(part.toolCallId);
    state.stepGuard.toolFailed = true;
    state.parts.push(
      AgentMessagePartSchema.parse({
        type: 'tool-result',
        callId: part.toolCallId,
        toolName: part.toolName,
        outcome: 'error',
        output: { message: 'Tool output denied' },
      }),
    );
    await checkpoint(execution, {
      callId: part.toolCallId,
      toolName: part.toolName,
      status: 'failed',
      output: { message: 'Tool output denied' },
    });
  }
}

async function applyFinishStep<CONTEXT, TOOLS extends AgentToolSet>(
  execution: RunExecution<CONTEXT, TOOLS>,
  scope: StreamPartScope,
  part: Extract<AgentLoopEvent, { type: 'finish-step' }>,
): Promise<void> {
  await flushHeldStepText(execution, false, { finishReason: part.finishReason });
  await recordStepSpend(execution, {
    phase: 'step',
    part: {
      response: {
        id: part.responseId,
        ...(part.responseModelId !== undefined && { modelId: part.responseModelId }),
        ...(part.responseTimestamp !== undefined && { timestamp: part.responseTimestamp }),
      },
      usage: part.usage,
      finishReason: part.finishReason,
      ...(part.toolCallCount !== undefined && { toolCallCount: part.toolCallCount }),
      ...(part.responseProvider !== undefined && { responseProvider: part.responseProvider }),
      ...(part.rawFinishReason !== undefined && { rawFinishReason: part.rawFinishReason }),
      ...(part.costDetails !== undefined && { costDetails: part.costDetails }),
      ...(part.timings !== undefined && { timings: part.timings }),
    },
    attempt: scope.providerAttempt,
    selectedModel: scope.selectedModel,
    ...(scope.stepModel && { model: scope.stepModel }),
    ledger: scope.ledger,
  });
  await execution.operationLifecycle.finish(
    part.finishReason === 'error' ? 'failed' : 'completed',
  );
  execution.state.step += 1;
}

/** Flush held step text when no tool failed (with optional `filterStepText`), resetting the guard. */
export async function flushHeldStepText<CONTEXT, TOOLS extends AgentToolSet>(
  execution: RunExecution<CONTEXT, TOOLS>,
  interrupted: boolean,
  context?: FlushHeldStepTextContext,
): Promise<void> {
  await flushHeldStepTextWithOutcome(execution, interrupted, context);
}

/** Record one loop event in the draft, and publish what subscribers see of it. */
export async function applyStreamPart<CONTEXT, TOOLS extends AgentToolSet>(
  execution: RunExecution<CONTEXT, TOOLS>,
  scope: StreamPartScope,
  part: AgentLoopEvent,
): Promise<void> {
  const { state } = execution;
  switch (part.type) {
    case 'text-start':
    case 'text-delta':
    case 'text-end':
    case 'reasoning-start':
    case 'reasoning-delta':
    case 'reasoning-end':
      await applyTextPart(execution, part);
      break;
    case 'tool-call':
    case 'tool-result':
    case 'tool-error':
    case 'tool-output-denied':
      await applyToolPart(execution, part);
      break;
    case 'source':
    case 'file':
    case 'reasoning-file':
    case 'tool-approval-request':
    case 'tool-approval-response':
    case 'custom':
    case 'raw':
      await applyRecordedPart(execution, part);
      break;
    case 'tool-input-start':
      await execution.dependencies.config.loop?.onToolInputStart?.({
        toolCallId: part.toolCallId,
        toolName: part.toolName,
        ...(part.providerExecuted !== undefined && {
          providerExecuted: part.providerExecuted,
        }),
      });
      break;
    case 'tool-input-delta':
      break;
    case 'abort': {
      const reason = execution.executionSignal.aborted
        ? abortTerminalReason(execution.executionSignal)
        : 'interrupted';
      if (
        reason === 'interrupted' &&
        execution.dependencies.config.loop?.stepBarriers?.stepTextOnInterrupt === 'flush'
      ) {
        await flushHeldStepText(execution, true, { finishReason: 'interrupted' });
      }
      state.terminalReason = reason;
      break;
    }
    case 'error':
      state.terminalReason = failureThisRuntimeOwns(part.error) ?? 'provider_failure';
      state.internalCause = part.error;
      break;
    case 'start-step':
      state.stepGuard = { text: '', toolFailed: false, reasoningChars: 0 };
      resetStepTextTracking(state);
      state.reasoningPartIndex = undefined;
      state.reasoningPartIndexes.clear();
      state.textPartIndex = undefined;
      state.textPartIndexes.clear();
      break;
    case 'finish-step':
      await applyFinishStep(execution, scope, part);
      break;
    case 'finish':
      if (part.finishReason !== 'stop') {
        if (state.terminalReason === 'success') {
          state.terminalReason =
            part.finishReason === 'error' ? 'provider_failure' : 'provider_stop';
          state.internalCause ??= { finishReason: part.finishReason };
        }
      }
      state.sawProviderFinish = true;
      state.modelUsage = mergeModelTotals(part.totalUsage, state.modelUsage);
      state.usage = runUsage(state);
      break;
  }
}
