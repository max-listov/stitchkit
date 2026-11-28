import type { AgentToolSet } from '../tools/agent-tools';
import type { AgentModelStream } from './models-driver';
import { ownedProviderStream } from './owned-provider-stream';
import { markProviderParts } from './provider-origin';
import { handleStreamPart } from './provider-stream-parts';
import { type ConsumedStepStream, createStreamAccumulator } from './provider-stream-segments';
import type { RunExecution } from './run-execution-state';
import type { AgentLoopEvent } from './run-loop-events';
import type { RunProviderLedger } from './run-provider-ledger';
import { AgentStepBarrierError } from './run-step-barriers';
import { buildStepTimings } from './run-step-helpers';
import { recordStepSpend } from './run-step-spend';
import type { PreparedTurn } from './run-turn-preparation';
import type { AgentUsage } from './schemas';
import { statedUsage, unknownUsage } from './schemas-usage-state';

export async function consumeModelStepStream<CONTEXT, TOOLS extends AgentToolSet>(input: {
  execution: RunExecution<CONTEXT, TOOLS>;
  turn: PreparedTurn<CONTEXT, TOOLS>;
  ledger: RunProviderLedger;
  callId: string;
  providerAttempt: number;
  stepStartedAt: number;
  stepModel?: { readonly modelId: string; readonly provider: string };
  isDraining: () => boolean;
  onErrorPart: (error: unknown) => Promise<boolean>;
  onAbandonedUsage?: (usage: AgentUsage) => void;
  abortStepStream: () => void;
  modelStream: AgentModelStream;
  emit: (event: AgentLoopEvent) => Promise<void>;
}): Promise<ConsumedStepStream> {
  const { execution, turn, ledger, modelStream, emit } = input;
  const { state, idleDeadline } = execution;
  const acc = createStreamAccumulator(modelStream.response);
  let cutForReasoningLimit = false;

  try {
    for await (const part of ownedProviderStream({
      stream: markProviderParts(modelStream.parts),
      abort: input.abortStepStream,
      onCleanupFailure: (error) => {
        state.providerStreamCleanupFailure = error;
      },
    })) {
      idleDeadline.touch();
      if (input.isDraining()) {
        if (part.type === 'finish') {
          const fallbackId =
            part.response?.id && part.response.id.length > 0
              ? part.response.id
              : acc.result.responseId.length > 0
                ? acc.result.responseId
                : input.callId;
          const responseModelId = part.response?.modelId ?? acc.result.responseModelId;
          const responseTimestamp = part.response?.timestamp ?? acc.result.responseTimestamp;
          const usage = statedUsage(part.usage);
          const nowMs = performance.now();
          await recordStepSpend(execution, {
            phase: 'abandoned-attempt',
            part: {
              response: {
                id: fallbackId,
                ...(responseModelId !== undefined && { modelId: responseModelId }),
                ...(responseTimestamp !== undefined && { timestamp: responseTimestamp }),
              },
              usage,
              finishReason: part.finishReason,
              toolCallCount: acc.result.rawToolCalls.length,
              ...(part.responseProvider !== undefined && {
                responseProvider: part.responseProvider,
              }),
              ...(part.rawFinishReason !== undefined && {
                rawFinishReason: part.rawFinishReason,
              }),
              ...(part.costDetails !== undefined && { costDetails: part.costDetails }),
              timings: buildStepTimings({
                stepStartedAt: input.stepStartedAt,
                responseFinishedAt: nowMs,
                stepFinishedAt: nowMs,
                firstOutputAt: acc.result.firstOutputAt,
                toolExecutionMs: 0,
                outputChunkTimestamps: acc.result.outputChunkTimestamps,
              }),
            },
            attempt: input.providerAttempt,
            selectedModel: turn.selectedModel,
            ...(input.stepModel && { model: input.stepModel }),
            ledger,
          });
          input.onAbandonedUsage?.(usage);
        }
        continue;
      }
      try {
        await handleStreamPart(acc, part, emit, input.onErrorPart);
      } catch (error) {
        if (
          error instanceof AgentStepBarrierError &&
          error.bound === 'reasoning' &&
          error.action === 'finish-length'
        ) {
          cutForReasoningLimit = true;
          break;
        }
        throw error;
      }
    }
  } finally {
    idleDeadline.stop();
  }

  if (cutForReasoningLimit) {
    for (const [id] of acc.reasoningById) {
      await emit({ type: 'reasoning-end', id });
    }
    acc.reasoningById.clear();
    acc.result.finishPart = {
      type: 'finish',
      finishReason: 'length',
      rawFinishReason: 'max_reasoning_chars',
      usage: unknownUsage(),
    };
  }
  return acc.result;
}
