import type {
  AgentModelAssistantMessage,
  AgentModelFileData,
  AgentModelMessage,
  AgentModelProviderOptions,
  AgentModelResponseFormat,
  AgentToolModelOutput,
} from '../agent-parts/model';
import { isRecord } from '../internal/typed';
import type {
  AgentModelRequest,
  AgentModelToolChoice,
  AgentModelToolSpec,
} from './models-driver';
import {
  assertOpenAiSupportedSettings,
  deriveOpenAiPromptCacheKey,
  mergeOpenAiStepPolicy,
  type ResolvedOpenAiPolicy,
  resolveOpenAiIncludeList,
} from './openai-options';
import { normalizeProviderHistory } from './provider-history';
import { nonEmptyString } from './provider-http';
import { normalizeOpenAiJsonSchema } from './provider-json-schema';
import {
  deterministicJson,
  fallbackFilenameForMediaType,
  normalizeMime,
  resolveFilePayload,
  sanitizeSurrogates,
} from './provider-media';

const RESPONSE_FORMAT_NAME_PATTERN = /^[a-zA-Z0-9_-]{1,64}$/u;

function readOpenAiNamespace(
  options: AgentModelProviderOptions | undefined,
): Record<string, unknown> | undefined {
  return options && isRecord(options.openai) ? options.openai : undefined;
}

function readImageDetail(
  providerOptions: AgentModelProviderOptions | undefined,
): 'low' | 'high' | 'auto' | undefined {
  const oa = readOpenAiNamespace(providerOptions);
  const raw = oa?.imageDetail ?? oa?.detail;
  return raw === 'low' || raw === 'high' || raw === 'auto' ? raw : undefined;
}

function encodeMediaPart(
  data: AgentModelFileData,
  mediaType: string,
  filename: string | undefined,
  providerOptions: AgentModelProviderOptions | undefined,
): Record<string, unknown> {
  const payload = resolveFilePayload(data, mediaType);
  if (payload.kind === 'text') {
    return { type: 'input_text', text: payload.text };
  }
  const resolvedMediaType = normalizeMime(
    payload.kind === 'base64' ? payload.mediaType : mediaType,
  );
  if (resolvedMediaType.startsWith('image/')) {
    const detail = readImageDetail(providerOptions);
    if (payload.kind === 'reference') {
      const fileId = nonEmptyString(payload.reference.openai);
      if (fileId === undefined) {
        throw new TypeError(
          'openai: image file reference does not provide an "openai" file_id',
        );
      }
      return {
        type: 'input_image',
        file_id: fileId,
        ...(detail !== undefined && { detail }),
      };
    }
    const imageUrl =
      payload.kind === 'url'
        ? payload.url
        : `data:${resolvedMediaType};base64,${payload.base64}`;
    return {
      type: 'input_image',
      image_url: imageUrl,
      ...(detail !== undefined && { detail }),
    };
  }
  if (payload.kind === 'reference') {
    const fileId = nonEmptyString(payload.reference.openai);
    if (fileId === undefined) {
      throw new TypeError('openai: file reference does not provide an "openai" file_id');
    }
    return { type: 'input_file', file_id: fileId };
  }
  if (payload.kind === 'url') {
    return { type: 'input_file', file_url: payload.url };
  }
  const resolvedName = sanitizeSurrogates(
    filename ?? fallbackFilenameForMediaType(resolvedMediaType),
  );
  return {
    type: 'input_file',
    filename: resolvedName,
    file_data: `data:${resolvedMediaType};base64,${payload.base64}`,
  };
}

function encodeToolOutput(output: AgentToolModelOutput): string | Record<string, unknown>[] {
  switch (output.type) {
    case 'text':
    case 'error-text':
      return output.value;
    case 'json':
    case 'error-json':
      return deterministicJson(output.value);
    case 'execution-denied':
      return output.reason ?? 'Tool execution denied';
    case 'content':
      return output.value.map((part) => {
        if (part.type === 'text') return { type: 'input_text', text: part.text };
        if (part.type === 'file') {
          return encodeMediaPart(
            part.data,
            part.mediaType,
            part.filename,
            part.providerOptions,
          );
        }
        return { type: 'input_text', text: deterministicJson(part) };
      });
  }
}

function encodeOpenAiReasoningItem(
  text: string,
  providerOptions: AgentModelProviderOptions | undefined,
  store: boolean,
): Record<string, unknown> | undefined {
  const oa = readOpenAiNamespace(providerOptions);
  if (!oa) return undefined;
  const id = nonEmptyString(oa.id);
  const encryptedContent = nonEmptyString(oa.encrypted_content);
  if (!store && encryptedContent === undefined) {
    return undefined;
  }
  const hasExplicitSummary = Array.isArray(oa.summary);
  const summary: Array<{ type: 'summary_text'; text: string }> = [];
  if (Array.isArray(oa.summary)) {
    for (const entry of oa.summary) {
      if (isRecord(entry) && typeof entry.text === 'string') {
        summary.push({ type: 'summary_text', text: sanitizeSurrogates(entry.text) });
      } else if (typeof entry === 'string') {
        summary.push({ type: 'summary_text', text: sanitizeSurrogates(entry) });
      }
    }
  } else if (text.length > 0) {
    summary.push({ type: 'summary_text', text });
  }
  if (
    encryptedContent === undefined &&
    (id === undefined || (!hasExplicitSummary && summary.length === 0))
  ) {
    return undefined;
  }
  return {
    type: 'reasoning',
    ...(id !== undefined && { id }),
    summary,
    ...(encryptedContent !== undefined && { encrypted_content: encryptedContent }),
  };
}

function encodeAssistantMessage(
  message: AgentModelAssistantMessage,
  store: boolean,
): { readonly items: Record<string, unknown>[]; readonly sawOpenAiReasoning: boolean } {
  const items: Record<string, unknown>[] = [];
  let sawOpenAiReasoning = false;
  const messagePhase = nonEmptyString(readOpenAiNamespace(message.providerOptions)?.phase);

  if (typeof message.content === 'string') {
    if (message.content.length > 0) {
      items.push({
        role: 'assistant',
        content: [{ type: 'output_text', text: message.content }],
        ...(messagePhase !== undefined && { phase: messagePhase }),
      });
    }
    return { items, sawOpenAiReasoning };
  }

  let pendingText: Array<{ type: 'output_text'; text: string }> = [];
  let pendingPhase: string | undefined;

  const flushText = (): void => {
    if (pendingText.length === 0) return;
    items.push({
      role: 'assistant',
      content: pendingText,
      ...(pendingPhase !== undefined && { phase: pendingPhase }),
    });
    pendingText = [];
    pendingPhase = undefined;
  };

  for (const part of message.content) {
    if (part.type === 'text') {
      if (part.text.length === 0) continue;
      const partPhase =
        nonEmptyString(readOpenAiNamespace(part.providerOptions)?.phase) ?? messagePhase;
      if (pendingText.length > 0 && pendingPhase !== partPhase) flushText();
      pendingPhase = partPhase;
      pendingText.push({ type: 'output_text', text: part.text });
      continue;
    }
    if (part.type === 'reasoning') {
      flushText();
      const encoded = encodeOpenAiReasoningItem(part.text, part.providerOptions, store);
      if (encoded !== undefined) {
        sawOpenAiReasoning = true;
        items.push(encoded);
      }
      continue;
    }
    if (part.type === 'tool-call' && part.providerExecuted !== true) {
      flushText();
      const itemId = nonEmptyString(readOpenAiNamespace(part.providerOptions)?.itemId);
      items.push({
        type: 'function_call',
        call_id: part.toolCallId,
        name: part.toolName,
        arguments: deterministicJson(part.input),
        ...(store === true &&
          itemId !== undefined &&
          itemId.startsWith('fc_') && { id: itemId }),
      });
    }
  }
  flushText();
  return { items, sawOpenAiReasoning };
}

function encodeMessages(
  request: AgentModelRequest,
  messages: readonly AgentModelMessage[],
  store: boolean,
): { readonly input: Record<string, unknown>[]; readonly sawOpenAiReasoning: boolean } {
  const input: Record<string, unknown>[] = [];
  let sawOpenAiReasoning = false;

  for (const sys of request.instructions) {
    const clean = sanitizeSurrogates(sys.content);
    if (clean.length > 0) input.push({ role: 'developer', content: clean });
  }

  for (const message of messages) {
    if (message.role === 'system') {
      input.push({ role: 'developer', content: message.content });
      continue;
    }
    if (message.role === 'user') {
      const content =
        typeof message.content === 'string'
          ? [{ type: 'input_text', text: message.content }]
          : message.content.map((part) =>
              part.type === 'text'
                ? { type: 'input_text', text: part.text }
                : encodeMediaPart(
                    part.data,
                    part.mediaType,
                    part.filename,
                    part.providerOptions,
                  ),
            );
      input.push({ role: 'user', content });
      continue;
    }
    if (message.role === 'assistant') {
      const encoded = encodeAssistantMessage(message, store);
      if (encoded.sawOpenAiReasoning) sawOpenAiReasoning = true;
      input.push(...encoded.items);
      continue;
    }
    for (const part of message.content) {
      if (part.type !== 'tool-result') continue;
      input.push({
        type: 'function_call_output',
        call_id: part.toolCallId,
        output: encodeToolOutput(part.output),
      });
    }
  }

  return { input, sawOpenAiReasoning };
}

function encodeTools(
  tools: readonly AgentModelToolSpec[],
  defaultStrict: boolean,
): Record<string, unknown>[] | undefined {
  if (tools.length === 0) return undefined;
  return tools.map((spec) => {
    if (spec.type === 'provider') {
      throw new TypeError(`openai: unsupported provider tool "${spec.id}" (type: "provider")`);
    }
    const strict = spec.strict ?? defaultStrict;
    return {
      type: 'function',
      name: spec.name,
      ...(spec.description !== undefined && {
        description: sanitizeSurrogates(spec.description),
      }),
      parameters: normalizeOpenAiJsonSchema(spec.inputSchema, strict),
      strict,
    };
  });
}

function encodeToolChoice(
  toolChoice: AgentModelToolChoice | undefined,
): string | Record<string, unknown> | undefined {
  if (toolChoice === undefined) return undefined;
  return typeof toolChoice === 'string'
    ? toolChoice
    : { type: 'function', name: toolChoice.toolName };
}

function encodeResponseFormat(
  format: AgentModelResponseFormat | undefined,
): Record<string, unknown> | undefined {
  if (format === undefined) return undefined;
  if (format.type === 'text') return { format: { type: 'text' } };
  if (format.type === 'json-object') return { format: { type: 'json_object' } };
  if (!RESPONSE_FORMAT_NAME_PATTERN.test(format.name)) {
    throw new TypeError(
      `openai: responseFormat.name "${format.name}" must match /^[a-zA-Z0-9_-]{1,64}$/`,
    );
  }
  const strict = format.strict ?? true;
  return {
    format: {
      type: 'json_schema',
      name: format.name,
      ...(format.description !== undefined && {
        description: sanitizeSurrogates(format.description),
      }),
      schema: normalizeOpenAiJsonSchema(format.schema, strict),
      strict,
    },
  };
}

/** Build one OpenAI Responses API (`POST /v1/responses`) JSON request body. */
export function buildOpenAiRequestBody(input: {
  readonly modelId: string;
  readonly request: AgentModelRequest;
  readonly policy: ResolvedOpenAiPolicy;
  readonly cachePerConversation: boolean;
  readonly extraBody?: Readonly<Record<string, unknown>>;
}): Record<string, unknown> {
  const { modelId, request, cachePerConversation, extraBody } = input;
  const policy = mergeOpenAiStepPolicy(input.policy, request.providerOptions);
  assertOpenAiSupportedSettings(request.settings, policy);

  const normalizedMessages = normalizeProviderHistory(request.messages);
  const { input: wireInput, sawOpenAiReasoning } = encodeMessages(
    request,
    normalizedMessages,
    policy.store,
  );
  const tools = encodeTools(request.tools, policy.strictTools);
  const toolChoice = tools !== undefined ? encodeToolChoice(request.toolChoice) : undefined;
  const text = encodeResponseFormat(request.responseFormat);
  const include = resolveOpenAiIncludeList(policy, modelId, sawOpenAiReasoning);
  const promptCacheKey =
    policy.promptCacheKey ??
    (cachePerConversation
      ? deriveOpenAiPromptCacheKey(request.correlation.conversationId)
      : undefined);

  return {
    ...(extraBody ?? {}),
    model: modelId,
    stream: true,
    store: policy.store,
    input: wireInput,
    ...(tools !== undefined && { tools }),
    ...(toolChoice !== undefined && { tool_choice: toolChoice }),
    ...(text !== undefined && { text }),
    ...(policy.reasoning !== undefined && {
      reasoning: {
        effort: policy.reasoning.effort,
        ...(policy.reasoning.summary !== undefined && { summary: policy.reasoning.summary }),
      },
    }),
    ...(include.length > 0 && { include }),
    ...(policy.serviceTier !== undefined && { service_tier: policy.serviceTier }),
    ...(policy.truncation !== undefined && { truncation: policy.truncation }),
    ...(promptCacheKey !== undefined && { prompt_cache_key: promptCacheKey }),
    ...(policy.promptCacheRetention !== undefined && {
      prompt_cache_retention: policy.promptCacheRetention,
    }),
    ...(policy.parallelToolCalls !== undefined && {
      parallel_tool_calls: policy.parallelToolCalls,
    }),
    ...(policy.user !== undefined && { user: policy.user }),
    ...(request.settings.maxOutputTokens !== undefined && {
      max_output_tokens: request.settings.maxOutputTokens,
    }),
    ...(request.settings.temperature !== undefined && {
      temperature: request.settings.temperature,
    }),
    ...(request.settings.topP !== undefined && { top_p: request.settings.topP }),
  };
}
