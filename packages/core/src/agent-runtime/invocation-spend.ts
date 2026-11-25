import type { SpendAttribution } from '../spend/schemas';
import { currentModelInvocationAttempt } from './invocation-attempt';

/**
 * The agent runtime's current model attempt as spend attribution fields: pass it
 * as a spend gateway's `context` and every provider call the attempt makes carries
 * its conversation, run, invocation, attempt and step. Outside an attempt it
 * contributes nothing.
 */
export function modelInvocationSpendAttribution(): Partial<SpendAttribution> | undefined {
  const attempt = currentModelInvocationAttempt();
  if (!attempt) return undefined;
  return {
    conversationId: attempt.conversationId,
    invocationId: attempt.invocationId,
    invocationAttemptId: attempt.attemptId,
    step: attempt.step,
    ...(attempt.runId !== undefined && { runId: attempt.runId }),
  };
}
