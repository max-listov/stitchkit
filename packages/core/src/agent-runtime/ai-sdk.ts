import { asSchema, type LanguageModel, type LanguageModelUsage, type ToolSet } from 'ai';
import {
  AgentCacheControlSchema,
  type AgentGeneratedFileData,
  type AgentToolModelContentPart,
  type AgentToolModelOutput,
  AgentToolModelOutputSchema,
} from '../agent-parts/model';
import type { AgentProviderEnvelope, AgentSourcePart } from '../agent-parts/parts';
import { abortReason, raceAbort } from '../internal/abort-race';
import { isRecord } from '../internal/typed';
import type { AgentTool, AgentToolSet } from '../tools/agent-tools';
import type { ToolPresentationSchema } from '../tools/schema/flatten';
import {
  type AiSdkLanguageModelV4,
  normalizeExternalFileData,
  normalizeProviderReference,
  toAgentJsonValue,
  toAgentProviderOptions,
  toAiSdkModelMessages,
  toV4CallOptions,
} from './ai-sdk-convert';
import type {
  AgentModelDriver,
  AgentModelFinishReason,
  AgentModelStreamPart,
} from './models-driver';
import { normalizeTokenUsage, providerEnvelope } from './runtime-internals';
import type { AgentUsage } from './schemas';

type V4StreamResult = Awaited<ReturnType<AiSdkLanguageModelV4['doStream']>>;
type V4StreamPart = V4StreamResult['stream'] extends ReadableStream<infer P> ? P : never;
type V4FinishPart = Extract<V4StreamPart, { type: 'finish' }>;

/** Options for adapting an AI SDK `LanguageModel` to `AgentModelDriver`. */
export interface FromAiSdkModelOptions {
  /** Convert AI SDK step usage + providerMetadata into provenance-aware `AgentUsage`. */
  normalizeUsage?(input: {
    usage: LanguageModelUsage;
    providerMetadata?: unknown;
  }): AgentUsage;
  /** Resolve the upstream provider name reported inside gateway `providerMetadata`. */
  resolveResponseProvider?(input: { providerMetadata?: unknown }): string | undefined;
}

function isV4LanguageModel(model: LanguageModel): model is AiSdkLanguageModelV4 {
  return (
    typeof model === 'object' &&
    model !== null &&
    'specificationVersion' in model &&
    model.specificationVersion === 'v4' &&
    typeof model.doStream === 'function'
  );
}

function toLanguageModelUsage(v4Usage: V4FinishPart['usage']): LanguageModelUsage {
  const inputTotal = v4Usage.inputTokens.total;
  const outputTotal = v4Usage.outputTokens.total;
  return {
    inputTokens: inputTotal,
    outputTokens: outputTotal,
    totalTokens:
      inputTotal !== undefined && outputTotal !== undefined
        ? inputTotal + outputTotal
        : undefined,
    inputTokenDetails: {
      noCacheTokens: v4Usage.inputTokens.noCache,
      cacheReadTokens: v4Usage.inputTokens.cacheRead,
      cacheWriteTokens: v4Usage.inputTokens.cacheWrite,
    },
    outputTokenDetails: {
      textTokens: v4Usage.outputTokens.text,
      reasoningTokens: v4Usage.outputTokens.reasoning,
    },
    ...(v4Usage.raw !== undefined && { raw: v4Usage.raw }),
  };
}

function mapFinishReason(raw: V4FinishPart['finishReason']): AgentModelFinishReason {
  switch (raw.unified) {
    case 'stop':
    case 'length':
    case 'tool-calls':
    case 'content-filter':
    case 'error':
    case 'interrupted':
      return raw.unified;
    default:
      return 'other';
  }
}

function extractGeneratedFileData(
  data: Extract<V4StreamPart, { type: 'file' }>['data'],
): AgentGeneratedFileData {
  return data.type === 'data'
    ? { type: 'data', data: data.data }
    : { type: 'url', url: data.url };
}

function mapV4StreamPart(
  part: V4StreamPart,
  options: FromAiSdkModelOptions,
): AgentModelStreamPart | undefined {
  const env = (meta: unknown): AgentProviderEnvelope | undefined => {
    const cleaned = toAgentProviderOptions(meta);
    return cleaned !== undefined ? providerEnvelope(cleaned) : undefined;
  };
  switch (part.type) {
    case 'stream-start':
      return undefined;
    case 'response-metadata':
      return {
        type: 'response-metadata',
        ...(part.id !== undefined && { id: part.id }),
        ...(part.modelId !== undefined && { modelId: part.modelId }),
        ...(part.timestamp !== undefined && { timestamp: part.timestamp }),
      };
    case 'text-start':
    case 'text-end':
    case 'reasoning-start':
    case 'reasoning-end': {
      const provider = env(part.providerMetadata);
      return { type: part.type, id: part.id, ...(provider && { provider }) };
    }
    case 'text-delta':
    case 'reasoning-delta': {
      const provider = env(part.providerMetadata);
      return {
        type: part.type,
        id: part.id,
        delta: part.delta,
        ...(provider && { provider }),
      };
    }
    case 'tool-input-start':
      return {
        type: 'tool-input-start',
        toolCallId: part.id,
        toolName: part.toolName,
        ...(part.providerExecuted !== undefined && {
          providerExecuted: part.providerExecuted,
        }),
      };
    case 'tool-input-delta':
      return { type: 'tool-input-delta', toolCallId: part.id, delta: part.delta };
    case 'tool-input-end':
      return { type: 'tool-input-end', toolCallId: part.id };
    case 'tool-call': {
      const provider = env(part.providerMetadata);
      return {
        type: 'tool-call',
        toolCallId: part.toolCallId,
        toolName: part.toolName,
        input: part.input,
        ...(part.providerExecuted !== undefined && {
          providerExecuted: part.providerExecuted,
        }),
        ...(part.dynamic !== undefined && { dynamic: part.dynamic }),
        ...(provider && { provider }),
      };
    }
    case 'tool-result': {
      const provider = env(part.providerMetadata);
      return {
        type: 'tool-result',
        toolCallId: part.toolCallId,
        toolName: part.toolName,
        result: part.result,
        providerExecuted: true,
        ...(part.isError !== undefined && { isError: part.isError }),
        ...(part.preliminary !== undefined && { preliminary: part.preliminary }),
        ...(provider && { provider }),
      };
    }
    case 'tool-approval-request': {
      const provider = env(part.providerMetadata);
      return {
        type: 'tool-approval-request',
        approvalId: part.approvalId,
        toolCallId: part.toolCallId,
        ...(provider && { provider }),
      };
    }
    case 'source': {
      const validUrl =
        part.sourceType === 'url' && typeof part.url === 'string' && URL.canParse(part.url)
          ? part.url
          : undefined;
      const source: AgentSourcePart = {
        type: 'source',
        sourceId: part.id,
        ...(validUrl !== undefined && { url: validUrl }),
        ...(part.title !== undefined && { title: part.title }),
      };
      return { type: 'source', source };
    }
    case 'file':
    case 'reasoning-file': {
      const provider = env(part.providerMetadata);
      return {
        type: part.type,
        mediaType: part.mediaType,
        data: extractGeneratedFileData(part.data),
        ...(provider && { provider }),
      };
    }
    case 'custom': {
      const provider = env(part.providerMetadata);
      return { type: 'custom', kind: part.kind, ...(provider && { provider }) };
    }
    case 'raw':
      return { type: 'raw', rawValue: part.rawValue };
    case 'error':
      return { type: 'error', error: part.error };
    case 'finish': {
      const sdkUsage = toLanguageModelUsage(part.usage);
      const usage = options.normalizeUsage
        ? options.normalizeUsage({ usage: sdkUsage, providerMetadata: part.providerMetadata })
        : normalizeTokenUsage({
            inputTokens: sdkUsage.inputTokens,
            outputTokens: sdkUsage.outputTokens,
            reasoningTokens: sdkUsage.outputTokenDetails.reasoningTokens,
            cacheReadTokens: sdkUsage.inputTokenDetails.cacheReadTokens,
            cacheWriteTokens: sdkUsage.inputTokenDetails.cacheWriteTokens,
          });
      const responseProvider = options.resolveResponseProvider?.({
        providerMetadata: part.providerMetadata,
      });
      const provider = env(part.providerMetadata);
      return {
        type: 'finish',
        finishReason: mapFinishReason(part.finishReason),
        ...(part.finishReason.raw !== undefined && { rawFinishReason: part.finishReason.raw }),
        usage,
        ...(responseProvider !== undefined && { responseProvider }),
        ...(provider && { provider }),
      };
    }
    default:
      return undefined;
  }
}

/**
 * Adapt any AI SDK v4 `LanguageModel` into a single-step `AgentModelDriver`.
 *
 * Imports neither `streamText` nor `generateText`; drives `model.doStream()`
 * directly so `stitchkit/agent-runtime` owns the one step loop (I8). → ADR 0336.
 */
export function fromAiSdkModel(
  model: LanguageModel,
  options: FromAiSdkModelOptions = {},
): AgentModelDriver {
  if (!isV4LanguageModel(model)) {
    throw new TypeError(
      'fromAiSdkModel requires an AI SDK LanguageModelV4 object (specificationVersion: "v4")',
    );
  }
  return {
    provider: model.provider,
    modelId: model.modelId,
    async stream(request, signal) {
      const result = await model.doStream(toV4CallOptions(request, signal));
      const parts: AsyncIterable<AgentModelStreamPart> = {
        async *[Symbol.asyncIterator]() {
          const reader = result.stream.getReader();
          const onAbort = (): void => {
            void reader.cancel(abortReason(signal)).catch(() => undefined);
          };
          if (signal.aborted) {
            void reader.cancel(abortReason(signal)).catch(() => undefined);
            throw abortReason(signal);
          }
          signal.addEventListener('abort', onAbort, { once: true });
          try {
            for (;;) {
              const next = await raceAbort(reader.read(), signal);
              signal.throwIfAborted();
              if (next.done) break;
              const mapped = mapV4StreamPart(next.value, options);
              if (mapped !== undefined) yield mapped;
            }
          } finally {
            signal.removeEventListener('abort', onAbort);
            if (signal.aborted) {
              void reader.cancel(abortReason(signal)).catch(() => undefined);
            } else {
              await reader.cancel().catch(() => undefined);
              reader.releaseLock();
            }
          }
        },
      };
      return { parts };
    },
  };
}

/**
 * Normalize external AI SDK `ToolResultOutput` (including deprecated legacy content part
 * shapes emitted by third-party AI SDK tools) into canonical peer-free `AgentToolModelOutput`.
 */
function normalizeExternalToolOutput(raw: unknown): AgentToolModelOutput {
  const direct = AgentToolModelOutputSchema.safeParse(raw);
  if (direct.success) return direct.data;
  if (!isRecord(raw) || typeof raw.type !== 'string') {
    return { type: 'text', value: JSON.stringify(raw) ?? '' };
  }
  const topOpts = toAgentProviderOptions(raw.providerOptions);
  const parsedCc = AgentCacheControlSchema.safeParse(raw.cacheControl);
  const topFields = {
    ...(topOpts && { providerOptions: topOpts }),
    ...(parsedCc.success && { cacheControl: parsedCc.data }),
  };
  if ((raw.type === 'text' || raw.type === 'error-text') && typeof raw.value === 'string') {
    return { type: raw.type, value: raw.value, ...topFields };
  }
  if ((raw.type === 'json' || raw.type === 'error-json') && 'value' in raw) {
    return { type: raw.type, value: toAgentJsonValue(raw.value), ...topFields };
  }
  if (raw.type === 'execution-denied') {
    return {
      type: 'execution-denied',
      ...(typeof raw.reason === 'string' && { reason: raw.reason }),
      ...topFields,
    };
  }
  if (raw.type !== 'content' || !Array.isArray(raw.value)) {
    return { type: 'text', value: JSON.stringify(raw) ?? '' };
  }
  const parts: AgentToolModelContentPart[] = [];
  for (const entry of raw.value) {
    if (!isRecord(entry) || typeof entry.type !== 'string') continue;
    const providerOptions = toAgentProviderOptions(entry.providerOptions);
    const optField = providerOptions ? { providerOptions } : {};
    if (entry.type === 'text' && typeof entry.text === 'string') {
      parts.push({ type: 'text', text: entry.text, ...optField });
    } else if (entry.type === 'custom') {
      parts.push({ type: 'custom', ...optField });
    } else if (
      (entry.type === 'file' || entry.type === 'media') &&
      typeof entry.mediaType === 'string'
    ) {
      const data = normalizeExternalFileData(entry.data);
      if (data) {
        parts.push({
          type: 'file',
          data,
          mediaType: entry.mediaType,
          ...(typeof entry.filename === 'string' && { filename: entry.filename }),
          ...optField,
        });
      }
    } else if (
      (entry.type === 'file-data' || entry.type === 'image-data') &&
      typeof entry.data === 'string' &&
      typeof entry.mediaType === 'string'
    ) {
      parts.push({
        type: 'file',
        data: { type: 'data', data: entry.data },
        mediaType: entry.mediaType,
        ...(typeof entry.filename === 'string' && { filename: entry.filename }),
        ...optField,
      });
    } else if (
      (entry.type === 'file-url' || entry.type === 'image-url') &&
      typeof entry.url === 'string' &&
      URL.canParse(entry.url)
    ) {
      const mediaType =
        entry.type === 'image-url'
          ? 'image/*'
          : typeof entry.mediaType === 'string'
            ? entry.mediaType
            : 'application/octet-stream';
      parts.push({
        type: 'file',
        data: { type: 'url', url: new URL(entry.url), originalUrl: entry.url },
        mediaType,
        ...optField,
      });
    } else if (entry.type === 'file-id' || entry.type === 'image-file-id') {
      const reference = normalizeProviderReference(entry.fileId);
      if (reference) {
        parts.push({
          type: 'file',
          data: { type: 'reference', reference },
          mediaType: entry.type === 'image-file-id' ? 'image/*' : 'application/octet-stream',
          ...optField,
        });
      }
    } else if (entry.type === 'file-reference' || entry.type === 'image-file-reference') {
      const reference = normalizeProviderReference(entry.providerReference);
      if (reference) {
        parts.push({
          type: 'file',
          data: { type: 'reference', reference },
          mediaType:
            entry.type === 'image-file-reference' ? 'image/*' : 'application/octet-stream',
          ...optField,
        });
      }
    }
  }
  return AgentToolModelOutputSchema.parse({ type: 'content', value: parts, ...topFields });
}

/**
 * Adapt an AI SDK `ToolSet` into a peer-free `AgentToolSet`.
 *
 * Refuses provider-defined tools (`type: 'provider'`) loudly and normalizes external AI SDK
 * tool outputs into canonical `{ type: 'file', data, mediaType }` parts. → ADR 0336.
 */
export async function fromAiSdkTools(toolSet: ToolSet): Promise<AgentToolSet> {
  const result: AgentToolSet = {};
  for (const [name, sdkTool] of Object.entries(toolSet)) {
    if (sdkTool.type === 'provider') {
      throw new TypeError(
        `fromAiSdkTools does not support provider-defined tool "${name}" (type: "provider")`,
      );
    }
    const schema = asSchema(sdkTool.inputSchema);
    const resolvedSchema = await schema.jsonSchema;
    const inputSchema: ToolPresentationSchema = isRecord(resolvedSchema)
      ? { ...resolvedSchema }
      : {};
    const description =
      typeof sdkTool.description === 'string'
        ? sdkTool.description
        : typeof sdkTool.description === 'function'
          ? sdkTool.description({ context: undefined })
          : undefined;
    const execute = sdkTool.execute;
    const needsApproval = sdkTool.needsApproval;
    const onInputAvailable = sdkTool.onInputAvailable;
    const toModelOutput = sdkTool.toModelOutput;
    const providerOptions = toAgentProviderOptions(sdkTool.providerOptions);

    const adapted: AgentTool = {
      ...(description !== undefined && { description }),
      inputSchema,
      ...(sdkTool.strict !== undefined && { strict: sdkTool.strict }),
      ...(providerOptions && { providerOptions }),
      parseInput: async (value: unknown) => {
        if (!schema.validate) return { ok: true, value };
        const checked = await schema.validate(value);
        return checked.success
          ? { ok: true, value: checked.value }
          : { ok: false, error: checked.error };
      },
      ...(execute && {
        execute(input, call) {
          return execute.call(sdkTool, input, {
            toolCallId: call.toolCallId,
            messages: toAiSdkModelMessages(call.messages),
            abortSignal: call.abortSignal,
            context: undefined,
          });
        },
      }),
      ...(needsApproval !== undefined && {
        needsApproval:
          typeof needsApproval === 'function'
            ? (input, call) =>
                needsApproval.call(sdkTool, input, {
                  toolCallId: call.toolCallId,
                  messages: toAiSdkModelMessages(call.messages),
                  context: undefined,
                })
            : needsApproval,
      }),
      ...(onInputAvailable && {
        onInputAvailable(opts) {
          return onInputAvailable.call(sdkTool, {
            input: opts.input,
            toolCallId: opts.toolCallId,
            messages: toAiSdkModelMessages(opts.messages),
            abortSignal: opts.abortSignal,
            context: undefined,
          });
        },
      }),
      ...(toModelOutput && {
        async toModelOutput(opts): Promise<AgentToolModelOutput> {
          const raw = await toModelOutput.call(sdkTool, opts);
          return normalizeExternalToolOutput(raw);
        },
      }),
    };
    result[name] = adapted;
  }
  return result;
}
