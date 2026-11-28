import { z } from 'zod';
import type {
  AgentGeneratedFileData,
  AgentModelAssistantContentPart,
  AgentModelFileData,
} from '../agent-parts/model';
import type { AgentProviderEnvelope } from '../agent-parts/parts';
import { isRecord } from '../internal/typed';
import { AgentToolError, isAgentToolError } from '../tools/agent-tool-error';
import type { AgentModelResponseMetadata, AgentModelStreamPart } from './models-driver';
import type {
  AgentStepContentPart,
  AgentStepToolCall,
  AgentStepToolResult,
} from './models-driver-step';
import type { RawProviderToolCall } from './run-tool-call';

/** Upper bound on recorded output-chunk timestamps per step (I10). */
const MAX_CHUNK_TIMESTAMPS = 32_768;

/** Ordered assistant content segment captured during one model step stream. */
export type ConsumedAssistantSegment =
  | {
      readonly kind: 'reasoning';
      readonly id: string;
      text: string;
      provider?: AgentProviderEnvelope;
    }
  | {
      readonly kind: 'text';
      readonly id: string;
      text: string;
      provider?: AgentProviderEnvelope;
    }
  | {
      readonly kind: 'provider-part';
      readonly assistantPart?: AgentModelAssistantContentPart;
      readonly stepPart?: AgentStepContentPart;
    };

/** Accumulated output, response identity, and chunk timing facts from one model step stream. */
export interface ConsumedStepStream {
  stepText: string;
  segments: ConsumedAssistantSegment[];
  rawToolCalls: RawProviderToolCall[];
  providerToolCalls: AgentStepToolCall[];
  providerToolResults: AgentStepToolResult[];
  responseId: string;
  responseModelId: string | undefined;
  responseTimestamp: Date | undefined;
  finishPart: Extract<AgentModelStreamPart, { type: 'finish' }> | undefined;
  sawErrorPart: boolean;
  firstOutputAt: number | undefined;
  readonly outputChunkTimestamps: number[];
}

export type ReasoningSegment = Extract<ConsumedAssistantSegment, { kind: 'reasoning' }>;
export type TextSegment = Extract<ConsumedAssistantSegment, { kind: 'text' }>;

export interface StreamAccumulator {
  readonly result: ConsumedStepStream;
  readonly reasoningById: Map<string, ReasoningSegment>;
  readonly closedReasoningById: Map<string, ReasoningSegment>;
  readonly textById: Map<string, TextSegment>;
  readonly closedTextById: Map<string, TextSegment>;
}

export function parseProviderToolInput(raw: string): unknown {
  const trimmed = raw.trim();
  if (trimmed.length === 0) return {};
  try {
    return JSON.parse(trimmed);
  } catch {
    return raw;
  }
}

export function safeJsonValue(value: unknown): z.infer<ReturnType<typeof z.json>> {
  const parsed = z.json().safeParse(value);
  return parsed.success ? parsed.data : { message: 'Non-JSON tool output omitted' };
}

export function toProviderToolError(result: unknown): AgentToolError {
  if (isAgentToolError(result)) return result;
  if (isRecord(result)) return new AgentToolError(result);
  if (typeof result === 'string' && result.length > 0) {
    return new AgentToolError({ message: result });
  }
  return new AgentToolError({
    message: 'Provider tool execution failed',
    ...(result !== undefined && { result }),
  });
}

export function generatedFileToModelFileData(
  data: AgentGeneratedFileData,
): AgentModelFileData {
  if (data.type === 'url') return data;
  if (typeof data.data === 'string') return { type: 'data', data: data.data };
  const copy = new Uint8Array(data.data.byteLength);
  copy.set(data.data);
  return { type: 'data', data: copy };
}

export function mergeEnvelope(
  current: AgentProviderEnvelope | undefined,
  next: AgentProviderEnvelope | undefined,
): AgentProviderEnvelope | undefined {
  if (!next) return current;
  if (!current || current.provider !== next.provider) return next;
  return {
    ...current,
    schemaVersion: next.schemaVersion,
    data: { ...current.data, ...next.data },
  };
}

export function recordOutputChunk(result: ConsumedStepStream): void {
  const now = performance.now();
  if (result.firstOutputAt === undefined) result.firstOutputAt = now;
  if (result.outputChunkTimestamps.length < MAX_CHUNK_TIMESTAMPS) {
    result.outputChunkTimestamps.push(now);
  }
}

export function createStreamAccumulator(
  response: AgentModelResponseMetadata | undefined,
): StreamAccumulator {
  return {
    result: {
      stepText: '',
      segments: [],
      rawToolCalls: [],
      providerToolCalls: [],
      providerToolResults: [],
      responseId: response?.id ?? '',
      responseModelId: response?.modelId,
      responseTimestamp: response?.timestamp,
      finishPart: undefined,
      sawErrorPart: false,
      firstOutputAt: undefined,
      outputChunkTimestamps: [],
    },
    reasoningById: new Map(),
    closedReasoningById: new Map(),
    textById: new Map(),
    closedTextById: new Map(),
  };
}

export function ensureReasoningSegment(
  acc: StreamAccumulator,
  id: string,
  provider?: AgentProviderEnvelope,
): ReasoningSegment {
  const existing = acc.reasoningById.get(id);
  if (existing) {
    const merged = mergeEnvelope(existing.provider, provider);
    if (merged !== undefined) existing.provider = merged;
    return existing;
  }
  const created: ReasoningSegment = {
    kind: 'reasoning',
    id,
    text: '',
    ...(provider !== undefined && { provider }),
  };
  acc.result.segments.push(created);
  acc.reasoningById.set(id, created);
  return created;
}

export function ensureTextSegment(
  acc: StreamAccumulator,
  id: string,
  provider?: AgentProviderEnvelope,
): TextSegment {
  const existing = acc.textById.get(id);
  if (existing) {
    const merged = mergeEnvelope(existing.provider, provider);
    if (merged !== undefined) existing.provider = merged;
    return existing;
  }
  const created: TextSegment = {
    kind: 'text',
    id,
    text: '',
    ...(provider !== undefined && { provider }),
  };
  acc.result.segments.push(created);
  acc.textById.set(id, created);
  return created;
}
