import type { AgentModelStream } from './models-driver';
import { ownedProviderStream } from './owned-provider-stream';
import { markProviderOrigin, markProviderParts } from './provider-origin';
import { handleStreamPart } from './provider-stream-parts';
import {
  type ConsumedStepStream,
  createStreamAccumulator,
  parseProviderToolInput,
} from './provider-stream-segments';
import type { CompleteStreamPart } from './run-complete-types';

export interface StandaloneStreamResult extends ConsumedStepStream {
  readonly errorPart?: unknown;
}

/**
 * Consume one standalone `AgentModelStream` (shared by `completeText`, `completeObject`,
 * `streamComplete`, and `createModelInvocationLedger.complete`) using the exact same
 * ordered segment accumulator as the full durable runtime loop (I8).
 */
export async function consumeStandaloneDriverStream(input: {
  readonly modelStream: AgentModelStream;
  readonly abortAttempt: () => void;
  readonly onCleanupFailure?: (error: unknown) => void;
  readonly onChunk?: () => void;
  readonly onPart?: (part: CompleteStreamPart) => void | Promise<void>;
  readonly captureErrorUsage?: boolean;
}): Promise<StandaloneStreamResult> {
  const acc = createStreamAccumulator(input.modelStream.response);
  const noopEmit = async (): Promise<void> => undefined;
  let errorPart: unknown;
  let sawError = false;

  for await (const part of ownedProviderStream({
    stream: markProviderParts(input.modelStream.parts),
    abort: input.abortAttempt,
    onCleanupFailure: input.onCleanupFailure ?? (() => undefined),
  })) {
    input.onChunk?.();
    if (sawError) {
      if (part.type === 'finish') {
        await handleStreamPart(acc, part, noopEmit, async () => false);
      }
      continue;
    }
    if (part.type === 'error') {
      if (input.captureErrorUsage) {
        sawError = true;
        errorPart = part.error;
        acc.result.sawErrorPart = true;
        continue;
      }
      throw markProviderOrigin(part.error);
    }
    if (part.type === 'tool-call') {
      if (part.providerExecuted === true) {
        await input.onPart?.({ ...part, input: parseProviderToolInput(part.input) });
      }
    } else if (part.type !== 'finish') {
      await input.onPart?.(part);
    }
    await handleStreamPart(acc, part, noopEmit, async () => false);
  }
  return sawError ? { ...acc.result, errorPart } : acc.result;
}
