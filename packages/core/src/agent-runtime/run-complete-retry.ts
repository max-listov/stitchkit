import { setTimeout as delay } from 'node:timers/promises';
import { linkAbortSignals } from '../internal/abort-race';
import { consumeStandaloneDriverStream } from './invocation-stream';
import type { AgentModelDriver, AgentModelRequest, AgentModelStream } from './models-driver';
import {
  AgentProviderError,
  AgentProviderStreamCutError,
  classifyProviderFailure,
} from './provider-failure';
import { hasProviderOrigin, markProviderOrigin } from './provider-origin';
import type { ConsumedStepStream } from './provider-stream-segments';
import { resolveAgentRetryDecision } from './retry-policy';
import {
  type AgentRetryAttemptRecord,
  AgentRetryExhaustedError,
  type CompleteStreamPart,
  type CompleteTextInput,
} from './run-complete-types';
import { addUsage, createIdleDeadline } from './runtime-internals';
import type { AgentUsage } from './schemas';
import { statedUsage, unknownUsage } from './schemas-usage-state';

async function callDriverOnce(input: {
  readonly driver: AgentModelDriver;
  readonly request: AgentModelRequest;
  readonly signal: AbortSignal | undefined;
  readonly idleTimeoutMs: number | undefined;
  readonly captureErrorUsage: boolean;
  readonly onPart?: (
    part: CompleteStreamPart,
    waitSignal?: AbortSignal,
  ) => void | Promise<void>;
}): Promise<{
  readonly consumed: ConsumedStepStream;
  readonly errorPart?: unknown;
  readonly stepStartedAt: number;
  readonly responseFinishedAt: number;
}> {
  const stepAbort = new AbortController();
  const baseSignal = input.signal ?? new AbortController().signal;
  const idleDeadline = createIdleDeadline(baseSignal, input.idleTimeoutMs);
  const link = linkAbortSignals(idleDeadline.signal, stepAbort.signal);
  const stepStartedAt = performance.now();
  try {
    idleDeadline.start();
    let modelStream: AgentModelStream;
    try {
      modelStream = await input.driver.stream(input.request, link.signal);
    } catch (error) {
      if (!input.signal?.aborted) markProviderOrigin(error);
      throw error;
    }
    const consumed = await consumeStandaloneDriverStream({
      modelStream,
      abortAttempt: () => stepAbort.abort(new Error('Completion released provider stream')),
      onChunk: () => idleDeadline.touch(),
      ...(input.onPart !== undefined && {
        onPart: (part: CompleteStreamPart) => input.onPart?.(part, link.signal),
      }),
      captureErrorUsage: input.captureErrorUsage,
    });
    const responseFinishedAt = performance.now();
    if (idleDeadline.signal.aborted && !input.signal?.aborted) {
      throw markProviderOrigin(
        new AgentProviderError(`Provider stream idle timeout after ${input.idleTimeoutMs}ms`, {
          provider: input.driver.provider,
          failureReason: 'timeout',
        }),
      );
    }
    return {
      consumed,
      ...(consumed.errorPart !== undefined && { errorPart: consumed.errorPart }),
      stepStartedAt,
      responseFinishedAt,
    };
  } catch (error) {
    if (
      idleDeadline.signal.aborted &&
      !input.signal?.aborted &&
      (hasProviderOrigin(error) || error === idleDeadline.signal.reason)
    ) {
      throw markProviderOrigin(
        new AgentProviderError(`Provider stream idle timeout after ${input.idleTimeoutMs}ms`, {
          provider: input.driver.provider,
          failureReason: 'timeout',
          cause: error,
        }),
      );
    }
    throw error;
  } finally {
    idleDeadline.dispose();
    link.release();
    idleDeadline.release();
  }
}

/**
 * Execute one standalone provider step with optional idle deadline and stateless retry loop,
 * preserving full attempt diagnostics and accumulated billable usage across discarded tries.
 */
export async function runStepModelCallWithRetry(input: {
  readonly driver: AgentModelDriver;
  readonly request: AgentModelRequest;
  readonly signal: AbortSignal | undefined;
  readonly idleTimeoutMs: number | undefined;
  readonly retry: CompleteTextInput['retry'];
  readonly onAttemptDiscarded: CompleteTextInput['onAttemptDiscarded'];
  readonly onPart?: (
    part: CompleteStreamPart,
    waitSignal?: AbortSignal,
  ) => void | Promise<void>;
  readonly priorUsage: AgentUsage | undefined;
}): Promise<{
  readonly consumed: ConsumedStepStream;
  readonly stepStartedAt: number;
  readonly responseFinishedAt: number;
  readonly discardedUsage: AgentUsage | undefined;
}> {
  const retryPolicy = input.retry;
  const retryWindowStart = performance.now();
  const attempts: AgentRetryAttemptRecord[] = [];
  let discardedUsage: AgentUsage | undefined;

  for (let attempt = 1; ; attempt += 1) {
    input.signal?.throwIfAborted();
    let attemptError: unknown;
    let attemptUsage: AgentUsage | undefined;
    try {
      const outcome = await callDriverOnce({
        driver: input.driver,
        request: input.request,
        signal: input.signal,
        idleTimeoutMs: input.idleTimeoutMs,
        captureErrorUsage: retryPolicy !== undefined,
        ...(input.onPart !== undefined && { onPart: input.onPart }),
      });
      if (outcome.errorPart !== undefined) {
        attemptError = markProviderOrigin(outcome.errorPart);
        if (outcome.consumed.finishPart) {
          attemptUsage = statedUsage(outcome.consumed.finishPart.usage);
        }
      } else if (!outcome.consumed.finishPart) {
        input.signal?.throwIfAborted();
        attemptError = markProviderOrigin(
          new AgentProviderStreamCutError('Provider stream ended without a finish event', {
            provider: input.driver.provider,
          }),
        );
      } else {
        return {
          consumed: outcome.consumed,
          stepStartedAt: outcome.stepStartedAt,
          responseFinishedAt: outcome.responseFinishedAt,
          discardedUsage,
        };
      }
    } catch (error) {
      if (input.signal?.aborted || !hasProviderOrigin(error)) throw error;
      attemptError = error;
    }

    if (!retryPolicy) throw attemptError;
    if (attemptUsage !== undefined) {
      discardedUsage = addUsage(discardedUsage, attemptUsage);
    }
    const failure = classifyProviderFailure(attemptError);
    attempts.push({
      attempt,
      error: attemptError,
      failure,
      ...(attemptUsage !== undefined && { usage: attemptUsage }),
    });
    const decision = resolveAgentRetryDecision({
      attempt,
      failure,
      policy: retryPolicy,
      elapsedMs: Math.max(0, performance.now() - retryWindowStart),
    });
    if (!decision.retry) {
      if (attempts.length === 1 && !failure.retryable) throw attemptError;
      const accumulated =
        discardedUsage !== undefined
          ? addUsage(input.priorUsage, discardedUsage)
          : input.priorUsage;
      throw new AgentRetryExhaustedError(
        `Completion failed after ${attempts.length} attempt(s) (${failure.reason})`,
        {
          attempts,
          lastError: attemptError,
          usage: statedUsage(accumulated ?? unknownUsage()),
        },
      );
    }
    await input.onAttemptDiscarded?.({
      attempt,
      reason: failure.reason,
      ...(attemptUsage !== undefined && { usage: attemptUsage }),
    });
    await input.onPart?.(
      {
        type: 'attempt-reset',
        attempt,
        reason: failure.reason,
        ...(attemptUsage !== undefined && { usage: attemptUsage }),
      },
      input.signal,
    );
    if (decision.delayMs > 0) {
      await delay(decision.delayMs, undefined, { signal: input.signal });
    }
  }
}
