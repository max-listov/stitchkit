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
  delayMs(input: { attempt: number; failure: AgentProviderFailure }): number;
}

/**
 * Refuse a policy whose `maxAttempts` is not a positive safe integer. `Infinity`
 * would retry a retryable failure, paid, without end; `NaN`, `0` or a fraction
 * would silently mean "never retry". `subject` names where the policy was given.
 */
export function assertAgentRetryPolicy(subject: string, policy: AgentRetryPolicy): void {
  assertPositiveSafeInteger(`${subject}.maxAttempts`, policy.maxAttempts, TypeError, {
    absent: 'refused',
  });
}

export async function recordAgentRetryDecision(input: {
  store: AgentRuntimeStore;
  conversationId: string;
  attempt: number;
  failure: AgentProviderFailure;
  policy: AgentRetryPolicy;
}): Promise<{ retry: boolean; delayMs: number }> {
  assertAgentRetryPolicy('Retry policy', input.policy);
  const retry = input.failure.retryable && input.attempt < input.policy.maxAttempts;
  const delayMs = retry
    ? input.policy.delayMs({ attempt: input.attempt, failure: input.failure })
    : 0;
  assertTimerMs('Retry delayMs', delayMs, { min: 0, absent: 'refused' });
  if (retry) {
    await input.store.appendEvent({
      conversationId: input.conversationId,
      kind: 'retry/scheduled',
      payload: { attempt: input.attempt + 1, delayMs, reason: input.failure.reason },
    });
  }
  return { retry, delayMs };
}
