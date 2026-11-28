import { buildAnthropicRequest } from './anthropic-messages';
import {
  ANTHROPIC_OWNED_BODY_KEYS,
  type AnthropicRequestPolicy,
  mergeAnthropicBetas,
  resolveAnthropicPolicy,
} from './anthropic-options';
import { decodeAnthropicJsonResponse, parseAnthropicError } from './anthropic-response';
import { decodeAnthropicSseStream } from './anthropic-sse';
import type { AgentModelDriver, AgentModelDriverFactory } from './models-driver';
import {
  assertNoExtraBodyClash,
  joinProviderUrl,
  parseHttpDateHeader,
  postProviderStream,
  resolveProviderApiKey,
} from './provider-http';

const DEFAULT_ANTHROPIC_BASE_URL = 'https://api.anthropic.com/v1';
const DEFAULT_ANTHROPIC_VERSION = '2023-06-01';

/** Configuration for the native Anthropic Messages model driver factory. */
export interface AnthropicProviderSettings {
  readonly apiKey: string | (() => string | Promise<string>);
  readonly baseUrl?: string;
  readonly apiVersion?: string;
  readonly betas?: readonly string[];
  readonly headers?: Readonly<Record<string, string>>;
  readonly fetch?: (input: string | URL | Request, init?: RequestInit) => Promise<Response>;
  readonly extraBody?: Readonly<Record<string, unknown>>;
}

/** Per-model request policy resolution for `anthropicProvider`. */
export interface AnthropicProviderAccess {
  /** Fallback policy when `resolvePolicy` returns `undefined`. */
  readonly defaultPolicy?: AnthropicRequestPolicy;
  /** Per-model policy resolver from the application's own model table. */
  resolvePolicy?(modelId: string): AnthropicRequestPolicy | undefined;
}

function splitHeaderBetas(headers: Readonly<Record<string, string>> | undefined): {
  readonly headerBetas: readonly string[];
  readonly extraHeaders?: Readonly<Record<string, string>>;
} {
  if (!headers) return { headerBetas: [] };
  const headerBetas: string[] = [];
  const remaining: Record<string, string> = {};
  for (const [key, value] of Object.entries(headers)) {
    if (key.toLowerCase() === 'anthropic-beta') {
      headerBetas.push(value);
    } else {
      remaining[key] = value;
    }
  }
  return {
    headerBetas,
    ...(Object.keys(remaining).length > 0 && { extraHeaders: remaining }),
  };
}

/**
 * Native peer-free Anthropic Messages driver factory over Web Fetch and SSE.
 *
 * Validates `extraBody` ownership and `defaultPolicy` up front; never retries,
 * executes tools, or mutates history.
 */
export function anthropicProvider(
  settings: AnthropicProviderSettings,
  access: AnthropicProviderAccess = {},
): AgentModelDriverFactory {
  assertNoExtraBodyClash('anthropicProvider', settings.extraBody, ANTHROPIC_OWNED_BODY_KEYS);
  const defaultPolicy =
    access.defaultPolicy !== undefined
      ? resolveAnthropicPolicy(access.defaultPolicy)
      : undefined;
  const endpoint = joinProviderUrl(
    settings.baseUrl ?? DEFAULT_ANTHROPIC_BASE_URL,
    '/messages',
  );
  const apiVersion = settings.apiVersion ?? DEFAULT_ANTHROPIC_VERSION;
  const { headerBetas, extraHeaders } = splitHeaderBetas(settings.headers);

  return {
    create(modelId: string): AgentModelDriver {
      return {
        provider: 'anthropic',
        modelId,
        async stream(request, signal) {
          const resolved = access.resolvePolicy?.(modelId);
          const basePolicy =
            resolved !== undefined ? resolveAnthropicPolicy(resolved) : (defaultPolicy ?? {});
          const built = buildAnthropicRequest({
            modelId,
            request,
            policy: basePolicy,
            ...(settings.extraBody !== undefined && { extraBody: settings.extraBody }),
          });
          const { headerBetas: requestBetas, extraHeaders: requestExtraHeaders } =
            splitHeaderBetas(request.headers);
          const betaHeader = mergeAnthropicBetas(
            headerBetas,
            requestBetas,
            settings.betas,
            built.policyBetas,
            built.autoBetas,
          );
          const apiKey = await resolveProviderApiKey(settings.apiKey);
          const headers: Record<string, string> = {
            'x-api-key': apiKey,
            'anthropic-version': apiVersion,
            ...(betaHeader !== undefined && { 'anthropic-beta': betaHeader }),
          };
          const response = await postProviderStream({
            provider: 'anthropic',
            url: endpoint,
            headers,
            ...(extraHeaders !== undefined && { extraHeaders }),
            ...(requestExtraHeaders !== undefined && { requestHeaders: requestExtraHeaders }),
            body: built.body,
            signal,
            ...(settings.fetch !== undefined && { fetcher: settings.fetch }),
            parseError: parseAnthropicError,
          });
          const responseTimestamp = parseHttpDateHeader(response.headers);
          if (response.kind === 'json') {
            return {
              ...(responseTimestamp !== undefined && {
                response: { timestamp: responseTimestamp },
              }),
              parts: decodeAnthropicJsonResponse(response.json, responseTimestamp),
            };
          }
          return {
            ...(responseTimestamp !== undefined && {
              response: { timestamp: responseTimestamp },
            }),
            parts: decodeAnthropicSseStream(response.body, signal, responseTimestamp),
          };
        },
      };
    },
  };
}
