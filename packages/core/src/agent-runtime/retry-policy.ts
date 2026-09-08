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

export async function recordAgentRetryDecision(input: {
  store: AgentRuntimeStore;
  conversationId: string;
  attempt: number;
  failure: AgentProviderFailure;
  policy: AgentRetryPolicy;
}): Promise<{ retry: boolean; delayMs: number }> {
  const retry = input.failure.retryable && input.attempt < input.policy.maxAttempts;
  const delayMs = retry
    ? input.policy.delayMs({ attempt: input.attempt, failure: input.failure })
    : 0;
  if (!Number.isInteger(delayMs) || delayMs < 0) {
    throw new TypeError('Retry delay must be a non-negative integer');
  }
  if (retry) {
    await input.store.appendEvent({
      conversationId: input.conversationId,
      kind: 'retry/scheduled',
      payload: { attempt: input.attempt + 1, delayMs, reason: input.failure.reason },
    });
  }
  return { retry, delayMs };
}
