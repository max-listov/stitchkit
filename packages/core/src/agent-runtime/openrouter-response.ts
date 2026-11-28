import { isRecord } from '../internal/typed';
import type { AgentModelCostDetails } from './models-driver';
import type { AgentProviderFailureReason } from './provider-failure';
import { nonEmptyString, recordField, redactProviderFailureText } from './provider-http';
import type { OpenAiChatParsedError, OpenAiChatUsageResult } from './provider-openai-chat-sse';
import {
  buildProviderUsage,
  computedUsd,
  nonNegativeNumber,
  reportedInt,
  reportedUsd,
} from './provider-usage';
import type { AgentUsage } from './schemas';

const GENERIC_ERROR_MESSAGES = new Set([
  'OpenRouter request failed',
  'Provider returned error',
]);

const EMPTY_RAW_SENTINELS = new Set(['null', '[]', '{}', '""']);
const HTML_SNIPPET_PATTERN =
  /^\s*(?:<!doctype\s+html\b|<html\b|<head\b|<body\b|<title\b|<h1\b|<div\b|<p\b|<pre\b)/iu;

const MAX_RAW_SNIPPET_CHARS = 512;

function readMetadataUsageRecord(metadata: unknown): Record<string, unknown> | undefined {
  if (!isRecord(metadata)) return undefined;
  const openrouter = recordField(metadata, 'openrouter') ?? metadata;
  return recordField(openrouter, 'usage') ?? openrouter;
}

function readOpenRouterBaseCost(
  source: Record<string, unknown>,
  metadata: unknown,
): number | undefined {
  const direct = nonNegativeNumber(source.cost);
  if (direct !== undefined) return direct;
  if (!isRecord(metadata)) return undefined;
  const openrouter = recordField(metadata, 'openrouter') ?? metadata;
  const top = nonNegativeNumber(openrouter.cost);
  if (top !== undefined) return top;
  const nestedUsage = recordField(openrouter, 'usage');
  return nestedUsage ? nonNegativeNumber(nestedUsage.cost) : undefined;
}

function readBooleanField(
  record: Record<string, unknown> | undefined,
  key: string,
): boolean | undefined {
  return typeof record?.[key] === 'boolean' ? record[key] : undefined;
}

/**
 * Normalize OpenRouter's wire `usage` object into provenance-aware `AgentUsage`
 * plus optional `costDetails` (prompt/output sub-costs and BYOK flag).
 *
 * When `is_byok === true`, total cost is computed (`provenance: 'computed'`) as
 * `cost + cost_details.upstream_inference_cost` (or `prompt_cost + completions_cost`).
 * Absent or non-integer counters remain `unavailable` and are never zeroed. → ADR 0109, ADR 0336.
 */
export function normalizeOpenRouterUsageDetails(
  usage: unknown,
  metadata?: unknown,
): OpenAiChatUsageResult {
  const source = isRecord(usage) ? (recordField(usage, 'raw') ?? usage) : {};
  const metaUsage = readMetadataUsageRecord(metadata);
  const prompt = recordField(source, 'prompt_tokens_details') ?? {};
  const completion = recordField(source, 'completion_tokens_details') ?? {};
  const rawCostDetails =
    recordField(source, 'cost_details') ??
    (metaUsage ? recordField(metaUsage, 'cost_details') : undefined);

  const isByok = readBooleanField(source, 'is_byok') ?? readBooleanField(metaUsage, 'is_byok');
  const promptCostUsd =
    nonNegativeNumber(rawCostDetails?.upstream_inference_prompt_cost) ??
    nonNegativeNumber(rawCostDetails?.prompt_cost);
  const outputCostUsd =
    nonNegativeNumber(rawCostDetails?.upstream_inference_completions_cost) ??
    nonNegativeNumber(rawCostDetails?.completions_cost) ??
    nonNegativeNumber(rawCostDetails?.completion_cost);
  const upstreamInferenceCost = nonNegativeNumber(rawCostDetails?.upstream_inference_cost);
  const baseCost = readOpenRouterBaseCost(source, metadata);

  let cost: NonNullable<AgentUsage['cost']>;
  if (isByok === true) {
    const upstreamCost =
      upstreamInferenceCost ??
      (promptCostUsd !== undefined || outputCostUsd !== undefined
        ? (promptCostUsd ?? 0) + (outputCostUsd ?? 0)
        : undefined);
    cost =
      upstreamCost !== undefined
        ? computedUsd((baseCost ?? 0) + upstreamCost)
        : reportedUsd(baseCost);
  } else {
    cost = reportedUsd(baseCost);
  }

  const normalizedUsage = buildProviderUsage({
    inputTokens: reportedInt(source.prompt_tokens),
    outputTokens: reportedInt(source.completion_tokens),
    reasoningTokens: reportedInt(completion.reasoning_tokens),
    cacheReadTokens: reportedInt(prompt.cached_tokens),
    cacheWriteTokens: reportedInt(prompt.cache_write_tokens),
    cost,
  });

  const costDetails: AgentModelCostDetails | undefined =
    promptCostUsd !== undefined || outputCostUsd !== undefined || isByok !== undefined
      ? {
          ...(promptCostUsd !== undefined && { promptCostUsd }),
          ...(outputCostUsd !== undefined && { outputCostUsd }),
          ...(isByok !== undefined && { isByok }),
        }
      : undefined;

  return {
    usage: normalizedUsage,
    ...(costDetails !== undefined && { costDetails }),
  };
}

/**
 * Read OpenRouter's token counts and cost out of one wire usage object (or `{ raw }` wrapper),
 * with per-field provenance. Absent counters stay `unavailable`, never zero.
 */
export function normalizeOpenRouterUsage(
  usage: unknown,
  providerMetadata?: unknown,
): AgentUsage {
  return normalizeOpenRouterUsageDetails(usage, providerMetadata).usage;
}

function readHttpStatusNumber(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isInteger(value) && value >= 400 && value < 600
    ? value
    : undefined;
}

function readCodeValue(value: unknown): string | number | undefined {
  return typeof value === 'string' && value.length > 0
    ? value
    : typeof value === 'number' && Number.isFinite(value)
      ? value
      : undefined;
}

interface ExtractedError {
  readonly message?: string;
  readonly code?: string | number;
  readonly errorType?: string;
  readonly statusCode?: number;
  readonly providerName?: string;
  readonly limitSource?: string;
  readonly reason?: string;
  readonly upstreamCode?: string | number;
  readonly upstreamStatus?: number;
}

function extractNestedError(payload: unknown, depth: number): ExtractedError {
  if (depth > 4 || !isRecord(payload)) return {};
  const err = recordField(payload, 'error') ?? payload;
  const outerMessage = nonEmptyString(err.message);
  const outerCode = readCodeValue(err.code);
  const outerType = nonEmptyString(err.type) ?? nonEmptyString(err.status);
  const outerStatus = readHttpStatusNumber(err.code) ?? readHttpStatusNumber(err.status);
  const meta = recordField(err, 'metadata');
  const providerName = nonEmptyString(meta?.provider_name);
  const limitSource = nonEmptyString(meta?.limit_source);
  const reason = nonEmptyString(meta?.reason);
  const rawMeta = meta?.raw;

  let nested: ExtractedError = {};
  let rawFallback: string | undefined;
  let rawIsHtml = false;
  if (typeof rawMeta === 'string' && rawMeta.trim().length > 0) {
    const trimmed = rawMeta.trim();
    if (!EMPTY_RAW_SENTINELS.has(trimmed)) {
      try {
        const parsedRaw: unknown = JSON.parse(trimmed);
        if (isRecord(parsedRaw)) nested = extractNestedError(parsedRaw, depth + 1);
        else rawFallback = redactProviderFailureText(trimmed, MAX_RAW_SNIPPET_CHARS);
      } catch {
        rawIsHtml = HTML_SNIPPET_PATTERN.test(trimmed);
        rawFallback = redactProviderFailureText(trimmed, MAX_RAW_SNIPPET_CHARS);
      }
    }
  } else if (isRecord(rawMeta)) {
    nested = extractNestedError(rawMeta, depth + 1);
  }

  const nestedMessage =
    nested.message && !GENERIC_ERROR_MESSAGES.has(nested.message) ? nested.message : undefined;
  const meaningfulOuter =
    outerMessage && !GENERIC_ERROR_MESSAGES.has(outerMessage) ? outerMessage : undefined;
  const message =
    nestedMessage ??
    (rawIsHtml && meaningfulOuter !== undefined ? meaningfulOuter : rawFallback) ??
    outerMessage;
  const code =
    typeof nested.code === 'string'
      ? nested.code
      : outerCode !== undefined
        ? outerCode
        : nested.code;
  const errorType = nested.errorType ?? outerType;
  const statusCode = outerStatus ?? nested.statusCode;

  return {
    ...(message !== undefined && { message }),
    ...(code !== undefined && { code }),
    ...(errorType !== undefined && { errorType }),
    ...(statusCode !== undefined && { statusCode }),
    ...((providerName ?? nested.providerName) !== undefined && {
      providerName: providerName ?? nested.providerName,
    }),
    ...((limitSource ?? nested.limitSource) !== undefined && {
      limitSource: limitSource ?? nested.limitSource,
    }),
    ...((reason ?? nested.reason) !== undefined && {
      reason: reason ?? nested.reason,
    }),
    ...(nested.code !== undefined && { upstreamCode: nested.code }),
    ...(nested.statusCode !== undefined && { upstreamStatus: nested.statusCode }),
  };
}

/**
 * Parse an OpenRouter HTTP or mid-stream JSON error envelope (or raw text/HTML error body),
 * unwrapping nested `metadata.raw` strings or objects and redacting secrets/HTML snippets.
 */
export function parseOpenRouterError(
  payload: unknown,
  rawText = '',
  status?: number,
): OpenAiChatParsedError {
  const extracted = extractNestedError(payload, 0);
  const trimmedRaw = rawText.trim();
  const baseMessage =
    extracted.message ??
    (trimmedRaw.length > 0
      ? status !== undefined
        ? `OpenRouter HTTP ${status}: ${redactProviderFailureText(trimmedRaw, MAX_RAW_SNIPPET_CHARS)}`
        : redactProviderFailureText(trimmedRaw, MAX_RAW_SNIPPET_CHARS)
      : status !== undefined
        ? `OpenRouter HTTP ${status}`
        : 'OpenRouter request failed');
  const prefixed =
    extracted.providerName && !baseMessage.startsWith(`[${extracted.providerName}] `)
      ? `[${extracted.providerName}] ${baseMessage}`
      : baseMessage;
  const message = redactProviderFailureText(prefixed);

  const errorMeta: Record<string, unknown> = {};
  if (extracted.providerName !== undefined) errorMeta.provider_name = extracted.providerName;
  if (extracted.limitSource !== undefined) errorMeta.limit_source = extracted.limitSource;
  if (extracted.reason !== undefined) errorMeta.reason = extracted.reason;
  if (extracted.upstreamCode !== undefined) errorMeta.upstream_code = extracted.upstreamCode;
  if (extracted.upstreamStatus !== undefined)
    errorMeta.upstream_status = extracted.upstreamStatus;

  const statusCode =
    extracted.statusCode ?? (status !== undefined && status >= 400 ? status : undefined);
  const failureReason: AgentProviderFailureReason | undefined =
    statusCode === 402 && extracted.limitSource === 'openrouter_in_flight_budget'
      ? 'overloaded'
      : undefined;

  return {
    message,
    ...(extracted.code !== undefined && { code: extracted.code }),
    ...(extracted.errorType !== undefined && { errorType: extracted.errorType }),
    ...(statusCode !== undefined && { statusCode }),
    ...(failureReason !== undefined && { failureReason }),
    ...(Object.keys(errorMeta).length > 0 && { metadata: errorMeta }),
  };
}
