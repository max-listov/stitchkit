import {
  createOpenRouter,
  type OpenRouterProviderSettings,
} from '@openrouter/ai-sdk-provider';
import type { LanguageModelUsage } from 'ai';
import type { AgentLanguageModelProvider } from './agent-runtime/models';
import type { AgentUsage } from './agent-runtime/schemas';
import { isRecord } from './internal/typed';

export type { OpenRouterProviderSettings } from '@openrouter/ai-sdk-provider';

/** Isolated OpenRouter adapter; credentials stay inside the provider instance. */
export function openRouterProvider(
  settings: OpenRouterProviderSettings,
): AgentLanguageModelProvider {
  const provider = createOpenRouter(settings);
  return {
    create: (modelId) => provider.chat(modelId),
    normalizeUsage: ({ usage, providerMetadata }) =>
      normalizeOpenRouterUsage(usage, providerMetadata),
  };
}

/** Same rule as `normalizeSdkUsage`: a non-integer is not a token count. */
function reported(value: number | undefined): AgentUsage['inputTokens'] {
  return value === undefined || !Number.isSafeInteger(value) || value < 0
    ? { provenance: 'unavailable' }
    : { value, provenance: 'provider-reported' };
}

function reportedUsd(value: number | undefined): AgentUsage['cost'] {
  return value === undefined
    ? { provenance: 'unavailable' }
    : { value, currency: 'USD', provenance: 'provider-reported' };
}

function readCost(metadata: unknown): number | undefined {
  if (!isRecord(metadata)) return undefined;
  const openrouter = metadata.openrouter;
  if (!isRecord(openrouter)) return undefined;
  if (typeof openrouter.cost === 'number' && openrouter.cost >= 0) return openrouter.cost;
  const usage = openrouter.usage;
  return isRecord(usage) && typeof usage.cost === 'number' && usage.cost >= 0
    ? usage.cost
    : undefined;
}

function normalizeOpenRouterUsage(
  usage: LanguageModelUsage,
  providerMetadata: unknown,
): AgentUsage {
  return {
    inputTokens: reported(usage.inputTokens),
    outputTokens: reported(usage.outputTokens),
    reasoningTokens: reported(usage.outputTokenDetails.reasoningTokens),
    cacheReadTokens: reported(usage.inputTokenDetails.cacheReadTokens),
    cacheWriteTokens: reported(usage.inputTokenDetails.cacheWriteTokens),
    cost: reportedUsd(readCost(providerMetadata)),
  };
}
