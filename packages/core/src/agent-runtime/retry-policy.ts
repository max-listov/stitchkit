import { assertTimerMs } from '../internal/deadline';
import { assertPositiveSafeInteger } from '../internal/positive-integer';
import type { AgentProviderFailure } from './provider-failure';
import type { AgentRuntimeStore } from './store';

/**
 * Whether, and after how long, the runtime tries a failed provider stream again.
 *
 * Runtime configuration, not a test fixture: it lives apart from the fault
 * bench so that the main entry carries no `node:http` and no second name for
 * anything the testing entry exports.
 */
export interface AgentRetryPolicy {
  maxAttempts: number;
  /** Optional wall-clock retry budget (ms) bounding total elapsed time across retries. */
  maxRetryDurationMs?: number;
  delayMs(input: { attempt: number; failure: AgentProviderFailure }): number;
}

/**
 * Refuse a policy whose `maxAttempts` is not a positive safe integer or whose
 * `maxRetryDurationMs` violates the timer rule. `Infinity` would retry a retryable
 * failure, paid, without end; `NaN`, `0` or a fraction would silently mean "never retry".
 * `subject` names where the policy was given.
 */
export function assertAgentRetryPolicy(subject: string, policy: AgentRetryPolicy): void {
  assertPositiveSafeInteger(`${subject}.maxAttempts`, policy.maxAttempts, TypeError, {
    absent: 'refused',
  });
  assertTimerMs(`${subject}.maxRetryDurationMs`, policy.maxRetryDurationMs);
}

/** Pure stateless retry decision shared by `recordAgentRetryDecision` and `completeText`. */
export function resolveAgentRetryDecision(input: {
  attempt: number;
  failure: AgentProviderFailure;
  policy: AgentRetryPolicy;
  /** Elapsed wall-clock time (ms) since the first attempt began. */
  elapsedMs?: number;
}): { retry: boolean; delayMs: number } {
  assertAgentRetryPolicy('Retry policy', input.policy);
  const elapsedMs = input.elapsedMs ?? 0;
  const maxDuration = input.policy.maxRetryDurationMs;
  const withinBudget = maxDuration === undefined || elapsedMs < maxDuration;
  const canRetry =
    input.failure.retryable && input.attempt < input.policy.maxAttempts && withinBudget;
  const candidateDelayMs = canRetry
    ? input.policy.delayMs({ attempt: input.attempt, failure: input.failure })
    : 0;
  assertTimerMs('Retry delayMs', candidateDelayMs, { min: 0, absent: 'refused' });
  const retry =
    canRetry && (maxDuration === undefined || elapsedMs + candidateDelayMs <= maxDuration);
  const delayMs = retry ? candidateDelayMs : 0;
  return { retry, delayMs };
}

export async function recordAgentRetryDecision(input: {
  store: AgentRuntimeStore;
  conversationId: string;
  attempt: number;
  failure: AgentProviderFailure;
  policy: AgentRetryPolicy;
  /** Elapsed wall-clock time (ms) since the first attempt began. */
  elapsedMs?: number;
}): Promise<{ retry: boolean; delayMs: number }> {
  const decision = resolveAgentRetryDecision(input);
  if (decision.retry) {
    await input.store.appendEvent({
      conversationId: input.conversationId,
      kind: 'retry/scheduled',
      payload: {
        attempt: input.attempt + 1,
        delayMs: decision.delayMs,
        reason: input.failure.reason,
      },
    });
  }
  return decision;
}
