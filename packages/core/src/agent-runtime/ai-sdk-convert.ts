import type { LanguageModel, ModelMessage } from 'ai';
import type {
  AgentModelFileData,
  AgentModelJsonValue,
  AgentModelMessage,
  AgentModelProviderOptions,
  AgentModelProviderOptionValue,
  AgentModelUserContentPart,
  AgentToolModelOutput,
} from '../agent-parts/model';
import { isRecord } from '../internal/typed';
import type { AgentModelRequest } from './models-driver';

export type AiSdkLanguageModelV4 = Extract<
  Exclude<LanguageModel, string>,
  { specificationVersion: 'v4' }
>;
export type V4CallOptions = Parameters<AiSdkLanguageModelV4['doStream']>[0];
type V4Prompt = V4CallOptions['prompt'];
type V4Message = V4Prompt[number];
type V4UserPart = Extract<V4Message, { role: 'user' }>['content'][number];
type V4AssistantContent = Extract<V4Message, { role: 'assistant' }>['content'];
type V4ToolContent = Extract<V4Message, { role: 'tool' }>['content'];
type V4ToolResultOutput = Extract<V4ToolContent[number], { type: 'tool-result' }>['output'];
type V4FileData = Extract<V4UserPart, { type: 'file' }>['data'];
type V4ProviderOptions = NonNullable<V4CallOptions['providerOptions']>;
type V4JsonObject = V4ProviderOptions[string];
type V4JsonValue = Exclude<V4JsonObject[string], undefined>;
type V4JsonSchema = Extract<
  NonNullable<V4CallOptions['tools']>[number],
  { type: 'function' }
>['inputSchema'];

function isCustomKind(kind: string): kind is `${string}.${string}` {
  return kind.includes('.');
}

function toV4JsonValue(
  value: AgentModelJsonValue | AgentModelProviderOptionValue,
): V4JsonValue {
  if (
    value === null ||
    typeof value === 'string' ||
    typeof value === 'number' ||
    typeof value === 'boolean'
  ) {
    return value;
  }
  if (Array.isArray(value)) return value.map(toV4JsonValue);
  const out: V4JsonObject = {};
  for (const [k, v] of Object.entries(value)) {
    if (v !== undefined) out[k] = toV4JsonValue(v);
  }
  return out;
}

function toV4ProviderOptions(
  options: AgentModelProviderOptions | undefined,
): V4ProviderOptions | undefined {
  if (!options) return undefined;
  const out: V4ProviderOptions = {};
  for (const [providerKey, entry] of Object.entries(options)) {
    if (!entry) continue;
    const inner: V4JsonObject = {};
    for (const [k, v] of Object.entries(entry)) {
      if (v !== undefined) inner[k] = toV4JsonValue(v);
    }
    out[providerKey] = inner;
  }
  return out;
}

function toV4ProviderReference(
  reference: Readonly<Record<string, string>>,
): Extract<V4FileData, { type: 'reference' }>['reference'] {
  const out: Record<string, string> & { type?: never } = {};
  for (const [key, value] of Object.entries(reference)) {
    if (key !== 'type') out[key] = value;
  }
  return out;
}

function toV4FileData(data: AgentModelFileData): V4FileData {
  switch (data.type) {
    case 'data':
      return {
        type: 'data',
        data: data.data instanceof ArrayBuffer ? new Uint8Array(data.data) : data.data,
      };
    case 'url':
      return {
        type: 'url',
        url: data.url,
        ...(data.originalUrl !== undefined && { originalUrl: data.originalUrl }),
      };
    case 'reference':
      return { type: 'reference', reference: toV4ProviderReference(data.reference) };
    case 'text':
      return { type: 'text', text: data.text };
  }
}

function toV4JsonSchema(schema: Record<string, unknown>): V4JsonSchema {
  // Boundary: `ToolPresentationSchema` and `z.toJSONSchema` emit JSON Schema objects compatible with V4 `JSONSchema7`.
  return schema as V4JsonSchema;
}

function toV4ToolOutput(output: AgentToolModelOutput): V4ToolResultOutput {
  const providerOptions = toV4ProviderOptions(output.providerOptions);
  switch (output.type) {
    case 'text':
    case 'error-text':
      return {
        type: output.type,
        value: output.value,
        ...(providerOptions && { providerOptions }),
      };
    case 'json':
    case 'error-json':
      return {
        type: output.type,
        value: toV4JsonValue(output.value),
        ...(providerOptions && { providerOptions }),
      };
    case 'execution-denied':
      return {
        type: 'execution-denied',
        ...(output.reason !== undefined && { reason: output.reason }),
        ...(providerOptions && { providerOptions }),
      };
    case 'content':
      return {
        type: 'content',
        value: output.value.map((part) => {
          const partOpts = toV4ProviderOptions(part.providerOptions);
          if (part.type === 'text') {
            return {
              type: 'text',
              text: part.text,
              ...(partOpts && { providerOptions: partOpts }),
            };
          }
          if (part.type === 'file') {
            return {
              type: 'file',
              data: toV4FileData(part.data),
              mediaType: part.mediaType,
              ...(part.filename !== undefined && { filename: part.filename }),
              ...(partOpts && { providerOptions: partOpts }),
            };
          }
          return { type: 'custom', ...(partOpts && { providerOptions: partOpts }) };
        }),
      };
  }
}

function convertUserPart(part: AgentModelUserContentPart): V4UserPart {
  const providerOptions = toV4ProviderOptions(part.providerOptions);
  if (part.type === 'text') {
    return { type: 'text', text: part.text, ...(providerOptions && { providerOptions }) };
  }
  return {
    type: 'file',
    data: toV4FileData(part.data),
    mediaType: part.mediaType,
    ...(part.filename !== undefined && { filename: part.filename }),
    ...(providerOptions && { providerOptions }),
  };
}

function convertAssistantParts(
  content: Extract<AgentModelMessage, { role: 'assistant' }>['content'],
): V4AssistantContent {
  if (typeof content === 'string')
    return content.length > 0 ? [{ type: 'text', text: content }] : [];
  const out: V4AssistantContent = [];
  for (const part of content) {
    const providerOptions =
      'providerOptions' in part ? toV4ProviderOptions(part.providerOptions) : undefined;
    const opt = providerOptions ? { providerOptions } : {};
    switch (part.type) {
      case 'text':
        out.push({ type: 'text', text: part.text, ...opt });
        break;
      case 'reasoning':
        out.push({ type: 'reasoning', text: part.text, ...opt });
        break;
      case 'file':
        out.push({
          type: 'file',
          data: toV4FileData(part.data),
          mediaType: part.mediaType,
          ...(part.filename !== undefined && { filename: part.filename }),
          ...opt,
        });
        break;
      case 'reasoning-file': {
        const data = toV4FileData(part.data);
        out.push(
          data.type === 'data' || data.type === 'url'
            ? { type: 'reasoning-file', data, mediaType: part.mediaType, ...opt }
            : { type: 'file', data, mediaType: part.mediaType, ...opt },
        );
        break;
      }
      case 'tool-call':
        out.push({
          type: 'tool-call',
          toolCallId: part.toolCallId,
          toolName: part.toolName,
          input: part.input,
          ...(part.providerExecuted !== undefined && {
            providerExecuted: part.providerExecuted,
          }),
          ...opt,
        });
        break;
      case 'tool-result':
        out.push({
          type: 'tool-result',
          toolCallId: part.toolCallId,
          toolName: part.toolName,
          output: toV4ToolOutput(part.output),
          ...opt,
        });
        break;
      case 'custom':
        if (isCustomKind(part.kind)) out.push({ type: 'custom', kind: part.kind, ...opt });
        break;
      case 'tool-approval-request':
        break;
    }
  }
  return out;
}

function convertToolParts(
  content: Extract<AgentModelMessage, { role: 'tool' }>['content'],
  includeClientApprovals: boolean,
): V4ToolContent {
  const out: V4ToolContent = [];
  for (const part of content) {
    if (part.type === 'tool-result') {
      const providerOptions = toV4ProviderOptions(part.providerOptions);
      out.push({
        type: 'tool-result',
        toolCallId: part.toolCallId,
        toolName: part.toolName,
        output: toV4ToolOutput(part.output),
        ...(providerOptions && { providerOptions }),
      });
    } else if (includeClientApprovals || part.providerExecuted === true) {
      out.push({
        type: 'tool-approval-response',
        approvalId: part.approvalId,
        approved: part.approved,
        ...(part.reason !== undefined && { reason: part.reason }),
      });
    }
  }
  return out;
}

function toV4Prompt(request: AgentModelRequest): V4Prompt {
  const prompt: V4Prompt = [];
  for (const sys of request.instructions) {
    if (sys.content.length === 0) continue;
    const providerOptions = toV4ProviderOptions(sys.providerOptions);
    prompt.push({
      role: 'system',
      content: sys.content,
      ...(providerOptions && { providerOptions }),
    });
  }
  for (const message of request.messages) {
    const providerOptions = toV4ProviderOptions(message.providerOptions);
    const opt = providerOptions ? { providerOptions } : {};
    if (message.role === 'system') {
      if (message.content.length > 0)
        prompt.push({ role: 'system', content: message.content, ...opt });
    } else if (message.role === 'user') {
      const content: V4UserPart[] =
        typeof message.content === 'string'
          ? message.content.length > 0
            ? [{ type: 'text', text: message.content }]
            : []
          : message.content.map(convertUserPart);
      if (content.length > 0) prompt.push({ role: 'user', content, ...opt });
    } else if (message.role === 'assistant') {
      const content = convertAssistantParts(message.content);
      if (content.length > 0) prompt.push({ role: 'assistant', content, ...opt });
    } else {
      const content = convertToolParts(message.content, false);
      if (content.length > 0) prompt.push({ role: 'tool', content, ...opt });
    }
  }
  return prompt;
}

/** Convert canonical `AgentModelMessage[]` to AI SDK `ModelMessage[]` for adapted tool callbacks. */
export function toAiSdkModelMessages(messages: readonly AgentModelMessage[]): ModelMessage[] {
  const out: ModelMessage[] = [];
  for (const message of messages) {
    const providerOptions = toV4ProviderOptions(message.providerOptions);
    const opt = providerOptions ? { providerOptions } : {};
    if (message.role === 'system') {
      out.push({ role: 'system', content: message.content, ...opt });
    } else if (message.role === 'user') {
      out.push({
        role: 'user',
        content:
          typeof message.content === 'string'
            ? message.content
            : message.content.map(convertUserPart),
        ...opt,
      });
    } else if (message.role === 'assistant') {
      out.push({
        role: 'assistant',
        content:
          typeof message.content === 'string'
            ? message.content
            : convertAssistantParts(message.content),
        ...opt,
      });
    } else {
      out.push({ role: 'tool', content: convertToolParts(message.content, true), ...opt });
    }
  }
  return out;
}

export function toV4CallOptions(
  request: AgentModelRequest,
  signal: AbortSignal,
): V4CallOptions {
  const toolChoice: V4CallOptions['toolChoice'] =
    request.toolChoice === undefined
      ? undefined
      : typeof request.toolChoice === 'string'
        ? { type: request.toolChoice }
        : { type: 'tool', toolName: request.toolChoice.toolName };
  const responseFormat: V4CallOptions['responseFormat'] =
    request.responseFormat === undefined
      ? undefined
      : request.responseFormat.type === 'text'
        ? { type: 'text' }
        : request.responseFormat.type === 'json-object'
          ? { type: 'json' }
          : {
              type: 'json',
              name: request.responseFormat.name,
              schema: toV4JsonSchema(request.responseFormat.schema),
              ...(request.responseFormat.description !== undefined && {
                description: request.responseFormat.description,
              }),
            };
  const providerOptions = toV4ProviderOptions(request.providerOptions);
  const filteredHeaders = request.headers
    ? Object.fromEntries(
        Object.entries(request.headers).filter(([k]) => k.toLowerCase() !== 'content-type'),
      )
    : undefined;
  const { settings } = request;
  return {
    prompt: toV4Prompt(request),
    ...(request.tools.length > 0 && {
      tools: request.tools.map((spec) => {
        if (spec.type === 'provider') {
          throw new TypeError(
            `fromAiSdkModel: unsupported provider tool "${spec.id}" (type: "provider")`,
          );
        }
        const specOpts = toV4ProviderOptions(spec.providerOptions);
        return {
          type: 'function' as const,
          name: spec.name,
          ...(spec.description !== undefined && { description: spec.description }),
          inputSchema: toV4JsonSchema(spec.inputSchema),
          ...(spec.strict !== undefined && { strict: spec.strict }),
          ...(specOpts && { providerOptions: specOpts }),
        };
      }),
    }),
    ...(toolChoice !== undefined && { toolChoice }),
    ...(responseFormat !== undefined && { responseFormat }),
    ...(settings.maxOutputTokens !== undefined && {
      maxOutputTokens: settings.maxOutputTokens,
    }),
    ...(settings.temperature !== undefined && { temperature: settings.temperature }),
    ...(settings.topP !== undefined && { topP: settings.topP }),
    ...(settings.topK !== undefined && { topK: settings.topK }),
    ...(settings.presencePenalty !== undefined && {
      presencePenalty: settings.presencePenalty,
    }),
    ...(settings.frequencyPenalty !== undefined && {
      frequencyPenalty: settings.frequencyPenalty,
    }),
    ...(settings.seed !== undefined && { seed: settings.seed }),
    ...(settings.stopSequences !== undefined && {
      stopSequences: [...settings.stopSequences],
    }),
    ...(providerOptions && { providerOptions }),
    ...(filteredHeaders &&
      Object.keys(filteredHeaders).length > 0 && { headers: filteredHeaders }),
    abortSignal: signal,
  };
}

export function toAgentJsonValue(value: unknown): AgentModelJsonValue {
  if (
    value === null ||
    typeof value === 'string' ||
    typeof value === 'boolean' ||
    (typeof value === 'number' && Number.isFinite(value))
  ) {
    return value;
  }
  if (Array.isArray(value)) return value.map(toAgentJsonValue);
  if (isRecord(value)) {
    const nested: Record<string, AgentModelJsonValue> = {};
    for (const [k, v] of Object.entries(value)) {
      if (v !== undefined) nested[k] = toAgentJsonValue(v);
    }
    return nested;
  }
  return String(value);
}

export function toAgentProviderOptions(raw: unknown): AgentModelProviderOptions | undefined {
  if (!isRecord(raw)) return undefined;
  const out: Record<string, Record<string, AgentModelJsonValue>> = {};
  for (const [ns, entry] of Object.entries(raw)) {
    if (!isRecord(entry)) continue;
    const inner: Record<string, AgentModelJsonValue> = {};
    for (const [k, v] of Object.entries(entry)) {
      if (v !== undefined) inner[k] = toAgentJsonValue(v);
    }
    out[ns] = inner;
  }
  return Object.keys(out).length > 0 ? out : undefined;
}

export function normalizeProviderReference(raw: unknown): Record<string, string> | undefined {
  if (typeof raw === 'string' && raw.length > 0) return { default: raw };
  if (!isRecord(raw)) return undefined;
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(raw)) {
    if (k !== 'type' && typeof v === 'string') out[k] = v;
  }
  return Object.keys(out).length > 0 ? out : undefined;
}

function toOwnedBytes(bytes: Uint8Array): Uint8Array<ArrayBuffer> {
  const copy = new Uint8Array(bytes.byteLength);
  copy.set(bytes);
  return copy;
}

export function normalizeExternalFileData(raw: unknown): AgentModelFileData | undefined {
  if (raw instanceof Uint8Array) return { type: 'data', data: toOwnedBytes(raw) };
  if (raw instanceof ArrayBuffer) return { type: 'data', data: new Uint8Array(raw) };
  if (raw instanceof URL) return { type: 'url', url: raw };
  if (typeof raw === 'string') return { type: 'data', data: raw };
  if (!isRecord(raw)) return undefined;
  if (raw.type === 'data') {
    if (raw.data instanceof Uint8Array) return { type: 'data', data: toOwnedBytes(raw.data) };
    if (raw.data instanceof ArrayBuffer)
      return { type: 'data', data: new Uint8Array(raw.data) };
    if (typeof raw.data === 'string') return { type: 'data', data: raw.data };
    return undefined;
  }
  if (raw.type === 'url') {
    if (raw.url instanceof URL) {
      return {
        type: 'url',
        url: raw.url,
        ...(typeof raw.originalUrl === 'string' && { originalUrl: raw.originalUrl }),
      };
    }
    if (typeof raw.url === 'string') {
      return URL.canParse(raw.url)
        ? { type: 'url', url: new URL(raw.url), originalUrl: raw.url }
        : undefined;
    }
    return undefined;
  }
  if (raw.type === 'reference') {
    const reference = normalizeProviderReference(raw.reference);
    return reference ? { type: 'reference', reference } : undefined;
  }
  if (raw.type === 'text' && typeof raw.text === 'string') {
    return { type: 'text', text: raw.text };
  }
  const bareReference = normalizeProviderReference(raw);
  return bareReference ? { type: 'reference', reference: bareReference } : undefined;
}
