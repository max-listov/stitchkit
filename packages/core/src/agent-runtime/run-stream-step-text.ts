import type { AgentToolSet } from '../tools/agent-tools';
import type { AgentModelFinishReason } from './models-driver';
import type { AgentStepToolCall, AgentStepToolResult } from './models-driver-step';
import {
  type RunExecution,
  type RunExecutionState,
  transientSequence,
} from './run-execution-state';
import { AgentMessagePartSchema } from './schemas';

interface StepTextTracking {
  insertIndex: number | undefined;
  toolCalls: AgentStepToolCall[];
  toolResults: AgentStepToolResult[];
}

const stepTextTracking = new WeakMap<RunExecutionState, StepTextTracking>();

function trackingOf(state: RunExecutionState): StepTextTracking {
  const existing = stepTextTracking.get(state);
  if (existing) return existing;
  const fresh: StepTextTracking = {
    insertIndex: undefined,
    toolCalls: [],
    toolResults: [],
  };
  stepTextTracking.set(state, fresh);
  return fresh;
}

/** Reset per-step held-text insertion tracking and step tool call/result snapshots. */
export function resetStepTextTracking(state: RunExecutionState): void {
  const track = trackingOf(state);
  track.insertIndex = undefined;
  track.toolCalls = [];
  track.toolResults = [];
}

/** Record where held step text appeared in `state.parts` so flush preserves chronological order. */
export function markHeldStepTextPosition(state: RunExecutionState): void {
  const track = trackingOf(state);
  if (track.insertIndex === undefined) {
    track.insertIndex = state.parts.length;
  }
}

/** Record a tool call observed during the current step for `filterStepText` on abort/finish. */
export function recordStepToolCallForTextBarrier(
  state: RunExecutionState,
  call: AgentStepToolCall,
): void {
  trackingOf(state).toolCalls.push(call);
}

/** Record a tool result observed during the current step for `filterStepText` on abort/finish. */
export function recordStepToolResultForTextBarrier(
  state: RunExecutionState,
  result: AgentStepToolResult,
): void {
  trackingOf(state).toolResults.push(result);
}

export interface FlushHeldStepTextContext {
  readonly finishReason?: AgentModelFinishReason;
  readonly toolCalls?: readonly AgentStepToolCall[];
  readonly toolResults?: readonly AgentStepToolResult[];
}

export interface FlushHeldStepTextOutcome {
  readonly hadHeldText: boolean;
  readonly releasedText: string | undefined;
  readonly rawText: string;
}

/**
 * Flush held step text when no tool failed (with optional `filterStepText`), inserting at
 * the original chronological position in `state.parts` and returning the released outcome
 * so `stepResponseMessages` stays synchronized with what subscribers and history received.
 */
export async function flushHeldStepTextWithOutcome<CONTEXT, TOOLS extends AgentToolSet>(
  execution: RunExecution<CONTEXT, TOOLS>,
  interrupted: boolean,
  context?: FlushHeldStepTextContext,
): Promise<FlushHeldStepTextOutcome> {
  const { state } = execution;
  const { text, textProvider, toolFailed } = state.stepGuard;
  const track = trackingOf(state);
  const insertIndex = track.insertIndex;
  const trackedCalls = [...track.toolCalls];
  const trackedResults = [...track.toolResults];
  state.stepGuard = { text: '', toolFailed: false, reasoningChars: 0 };
  resetStepTextTracking(state);

  if (text.length === 0) {
    return { hadHeldText: false, releasedText: undefined, rawText: '' };
  }
  if (toolFailed) {
    return { hadHeldText: true, releasedText: undefined, rawText: text };
  }

  const filter = execution.dependencies.config.loop?.stepBarriers?.filterStepText;
  const finishReason: AgentModelFinishReason =
    context?.finishReason ?? (interrupted ? 'interrupted' : 'other');
  const toolCalls = context?.toolCalls ?? trackedCalls;
  const toolResults = context?.toolResults ?? trackedResults;
  const released = filter
    ? filter(text, {
        step: state.step,
        interrupted,
        finishReason,
        toolCalls,
        toolResults,
      })
    : text;

  if (!released || released.length === 0) {
    return { hadHeldText: true, releasedText: undefined, rawText: text };
  }

  const textPart = AgentMessagePartSchema.parse({
    type: 'text',
    text: released,
    ...(textProvider !== undefined && { provider: textProvider }),
  });
  const targetIndex =
    insertIndex !== undefined ? Math.min(insertIndex, state.parts.length) : state.parts.length;
  state.parts.splice(targetIndex, 0, textPart);

  if (state.firstOutputAt === undefined) state.firstOutputAt = performance.now();
  await execution.operationLifecycle.firstOutput();
  const { publish, now, runtimeEpoch } = execution.dependencies;
  await publish({
    type: 'assistant-delta',
    conversationId: state.run.conversationId,
    runId: state.run.id,
    runtimeEpoch,
    sequence: transientSequence(state),
    textDelta: released,
    emittedAt: now().toISOString(),
  });
  return { hadHeldText: true, releasedText: released, rawText: text };
}
