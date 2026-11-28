import type { AgentModelStreamPart } from './models-driver';
import type { AgentStepToolCall, AgentStepToolResult } from './models-driver-step';
import { envelopeToProviderOptions } from './provider-media';
import {
  type ConsumedStepStream,
  ensureReasoningSegment,
  ensureTextSegment,
  generatedFileToModelFileData,
  mergeEnvelope,
  parseProviderToolInput,
  recordOutputChunk,
  type StreamAccumulator,
  safeJsonValue,
  toProviderToolError,
} from './provider-stream-segments';
import type { AgentLoopEvent } from './run-loop-events';

async function handleProviderToolResult(
  result: ConsumedStepStream,
  part: Extract<AgentModelStreamPart, { type: 'tool-result' }>,
  emit: (event: AgentLoopEvent) => Promise<void>,
): Promise<void> {
  const matchingCall = result.rawToolCalls.find((call) => call.toolCallId === part.toolCallId);
  const matchingInput = matchingCall ? parseProviderToolInput(matchingCall.input) : {};
  const providerOptions = envelopeToProviderOptions(part.provider);
  if (part.isError === true) {
    if (part.preliminary === true) return;
    const providerError = toProviderToolError(part.result);
    await emit({
      type: 'tool-error',
      toolCallId: part.toolCallId,
      toolName: part.toolName,
      input: matchingInput,
      error: providerError,
      ...(part.provider && { provider: part.provider }),
    });
    result.providerToolResults.push({
      type: 'tool-result',
      toolCallId: part.toolCallId,
      toolName: part.toolName,
      input: matchingInput,
      output: part.result,
      providerExecuted: true,
    });
    result.segments.push({
      kind: 'provider-part',
      assistantPart: {
        type: 'tool-result',
        toolCallId: part.toolCallId,
        toolName: part.toolName,
        output: { type: 'error-json', value: safeJsonValue(part.result ?? null) },
        ...(providerOptions && { providerOptions }),
      },
      stepPart: {
        type: 'tool-error',
        toolCallId: part.toolCallId,
        toolName: part.toolName,
        input: matchingInput,
        error: providerError,
      },
    });
    return;
  }
  await emit({
    type: 'tool-result',
    toolCallId: part.toolCallId,
    toolName: part.toolName,
    input: matchingInput,
    output: part.result,
    ...(part.preliminary !== undefined && { preliminary: part.preliminary }),
    ...(part.provider && { provider: part.provider }),
  });
  if (part.preliminary === true) return;
  const stepResult: AgentStepToolResult = {
    type: 'tool-result',
    toolCallId: part.toolCallId,
    toolName: part.toolName,
    input: matchingInput,
    output: part.result,
    providerExecuted: true,
  };
  result.providerToolResults.push(stepResult);
  result.segments.push({
    kind: 'provider-part',
    assistantPart: {
      type: 'tool-result',
      toolCallId: part.toolCallId,
      toolName: part.toolName,
      output: { type: 'json', value: safeJsonValue(part.result ?? null) },
      ...(providerOptions && { providerOptions }),
    },
    stepPart: stepResult,
  });
}

async function handleTextOrReasoningPart(
  acc: StreamAccumulator,
  part: Extract<
    AgentModelStreamPart,
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
  emit: (event: AgentLoopEvent) => Promise<void>,
): Promise<void> {
  const { result } = acc;
  if (part.type === 'text-start' || part.type === 'reasoning-start') {
    if (part.type === 'text-start') {
      acc.textById.delete(part.id);
      acc.closedTextById.delete(part.id);
      ensureTextSegment(acc, part.id, part.provider);
    } else {
      acc.reasoningById.delete(part.id);
      acc.closedReasoningById.delete(part.id);
      ensureReasoningSegment(acc, part.id, part.provider);
    }
    await emit({
      type: part.type,
      id: part.id,
      ...(part.provider && { provider: part.provider }),
    });
    return;
  }
  if (part.type === 'text-delta' || part.type === 'reasoning-delta') {
    if (part.type === 'reasoning-delta') {
      // Emit before mutating segments so an overflowing chunk cut by `onMaxReasoningChars: 'finish-length'`
      // is never retained in `acc.result.segments` or `stepResponseMessages`.
      await emit({
        type: 'reasoning-delta',
        id: part.id,
        text: part.delta,
        ...(part.provider && { provider: part.provider }),
      });
      if (part.delta.length > 0) recordOutputChunk(result);
      ensureReasoningSegment(acc, part.id, part.provider).text += part.delta;
      return;
    }
    if (part.delta.length > 0) recordOutputChunk(result);
    ensureTextSegment(acc, part.id, part.provider).text += part.delta;
    result.stepText += part.delta;
    await emit({
      type: 'text-delta',
      id: part.id,
      text: part.delta,
      ...(part.provider && { provider: part.provider }),
    });
    return;
  }
  if (part.type === 'text-end') {
    const existing = acc.textById.get(part.id) ?? acc.closedTextById.get(part.id);
    if (existing) {
      const merged = mergeEnvelope(existing.provider, part.provider);
      if (merged !== undefined) existing.provider = merged;
      acc.closedTextById.set(part.id, existing);
    } else if (part.provider !== undefined) {
      acc.closedTextById.set(part.id, ensureTextSegment(acc, part.id, part.provider));
    }
    acc.textById.delete(part.id);
  } else {
    const existing = acc.reasoningById.get(part.id) ?? acc.closedReasoningById.get(part.id);
    if (existing) {
      const merged = mergeEnvelope(existing.provider, part.provider);
      if (merged !== undefined) existing.provider = merged;
      acc.closedReasoningById.set(part.id, existing);
    } else if (part.provider !== undefined) {
      acc.closedReasoningById.set(
        part.id,
        ensureReasoningSegment(acc, part.id, part.provider),
      );
    }
    acc.reasoningById.delete(part.id);
  }
  await emit({
    type: part.type,
    id: part.id,
    ...(part.provider && { provider: part.provider }),
  });
}

async function handleGeneratedFilePart(
  result: ConsumedStepStream,
  part: Extract<AgentModelStreamPart, { type: 'file' | 'reasoning-file' }>,
  emit: (event: AgentLoopEvent) => Promise<void>,
): Promise<void> {
  const providerOptions = envelopeToProviderOptions(part.provider);
  if (part.type === 'file') {
    await emit({
      type: 'file',
      mediaType: part.mediaType,
      data: part.data,
      ...(part.filename !== undefined && { filename: part.filename }),
      ...(part.provider && { provider: part.provider }),
    });
    result.segments.push({
      kind: 'provider-part',
      assistantPart: {
        type: 'file',
        mediaType: part.mediaType,
        data: generatedFileToModelFileData(part.data),
        ...(part.filename !== undefined && { filename: part.filename }),
        ...(providerOptions && { providerOptions }),
      },
      stepPart: {
        type: 'file',
        mediaType: part.mediaType,
        data: part.data,
        ...(part.filename !== undefined && { filename: part.filename }),
        ...(part.provider && { provider: part.provider }),
      },
    });
    return;
  }
  await emit({
    type: 'reasoning-file',
    mediaType: part.mediaType,
    data: part.data,
    ...(part.provider && { provider: part.provider }),
  });
  result.segments.push({
    kind: 'provider-part',
    assistantPart: {
      type: 'reasoning-file',
      mediaType: part.mediaType,
      data: generatedFileToModelFileData(part.data),
      ...(providerOptions && { providerOptions }),
    },
    stepPart: {
      type: 'reasoning-file',
      mediaType: part.mediaType,
      data: part.data,
      ...(part.provider && { provider: part.provider }),
    },
  });
}

export async function handleStreamPart(
  acc: StreamAccumulator,
  part: AgentModelStreamPart,
  emit: (event: AgentLoopEvent) => Promise<void>,
  onErrorPart: (error: unknown) => Promise<boolean>,
): Promise<void> {
  const { result } = acc;
  switch (part.type) {
    case 'ping':
    case 'tool-input-end':
      return;
    case 'response-metadata':
      if (part.id !== undefined) result.responseId = part.id;
      if (part.modelId !== undefined) result.responseModelId = part.modelId;
      if (part.timestamp !== undefined) result.responseTimestamp = part.timestamp;
      return;
    case 'error':
      if (await onErrorPart(part.error)) return;
      result.sawErrorPart = true;
      await emit({ type: 'error', error: part.error });
      return;
    case 'text-start':
    case 'text-delta':
    case 'text-end':
    case 'reasoning-start':
    case 'reasoning-delta':
    case 'reasoning-end':
      await handleTextOrReasoningPart(acc, part, emit);
      return;
    case 'tool-input-start':
      await emit({
        type: 'tool-input-start',
        toolCallId: part.toolCallId,
        toolName: part.toolName,
        ...(part.providerExecuted !== undefined && {
          providerExecuted: part.providerExecuted,
        }),
      });
      return;
    case 'tool-input-delta':
      if (part.delta.length > 0) recordOutputChunk(result);
      await emit({
        type: 'tool-input-delta',
        toolCallId: part.toolCallId,
        delta: part.delta,
      });
      return;
    case 'tool-call': {
      if (result.firstOutputAt === undefined) result.firstOutputAt = performance.now();
      result.rawToolCalls.push(part);
      if (part.providerExecuted !== true) return;
      const parsedInput = parseProviderToolInput(part.input);
      const providerOptions = envelopeToProviderOptions(part.provider);
      await emit({
        type: 'tool-call',
        toolCallId: part.toolCallId,
        toolName: part.toolName,
        input: parsedInput,
        ...(part.provider && { provider: part.provider }),
      });
      const stepCall: AgentStepToolCall = {
        type: 'tool-call',
        toolCallId: part.toolCallId,
        toolName: part.toolName,
        input: parsedInput,
        providerExecuted: true,
      };
      result.providerToolCalls.push(stepCall);
      result.segments.push({
        kind: 'provider-part',
        assistantPart: {
          type: 'tool-call',
          toolCallId: part.toolCallId,
          toolName: part.toolName,
          input: parsedInput,
          providerExecuted: true,
          ...(providerOptions && { providerOptions }),
        },
        stepPart: stepCall,
      });
      return;
    }
    case 'tool-result':
      await handleProviderToolResult(result, part, emit);
      return;
    case 'tool-approval-request': {
      const matchingCall = result.rawToolCalls.find(
        (call) => call.toolCallId === part.toolCallId,
      );
      const toolCall: AgentStepToolCall = {
        type: 'tool-call',
        toolCallId: part.toolCallId,
        toolName: matchingCall?.toolName ?? '',
        input: matchingCall ? parseProviderToolInput(matchingCall.input) : {},
        providerExecuted: true,
      };
      await emit({ type: 'tool-approval-request', approvalId: part.approvalId, toolCall });
      result.segments.push({
        kind: 'provider-part',
        assistantPart: {
          type: 'tool-approval-request',
          approvalId: part.approvalId,
          toolCallId: part.toolCallId,
        },
        stepPart: {
          type: 'tool-approval-request',
          approvalId: part.approvalId,
          toolCall,
        },
      });
      return;
    }
    case 'source':
      await emit({ type: 'source', source: part.source });
      result.segments.push({
        kind: 'provider-part',
        stepPart: { type: 'source', source: part.source },
      });
      return;
    case 'file':
    case 'reasoning-file':
      await handleGeneratedFilePart(result, part, emit);
      return;
    case 'custom': {
      const providerOptions = envelopeToProviderOptions(part.provider);
      await emit({
        type: 'custom',
        kind: part.kind,
        ...(part.provider && { provider: part.provider }),
      });
      result.segments.push({
        kind: 'provider-part',
        assistantPart: {
          type: 'custom',
          kind: part.kind,
          ...(providerOptions && { providerOptions }),
        },
        stepPart: {
          type: 'custom',
          kind: part.kind,
          ...(part.provider && { provider: part.provider }),
        },
      });
      return;
    }
    case 'raw':
      await emit({ type: 'raw', rawValue: part.rawValue });
      return;
    case 'finish':
      result.finishPart = part;
      if (part.response?.id !== undefined) result.responseId = part.response.id;
      if (part.response?.modelId !== undefined) result.responseModelId = part.response.modelId;
      if (part.response?.timestamp !== undefined) {
        result.responseTimestamp = part.response.timestamp;
      }
      return;
  }
}
