import type { AgentModelMessage } from '../agent-parts/model';
import type { AgentToolSet } from '../tools/agent-tools';
import type {
  AgentModelCallSettings,
  AgentModelFinishReason,
  AgentModelStreamPart,
  AgentModelToolSpec,
  AgentStepChunkIntervals,
  AgentStepTimings,
} from './models-driver';
import type { AgentPrepareStepResult, AgentStepResult } from './models-driver-step';
import type { ConsumedStepStream } from './provider-stream-segments';
import { buildStepContent, buildStepResponseMessages } from './run-model-messages';
import type { StepToolExecutionResult } from './run-tool-executor';
import type { AgentUsage } from './schemas';

/** Build active tool names and function-tool wire specs in declared tool order. */
export function buildActiveToolSpecs<TOOLS extends AgentToolSet>(
  tools: TOOLS,
  requestedActive: readonly string[] | undefined,
): { activeNames: string[]; specs: AgentModelToolSpec[] } {
  const declared = Object.keys(tools);
  const activeSet = requestedActive ? new Set(requestedActive) : undefined;
  const activeNames = activeSet ? declared.filter((name) => activeSet.has(name)) : declared;
  const specs: AgentModelToolSpec[] = [];
  for (const name of activeNames) {
    const tool = Object.hasOwn(tools, name) ? tools[name] : undefined;
    if (!tool) continue;
    specs.push({
      name,
      ...(tool.description !== undefined && { description: tool.description }),
      inputSchema: tool.inputSchema,
      ...(tool.strict !== undefined && { strict: tool.strict }),
      ...(tool.cacheControl !== undefined && { cacheControl: tool.cacheControl }),
      ...(tool.providerOptions !== undefined && { providerOptions: tool.providerOptions }),
    });
  }
  return { activeNames, specs };
}

/** Merge base sampling/output settings with per-step `prepareStep` overrides. */
export function mergeStepCallSettings(
  base: AgentModelCallSettings | undefined,
  prepared: AgentPrepareStepResult | undefined,
): AgentModelCallSettings {
  const maxOutputTokens = prepared?.maxOutputTokens ?? base?.maxOutputTokens;
  const temperature = prepared?.temperature ?? base?.temperature;
  const topP = prepared?.topP ?? base?.topP;
  const topK = prepared?.topK ?? base?.topK;
  const presencePenalty = prepared?.presencePenalty ?? base?.presencePenalty;
  const frequencyPenalty = prepared?.frequencyPenalty ?? base?.frequencyPenalty;
  const seed = prepared?.seed ?? base?.seed;
  const stopSequences = prepared?.stopSequences ?? base?.stopSequences;
  return {
    ...(maxOutputTokens !== undefined && { maxOutputTokens }),
    ...(temperature !== undefined && { temperature }),
    ...(topP !== undefined && { topP }),
    ...(topK !== undefined && { topK }),
    ...(presencePenalty !== undefined && { presencePenalty }),
    ...(frequencyPenalty !== undefined && { frequencyPenalty }),
    ...(seed !== undefined && { seed }),
    ...(stopSequences !== undefined && { stopSequences }),
  };
}

/** Whether executing client-side tool calls emitted on a step would be unsafe. */
export function isStepUnsafeForClientTools(
  finishReason: AgentModelFinishReason,
  sawErrorPart = false,
): boolean {
  return (
    sawErrorPart ||
    finishReason === 'length' ||
    finishReason === 'error' ||
    finishReason === 'interrupted' ||
    finishReason === 'content-filter'
  );
}

function quantile(sorted: readonly number[], p: number): number {
  const index = p * (sorted.length - 1);
  const lo = Math.floor(index);
  const hi = Math.ceil(index);
  const loVal = sorted[lo] ?? 0;
  const hiVal = sorted[hi] ?? loVal;
  return loVal + (hiVal - loVal) * (index - lo);
}

/** Compute inter-chunk latency quantiles (ms) when at least two output chunks were observed. */
export function computeChunkIntervalsMs(
  timestamps: readonly number[] | undefined,
): AgentStepChunkIntervals | undefined {
  if (!timestamps || timestamps.length < 2) return undefined;
  const deltas: number[] = [];
  let sum = 0;
  for (let index = 1; index < timestamps.length; index += 1) {
    const prev = timestamps[index - 1] ?? 0;
    const curr = timestamps[index] ?? prev;
    const delta = Math.max(0, curr - prev);
    deltas.push(delta);
    sum += delta;
  }
  deltas.sort((a, b) => a - b);
  return {
    min: deltas[0] ?? 0,
    p10: quantile(deltas, 0.1),
    median: quantile(deltas, 0.5),
    avg: sum / deltas.length,
    p90: quantile(deltas, 0.9),
    max: deltas[deltas.length - 1] ?? 0,
  };
}

/** Build structured per-step wall-clock timings and optional chunk-interval quantiles. */
export function buildStepTimings(input: {
  readonly stepStartedAt: number;
  readonly responseFinishedAt: number;
  readonly stepFinishedAt: number;
  readonly firstOutputAt: number | undefined;
  readonly toolExecutionMs: number;
  readonly outputChunkTimestamps?: readonly number[];
}): AgentStepTimings {
  const responseTimeMs = Math.max(0, input.responseFinishedAt - input.stepStartedAt);
  const stepTimeMs = Math.max(0, input.stepFinishedAt - input.stepStartedAt);
  const ttftMs =
    input.firstOutputAt !== undefined
      ? Math.max(0, input.firstOutputAt - input.stepStartedAt)
      : undefined;
  const chunkIntervalsMs = computeChunkIntervalsMs(input.outputChunkTimestamps);
  return {
    stepTimeMs,
    responseTimeMs,
    toolExecutionMs: Math.max(0, input.toolExecutionMs),
    ...(ttftMs !== undefined && { ttftMs }),
    ...(chunkIntervalsMs !== undefined && { chunkIntervalsMs }),
  };
}

function applyStepTextOverride(
  consumed: ConsumedStepStream,
  override: string,
): ConsumedStepStream {
  const segments: ConsumedStepStream['segments'] = [];
  let replacedFirst = false;
  for (const segment of consumed.segments) {
    if (segment.kind !== 'text') {
      segments.push(segment);
      continue;
    }
    if (override.length > 0 && !replacedFirst) {
      segments.push({ ...segment, text: override });
      replacedFirst = true;
    }
  }
  if (override.length > 0 && !replacedFirst) {
    segments.push({ kind: 'text', id: 'step-text', text: override });
  }
  return { ...consumed, stepText: override, segments };
}

/** Assemble one canonical `AgentStepResult` shared by the durable runtime and standalone loops. */
export function assembleStepResult(input: {
  readonly stepNumber: number;
  readonly callId: string;
  readonly model?: { readonly provider: string; readonly modelId: string };
  readonly consumed: ConsumedStepStream;
  readonly finishPart: Extract<AgentModelStreamPart, { type: 'finish' }>;
  readonly toolExecution: StepToolExecutionResult;
  readonly timings: AgentStepTimings;
  readonly stepUsage: AgentUsage;
  readonly stepTextOverride?: string;
}): {
  readonly resolvedResponseId: string;
  readonly stepResponseMessages: AgentModelMessage[];
  readonly stepResult: AgentStepResult;
} {
  const {
    stepNumber,
    callId,
    model,
    consumed,
    finishPart,
    toolExecution,
    timings,
    stepUsage,
    stepTextOverride,
  } = input;
  const effectiveConsumed =
    stepTextOverride !== undefined
      ? applyStepTextOverride(consumed, stepTextOverride)
      : consumed;
  const stepResponseMessages = buildStepResponseMessages(effectiveConsumed, toolExecution);
  const resolvedResponseId =
    effectiveConsumed.responseId.length > 0 ? effectiveConsumed.responseId : callId;
  const stepResult: AgentStepResult = {
    stepNumber,
    ...(model !== undefined && { model }),
    text: effectiveConsumed.stepText,
    content: buildStepContent(effectiveConsumed, toolExecution),
    toolCalls: [...effectiveConsumed.providerToolCalls, ...toolExecution.toolCalls],
    toolResults: [...effectiveConsumed.providerToolResults, ...toolExecution.toolResults],
    finishReason: finishPart.finishReason,
    ...(finishPart.rawFinishReason !== undefined && {
      rawFinishReason: finishPart.rawFinishReason,
    }),
    usage: stepUsage,
    ...(finishPart.costDetails !== undefined && { costDetails: finishPart.costDetails }),
    timings,
    response: {
      id: resolvedResponseId,
      ...(effectiveConsumed.responseModelId !== undefined && {
        modelId: effectiveConsumed.responseModelId,
      }),
      ...(effectiveConsumed.responseTimestamp !== undefined && {
        timestamp: effectiveConsumed.responseTimestamp,
      }),
      ...(finishPart.responseProvider !== undefined && {
        provider: finishPart.responseProvider,
      }),
      messages: stepResponseMessages,
    },
    ...(finishPart.provider !== undefined && { provider: finishPart.provider }),
  };
  return { resolvedResponseId, stepResponseMessages, stepResult };
}
