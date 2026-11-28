/**
 * What a provider refusal was, as a fact rather than as a sentence.
 *
 * **This classifies; it does not phrase.** The sentence a user reads belongs to
 * the application — its tone, its language, its decision about what to admit —
 * and a core that invents one would be writing product copy. What the core owes
 * is the distinction, because the core is where the provider's answer arrives.
 *
 * Not a domain model (→ ADR 0002): "the provider said 402" is a fact about the
 * provider, not about anyone's business.
 */

import { messageOf } from '../internal/error-message';
import { isRecord } from '../internal/typed';

/**
 * Why a provider call did not produce an answer.
 *
 * Deliberately small. Each member exists because it implies a *different* next
 * action — top up, wait, choose another model, shorten the input, retry — and a
 * distinction that implies the same action as its neighbour is not worth a name.
 */
export type AgentProviderFailureReason =
  | 'insufficient-credits'
  | 'rate-limited'
  | 'overloaded'
  | 'server-error'
  | 'model-unavailable'
  | 'context-overflow'
  | 'timeout'
  | 'cancelled'
  | 'stream-cut'
  | 'unknown';

export interface AgentProviderFailure {
  reason: AgentProviderFailureReason;
  /** The transport status, when the provider supplied one. */
  status?: number;
  /** Server-indicated retry delay in ms (from `Retry-After` or `retry-after-ms`), when present. */
  retryAfterMs?: number;
  /**
   * Whether the same request could plausibly succeed later **without changing
   * it**. Waiting out a rate limit is retryable; a context overflow is not,
   * because retrying an unchanged oversized request fails identically.
   */
  retryable: boolean;
  /**
   * How the reason was reached. A machine code or status code is the provider
   * stating its own answer; a message match is us reading its prose, which
   * changes without notice and across providers.
   */
  evidence: 'code' | 'status' | 'message' | 'none';
}

export interface AgentProviderErrorDetails {
  readonly provider: string;
  readonly statusCode?: number;
  readonly code?: string | number;
  readonly errorType?: string;
  readonly requestId?: string;
  readonly retryAfterMs?: number;
  readonly responseHeaders?: Readonly<Record<string, string>>;
  readonly responseBody?: string;
  readonly metadata?: Readonly<Record<string, unknown>>;
  readonly failureReason?: AgentProviderFailureReason;
  readonly cause?: unknown;
}

const EXPLICIT_FAILURE_REASON = new WeakSet<AgentProviderError>();

/**
 * Canonical transport or mid-stream provider error raised by every native driver
 * (`openrouter`, `openai`, `anthropic`). → ADR 0336.
 */
export class AgentProviderError extends Error {
  readonly provider: string;
  readonly statusCode?: number;
  readonly code?: string | number;
  readonly errorType?: string;
  readonly requestId?: string;
  readonly retryAfterMs?: number;
  readonly responseHeaders?: Readonly<Record<string, string>>;
  readonly responseBody?: string;
  readonly metadata?: Readonly<Record<string, unknown>>;
  readonly failureReason: AgentProviderFailureReason;

  constructor(message: string, details: AgentProviderErrorDetails) {
    super(message, details.cause !== undefined ? { cause: details.cause } : undefined);
    this.name = 'AgentProviderError';
    this.provider = details.provider;
    if (details.statusCode !== undefined) this.statusCode = details.statusCode;
    if (details.code !== undefined) this.code = details.code;
    if (details.errorType !== undefined) this.errorType = details.errorType;
    if (details.requestId !== undefined) this.requestId = details.requestId;
    if (details.retryAfterMs !== undefined) this.retryAfterMs = details.retryAfterMs;
    if (details.responseHeaders !== undefined) this.responseHeaders = details.responseHeaders;
    if (details.responseBody !== undefined) this.responseBody = details.responseBody;
    if (details.metadata !== undefined) this.metadata = details.metadata;
    if (details.failureReason !== undefined) {
      EXPLICIT_FAILURE_REASON.add(this);
      this.failureReason = details.failureReason;
    } else {
      this.failureReason = 'unknown';
      this.failureReason = classifyProviderFailure(this).reason;
    }
  }
}

/** Constructor options for `AgentProviderStreamCutError`. */
export interface AgentProviderStreamCutErrorOptions extends ErrorOptions {
  readonly provider?: string;
}

export class AgentProviderStreamCutError extends AgentProviderError {
  readonly reason = 'stream-cut' as const;

  constructor(
    message = 'Provider stream ended before a terminal part',
    options?: AgentProviderStreamCutErrorOptions,
  ) {
    super(message, {
      provider: options?.provider ?? 'unknown',
      failureReason: 'stream-cut',
      ...(options?.cause !== undefined && { cause: options.cause }),
    });
    this.name = 'AgentProviderStreamCutError';
  }
}

/** Runtime type guard for `AgentProviderError` (including `AgentProviderStreamCutError`). */
export function isAgentProviderError(error: unknown): error is AgentProviderError {
  return error instanceof AgentProviderError;
}

const BY_STRUCTURED_CODE: ReadonlyMap<string, AgentProviderFailureReason> = new Map([
  ['insufficient_quota', 'insufficient-credits'],
  ['billing_hard_limit_reached', 'insufficient-credits'],
  ['context_length_exceeded', 'context-overflow'],
  ['model_context_window_exceeded', 'context-overflow'],
  ['request_too_large', 'context-overflow'],
  ['overloaded_error', 'overloaded'],
  ['rate_limit_error', 'rate-limited'],
  ['rate_limit_exceeded', 'rate-limited'],
  ['api_error', 'server-error'],
  ['server_error', 'server-error'],
  ['internal_server_error', 'server-error'],
  ['service_unavailable', 'server-error'],
  ['model_not_found', 'model-unavailable'],
]);

const BY_STATUS: ReadonlyMap<number, AgentProviderFailureReason> = new Map([
  [402, 'insufficient-credits'],
  [404, 'model-unavailable'],
  [408, 'timeout'],
  [413, 'context-overflow'],
  [429, 'rate-limited'],
  [500, 'server-error'],
  [502, 'server-error'],
  [503, 'server-error'],
  [504, 'timeout'],
  [529, 'overloaded'],
]);

/** Phrases that look like context-overflow at a glance but are actually rate/param limits. */
const OVERFLOW_EXCLUSIONS: readonly RegExp[] = [
  /too many tokens, please wait/i,
  /tokens per min/i,
  /max_tokens.*must be|max_output_tokens.*must be/i,
];

const BY_MESSAGE: readonly (readonly [RegExp, AgentProviderFailureReason])[] = [
  [
    /credit balance is too low|insufficient[_ ](?:credits?|funds|balance|quota)|not enough credit|payment required|quota exceeded|add more credits|requires more credits/i,
    'insufficient-credits',
  ],
  [/overloaded|capacity exceeded/i, 'overloaded'],
  [/rate.?limit|too many requests|slow down/i, 'rate-limited'],
  [
    /no endpoints found|model not found|unknown model|no allowed providers|not a valid model|model\b[^\n]*?\bdoes not exist/i,
    'model-unavailable',
  ],
  [
    /context length|maximum context|exceeds the context window|context_length_exceeded|too many tokens|prompt is too long|input is too long|request too large/i,
    'context-overflow',
  ],
  [/timed? ?out|deadline exceeded|etimedout/i, 'timeout'],
  [
    /econnreset|und_err_socket|socket closed|connection reset|premature close|fetch failed/i,
    'stream-cut',
  ],
  [/bad gateway|service unavailable|internal server error/i, 'server-error'],
  [/abort|cancell?ed/i, 'cancelled'],
];

/** Retrying the same request unchanged could plausibly work. */
const RETRYABLE: ReadonlySet<AgentProviderFailureReason> = new Set([
  'rate-limited',
  'overloaded',
  'server-error',
  'timeout',
  'stream-cut',
]);

function statusOf(value: unknown, depth = 0): number | undefined {
  if (depth > 5 || !isRecord(value)) return undefined;
  for (const key of ['statusCode', 'status', 'code']) {
    const candidate = value[key];
    if (typeof candidate === 'number' && candidate >= 400 && candidate < 600) return candidate;
  }
  for (const nested of [value.cause, value.response, value.error]) {
    if (nested !== undefined && nested !== value) {
      const found = statusOf(nested, depth + 1);
      if (found !== undefined) return found;
    }
  }
  return undefined;
}

function structuredReasonOf(
  value: unknown,
  depth = 0,
): AgentProviderFailureReason | undefined {
  if (depth > 5 || !isRecord(value)) return undefined;
  if (value instanceof AgentProviderError && EXPLICIT_FAILURE_REASON.has(value)) {
    return value.failureReason;
  }
  for (const key of ['errorType', 'type', 'code']) {
    const candidate = value[key];
    if (typeof candidate === 'string') {
      const mapped = BY_STRUCTURED_CODE.get(candidate.toLowerCase());
      if (mapped !== undefined) return mapped;
    }
  }
  for (const nested of [value.cause, value.response, value.error]) {
    if (nested !== undefined && nested !== value) {
      const found = structuredReasonOf(nested, depth + 1);
      if (found !== undefined) return found;
    }
  }
  return undefined;
}

function retryAfterOf(value: unknown, depth = 0): number | undefined {
  if (depth > 5 || !isRecord(value)) return undefined;
  if (
    typeof value.retryAfterMs === 'number' &&
    Number.isFinite(value.retryAfterMs) &&
    value.retryAfterMs >= 0
  ) {
    return value.retryAfterMs;
  }
  for (const nested of [value.cause, value.response, value.error]) {
    if (nested !== undefined && nested !== value) {
      const found = retryAfterOf(nested, depth + 1);
      if (found !== undefined) return found;
    }
  }
  return undefined;
}

function fullMessageOf(value: unknown, depth = 0): string {
  const base = messageOf(value);
  if (depth > 4 || !isRecord(value) || value.cause === undefined || value.cause === value) {
    return base;
  }
  const causeMsg = fullMessageOf(value.cause, depth + 1);
  return causeMsg && !base.includes(causeMsg) ? `${base}: ${causeMsg}` : base;
}

/**
 * Classify one thrown provider value.
 *
 * Priority: `AgentProviderStreamCutError` → structured machine code (`evidence: 'code'`) →
 * HTTP status (`evidence: 'status'`) → prose with exclusions (`evidence: 'message'`) →
 * `'unknown'` (`retryable: false`, `evidence: 'none'`).
 */
export function classifyProviderFailure(error: unknown): AgentProviderFailure {
  if (error instanceof AgentProviderStreamCutError) {
    return { reason: 'stream-cut', retryable: true, evidence: 'code' };
  }
  const status = statusOf(error);
  const retryAfterMs = retryAfterOf(error);
  const byCode = structuredReasonOf(error);
  if (byCode !== undefined) {
    return {
      reason: byCode,
      ...(status !== undefined && { status }),
      ...(retryAfterMs !== undefined && { retryAfterMs }),
      retryable: RETRYABLE.has(byCode),
      evidence: 'code',
    };
  }
  const byStatus = status === undefined ? undefined : BY_STATUS.get(status);
  if (byStatus) {
    return {
      reason: byStatus,
      status,
      ...(retryAfterMs !== undefined && { retryAfterMs }),
      retryable: RETRYABLE.has(byStatus),
      evidence: 'status',
    };
  }
  const message = fullMessageOf(error);
  for (const [pattern, reason] of BY_MESSAGE) {
    if (!pattern.test(message)) continue;
    if (reason === 'context-overflow' && OVERFLOW_EXCLUSIONS.some((ex) => ex.test(message))) {
      continue;
    }
    return {
      reason,
      ...(status !== undefined && { status }),
      ...(retryAfterMs !== undefined && { retryAfterMs }),
      retryable: RETRYABLE.has(reason),
      evidence: 'message',
    };
  }
  return {
    reason: 'unknown',
    ...(status !== undefined && { status }),
    ...(retryAfterMs !== undefined && { retryAfterMs }),
    retryable: false,
    evidence: 'none',
  };
}

function hasToolErrorField(record: Record<string, unknown>): boolean {
  if (!Object.hasOwn(record, 'error')) return false;
  const value = record.error;
  return value !== undefined && value !== null && value !== false;
}

/**
 * Whether a *successful* tool result is carrying a failure inside it.
 *
 * A tool can answer `200` with `{ error: … }`, and a loop that reads only the
 * transport treats that as work done. Both wrapped shapes are recognised — the
 * bare object and the `{ value: … }` envelope around a structured result.
 */
export function isToolResultFailure(output: unknown): boolean {
  const parsed = typeof output === 'string' ? parseJson(output) : output;
  if (!isRecord(parsed)) return false;
  if (hasToolErrorField(parsed)) return true;
  return isRecord(parsed.value) && hasToolErrorField(parsed.value);
}

function parseJson(value: string): unknown {
  try {
    return JSON.parse(value);
  } catch {
    return undefined;
  }
}
