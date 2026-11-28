import type { AgentModelDriver, AgentModelDriverFactory } from './models-driver';
import { buildOpenAiRequestBody } from './openai-messages';
import {
  type OpenAiRequestPolicy,
  OpenAiRequestPolicySchema,
  resolveOpenAiPolicy,
} from './openai-options';
import { decodeOpenAiJsonResponse, parseOpenAiError } from './openai-response';
import { decodeOpenAiSseStream } from './openai-sse';
import {
  assertNoExtraBodyClash,
  joinProviderUrl,
  postProviderStream,
  resolveProviderApiKey,
} from './provider-http';

const DEFAULT_OPENAI_BASE_URL = 'https://api.openai.com/v1';

/** Wire keys owned by the OpenAI Responses protocol and `OpenAiRequestPolicy`. */
const OWNED_KEYS = [
  'model',
  'input',
  'instructions',
  'stream',
  'store',
  'reasoning',
  'include',
  'service_tier',
  'truncation',
  'prompt_cache_key',
  'prompt_cache_retention',
  'parallel_tool_calls',
  'tools',
  'tool_choice',
  'text',
  'max_output_tokens',
  'temperature',
  'top_p',
  'user',
] as const;

/** Transport configuration for the native OpenAI Responses model driver factory. */
export interface OpenAiProviderSettings {
  readonly apiKey: string | (() => string | Promise<string>);
  readonly baseUrl?: string;
  readonly organization?: string;
  readonly project?: string;
  readonly headers?: Readonly<Record<string, string>>;
  readonly fetch?: (input: string | URL | Request, init?: RequestInit) => Promise<Response>;
  readonly extraBody?: Readonly<Record<string, unknown>>;
}

/** Policy and prompt-caching preferences applied to every request of `openAiProvider`. */
export interface OpenAiProviderAccess {
  /** Default policy applied when `resolvePolicy` returns `undefined`. */
  readonly defaultPolicy?: OpenAiRequestPolicy;
  /** Per-model request policy resolved from the application's model table. */
  resolvePolicy?(modelId: string): OpenAiRequestPolicy | undefined;
  /**
   * Derive `prompt_cache_key` from `request.correlation.conversationId` (clamped/hashed to
   * ≤ 64 chars) whenever the resolved policy does not already specify `promptCacheKey`.
   */
  readonly cachePerConversation?: boolean;
}

function buildAuthHeaders(
  settings: OpenAiProviderSettings,
  apiKey: string,
): Record<string, string> {
  return {
    authorization: `Bearer ${apiKey}`,
    ...(settings.organization !== undefined && {
      'OpenAI-Organization': settings.organization,
    }),
    ...(settings.project !== undefined && { 'OpenAI-Project': settings.project }),
  };
}

/**
 * Native peer-free OpenAI Responses API (`POST /v1/responses`) driver factory over
 * Web `fetch` and SSE. Defaults to stateless (`store: false`) with automatic encrypted
 * reasoning round-trip and loose tool schemas (`strict: false`).
 */
export function openAiProvider(
  settings: OpenAiProviderSettings,
  access: OpenAiProviderAccess = {},
): AgentModelDriverFactory {
  assertNoExtraBodyClash('openAiProvider', settings.extraBody, OWNED_KEYS);
  const validatedDefaultPolicy =
    access.defaultPolicy !== undefined
      ? OpenAiRequestPolicySchema.parse(access.defaultPolicy)
      : undefined;

  const url = joinProviderUrl(settings.baseUrl ?? DEFAULT_OPENAI_BASE_URL, '/responses');
  const cachePerConversation = access.cachePerConversation === true;

  return {
    create(modelId: string): AgentModelDriver {
      return {
        provider: 'openai',
        modelId,
        async stream(request, signal) {
          const policy = resolveOpenAiPolicy(
            access.resolvePolicy?.(modelId) ?? validatedDefaultPolicy ?? {},
          );
          const body = buildOpenAiRequestBody({
            modelId,
            request,
            policy,
            cachePerConversation,
            ...(settings.extraBody !== undefined && { extraBody: settings.extraBody }),
          });
          const apiKey = await resolveProviderApiKey(settings.apiKey);
          const response = await postProviderStream({
            provider: 'openai',
            url,
            headers: buildAuthHeaders(settings, apiKey),
            ...(settings.headers !== undefined && { extraHeaders: settings.headers }),
            ...(request.headers !== undefined && { requestHeaders: request.headers }),
            body,
            signal,
            ...(settings.fetch !== undefined && { fetcher: settings.fetch }),
            parseError: parseOpenAiError,
          });
          if (response.kind === 'json') {
            return { parts: decodeOpenAiJsonResponse(response.json) };
          }
          return { parts: decodeOpenAiSseStream(response.body, signal) };
        },
      };
    },
  };
}
