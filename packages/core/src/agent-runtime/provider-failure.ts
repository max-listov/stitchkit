/**
 * What a provider refusal was, as a fact rather than as a sentence.
 *
 * Three independently maintained applications carry the same 69-line file for
 * this; two of the copies are byte-identical but for one `catch`, and the oldest
 * says `LIBRARY FILE: no project-specific imports` in its header. The author
 * knew it was a library and had nowhere to put it.
 *
 * The runtime already reports `provider_failure` and keeps the provider's
 * envelope. What it never did was say *which* failure: running out of credits,
 * being rate limited and asking for a model that does not exist are three
 * different situations with three different next moves, and all three arrived as
 * one word.
 *
 * **This classifies; it does not phrase.** The sentence a user reads belongs to
 * the application — its tone, its language, its decision about what to admit —
 * and a core that invents one would be writing product copy. What the core owes
 * is the distinction, because the core is where the provider's answer arrives.
 *
 * Not a domain model (→ ADR 0002): "the provider said 402" is a fact about the
 * provider, not about anyone's business.
 */

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
  | 'model-unavailable'
  | 'context-overflow'
  | 'timeout'
  | 'cancelled'
  | 'unknown';

export interface AgentProviderFailure {
  reason: AgentProviderFailureReason;
  /** The transport status, when the provider supplied one. */
  status?: number;
  /**
   * Whether the same request could plausibly succeed later **without changing
   * it**. Waiting out a rate limit is retryable; a context overflow is not,
   * because retrying an unchanged oversized request fails identically.
   */
  retryable: boolean;
  /**
   * How the reason was reached. A status code is the provider stating its own
   * answer; a message match is us reading its prose, which changes without
   * notice and across providers. A consumer deciding whether to act
   * automatically should know which of the two it got.
   */
  evidence: 'status' | 'message' | 'none';
}

const BY_STATUS: Readonly<Record<number, AgentProviderFailureReason>> = {
  402: 'insufficient-credits',
  404: 'model-unavailable',
  408: 'timeout',
  413: 'context-overflow',
  429: 'rate-limited',
};

/**
 * Prose the providers actually emit, for the case where no status survived.
 *
 * Substring matching on someone else's sentences is fragile by nature, and it is
 * the fallback for exactly that reason: it runs only when the structured answer
 * is missing, and it reports `evidence: 'message'` so a caller can weigh it
 * accordingly. Order matters — the first match wins, so the narrower phrases
 * come before the broader ones.
 */
const BY_MESSAGE: readonly (readonly [RegExp, AgentProviderFailureReason])[] = [
  [/insufficient|not enough credit|payment required|quota exceeded/i, 'insufficient-credits'],
  [/rate.?limit|too many requests|slow down/i, 'rate-limited'],
  [
    /no endpoints found|model not found|unknown model|no allowed providers/i,
    'model-unavailable',
  ],
  [/context length|maximum context|too many tokens|prompt is too long/i, 'context-overflow'],
  [/timed? ?out|deadline exceeded|etimedout/i, 'timeout'],
  [/abort|cancell?ed/i, 'cancelled'],
];

/** Retrying the same request unchanged could plausibly work. */
const RETRYABLE: ReadonlySet<AgentProviderFailureReason> = new Set([
  'rate-limited',
  'timeout',
  'insufficient-credits',
]);

function statusOf(value: unknown): number | undefined {
  if (!isRecord(value)) return undefined;
  for (const key of ['statusCode', 'status', 'code']) {
    const candidate = value[key];
    if (typeof candidate === 'number' && candidate >= 400 && candidate < 600) return candidate;
  }
  // `ai` wraps the transport failure; the status lives one level down.
  const nested = value.cause ?? value.response ?? value.error;
  return nested === value ? undefined : statusOf(nested);
}

function messageOf(value: unknown): string {
  if (value instanceof Error) return value.message;
  if (typeof value === 'string') return value;
  if (isRecord(value) && typeof value.message === 'string') return value.message;
  return '';
}

/**
 * Classify one thrown provider value.
 *
 * Never throws and never guesses: a failure it does not recognise is `unknown`
 * with `evidence: 'none'`, which is a different statement from any of the named
 * reasons and must not be treated as one.
 */
export function classifyProviderFailure(error: unknown): AgentProviderFailure {
  const status = statusOf(error);
  const byStatus = status === undefined ? undefined : BY_STATUS[status];
  if (byStatus) {
    return {
      reason: byStatus,
      status,
      retryable: RETRYABLE.has(byStatus),
      evidence: 'status',
    };
  }
  const message = messageOf(error);
  for (const [pattern, reason] of BY_MESSAGE) {
    if (pattern.test(message)) {
      return {
        reason,
        ...(status !== undefined && { status }),
        retryable: RETRYABLE.has(reason),
        evidence: 'message',
      };
    }
  }
  return {
    reason: 'unknown',
    ...(status !== undefined && { status }),
    // An unrecognised failure is not assumed safe to repeat: a retry loop built
    // on a guess is how one broken request becomes a bill.
    retryable: false,
    evidence: 'none',
  };
}

/**
 * Whether a *successful* tool result is carrying a failure inside it.
 *
 * A tool can answer `200` with `{ error: … }`, and a loop that reads only the
 * transport treats that as work done. Both wrapped shapes the applications ran
 * into are recognised — the bare object and the `{ value: … }` envelope the SDK
 * puts around a structured result.
 */
export function isToolResultFailure(output: unknown): boolean {
  const parsed = typeof output === 'string' ? parseJson(output) : output;
  if (!isRecord(parsed)) return false;
  if ('error' in parsed) return true;
  return isRecord(parsed.value) && 'error' in parsed.value;
}

function parseJson(value: string): unknown {
  try {
    return JSON.parse(value);
  } catch {
    // Provider and tool output is commonly plain text; text carries no envelope
    // and therefore hides no error inside one.
    return undefined;
  }
}
