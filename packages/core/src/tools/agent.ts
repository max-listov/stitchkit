import type { Tool, ToolExecutionOptions, ToolSet } from 'ai';
import { jsonSchema, tool } from 'ai';
import type {
  AgentModelFileData,
  AgentModelJsonValue,
  AgentModelMessage,
  AgentModelProviderOptions,
  AgentToolModelOutput,
} from '../agent-parts/model';
import { isRecord } from '../internal/typed';
import type { ServiceDef } from '../server/types';
import { adaptAiSdkMessages, safeJsonValue } from './agent-messages';
import { type AgentMountConfig, type AgentToolSet, buildAgentTools } from './agent-tools';

type AiSdkToolOutput = Awaited<
  ReturnType<NonNullable<Tool<unknown, unknown>['toModelOutput']>>
>;
type AiSdkProviderOptions = NonNullable<Tool<unknown, unknown>['providerOptions']>;
type AiSdkContentItem = Extract<AiSdkToolOutput, { type: 'content' }>['value'][number];
type AiSdkFilePart = Extract<AiSdkContentItem, { type: 'file' }>;

function toAiSdkProviderOptions(
  options: AgentModelProviderOptions | undefined,
): AiSdkProviderOptions | undefined {
  if (!options) return undefined;
  const out: AiSdkProviderOptions = {};
  for (const [namespace, entry] of Object.entries(options)) {
    if (!entry) continue;
    const inner: Record<string, AgentModelJsonValue> = {};
    for (const [key, value] of Object.entries(entry)) {
      if (value !== undefined) inner[key] = safeJsonValue(value);
    }
    out[namespace] = inner;
  }
  return Object.keys(out).length > 0 ? out : undefined;
}

function toAiSdkFileData(data: AgentModelFileData): AiSdkFilePart['data'] {
  if (data.type === 'data') return { type: 'data', data: data.data };
  if (data.type === 'url') return { type: 'url', url: data.url };
  if (data.type === 'reference') return { type: 'reference', reference: data.reference };
  return { type: 'text', text: data.text };
}

function toAiSdkModelOutput(output: AgentToolModelOutput): AiSdkToolOutput {
  const sanitized = toAiSdkProviderOptions(output.providerOptions);
  const opts = sanitized ? { providerOptions: sanitized } : {};
  if (output.type === 'text' || output.type === 'error-text') {
    return { type: output.type, value: output.value, ...opts };
  }
  if (output.type === 'json' || output.type === 'error-json') {
    return { type: output.type, value: output.value, ...opts };
  }
  if (output.type === 'execution-denied') {
    return {
      type: 'execution-denied',
      ...(output.reason !== undefined && { reason: output.reason }),
      ...opts,
    };
  }
  const items: AiSdkContentItem[] = output.value.map((part): AiSdkContentItem => {
    const partSanitized = toAiSdkProviderOptions(part.providerOptions);
    const partOpts = partSanitized ? { providerOptions: partSanitized } : {};
    if (part.type === 'text') return { type: 'text', text: part.text, ...partOpts };
    if (part.type === 'file') {
      return {
        type: 'file',
        data: toAiSdkFileData(part.data),
        mediaType: part.mediaType,
        ...(part.filename !== undefined && { filename: part.filename }),
        ...partOpts,
      };
    }
    return { type: 'custom', ...partOpts };
  });
  return { type: 'content', value: items, ...opts };
}

/**
 * Adapt a peer-free `AgentToolSet` into an AI SDK `ToolSet`.
 *
 * Wraps each declared JSON Schema with `jsonSchema()` so `@ai-sdk/provider-utils`
 * preserves `additionalProperties` and every authored keyword verbatim, and emits
 * only non-deprecated `{ type: 'file', data, mediaType }` outputs. → ADR 0336.
 */
function toAiSdkToolSet(nativeTools: AgentToolSet): ToolSet {
  const tools: ToolSet = {};
  for (const [name, nativeTool] of Object.entries(nativeTools)) {
    const parseInput = nativeTool.parseInput;
    const inputSchema = jsonSchema<unknown>(nativeTool.inputSchema, {
      validate: async (value) => {
        if (parseInput) {
          const parsed = await parseInput(value);
          return parsed.ok
            ? { success: true, value: parsed.value }
            : {
                success: false,
                error:
                  parsed.error instanceof Error
                    ? parsed.error
                    : new Error(String(parsed.error)),
              };
        }
        return isRecord(value)
          ? { success: true, value }
          : { success: false, error: new Error('Tool arguments must be an object') };
      },
    });
    const nativeExecute = nativeTool.execute;
    const execute = nativeExecute
      ? (rawArgs: unknown, options: ToolExecutionOptions<Record<string, unknown>>) => {
          let adaptedMessages: AgentModelMessage[] | undefined;
          return nativeExecute.call(nativeTool, rawArgs, {
            toolCallId: options.toolCallId,
            get messages() {
              adaptedMessages ??= adaptAiSdkMessages(options.messages);
              return adaptedMessages;
            },
            abortSignal: options.abortSignal,
          });
        }
      : undefined;
    const nativeToModelOutput = nativeTool.toModelOutput;
    const toModelOutput = nativeToModelOutput
      ? async (options: { toolCallId: string; input: unknown; output: unknown }) =>
          toAiSdkModelOutput(await nativeToModelOutput.call(nativeTool, options))
      : undefined;
    const toolProviderOptions = toAiSdkProviderOptions(nativeTool.providerOptions);
    const shared = {
      description: nativeTool.description,
      inputSchema,
      ...(nativeTool.strict !== undefined && { strict: nativeTool.strict }),
      ...(toolProviderOptions && { providerOptions: toolProviderOptions }),
    };
    const withOutput = { ...shared, ...(toModelOutput && { toModelOutput }) };
    if (execute) {
      tools[name] = tool<unknown, unknown, Record<string, unknown>>({
        ...withOutput,
        ...(nativeTool.outputSchema && { outputSchema: nativeTool.outputSchema }),
        execute,
      });
    } else if (nativeTool.outputSchema) {
      tools[name] = tool<unknown, unknown, Record<string, unknown>>({
        ...withOutput,
        outputSchema: nativeTool.outputSchema,
      });
    } else {
      tools[name] = tool<unknown, never, Record<string, unknown>>(shared);
    }
  }
  return tools;
}

/**
 * Mount contract services and runtime tools as an AI SDK `ToolSet` for applications
 * driving their own AI SDK loop. Delegates surface projection and execution to
 * `mountAgentTools`. → ADR 0336.
 */
export function mountAgent(
  services: ServiceDef | ServiceDef[],
  config: AgentMountConfig,
): ToolSet {
  return toAiSdkToolSet(buildAgentTools(services, config, 'mountAgent'));
}
