import { type LanguageModel, wrapLanguageModel } from 'ai';
import type { AgentRuntimeEvent } from './event-schema';
import { agentDurableEventId } from './event-schema';
import { findRun } from './runtime-internals';
import {
  type AgentRun,
  type AgentRunOperation,
  AgentRunOperationSchema,
  type AgentSnapshot,
} from './schemas';
import type { AgentRuntimeStore } from './store';
import { appliedSnapshot } from './terminal-commit';

type TerminalOperationPhase = 'completed' | 'failed' | 'cancelled';

export interface AgentRunOperationLifecycleConfig {
  store: AgentRuntimeStore;
  runtimeEpoch: string;
  currentRun(): AgentRun;
  acceptSnapshot(snapshot: AgentSnapshot): void;
  publish(event: AgentRuntimeEvent): Promise<void>;
  now(): Date;
}

/** One durable latest-operation state machine for an executing run. */
export function createAgentRunOperationLifecycle(config: AgentRunOperationLifecycleConfig) {
  let active: AgentRunOperation | undefined;
  let providerCallId: string | undefined;
  let checkpointedStep = -1;
  const checkpointWaiters = new Map<number, ReturnType<typeof Promise.withResolvers<void>>>();

  const record = async (operation: AgentRunOperation): Promise<void> => {
    const current = config.currentRun();
    const snapshot = appliedSnapshot(
      await config.store.recordRunOperation({
        conversationId: current.conversationId,
        runId: current.id,
        expectedRevision: current.revision,
        ownerId: config.runtimeEpoch,
        ...(current.fencingToken !== undefined && { fencingToken: current.fencingToken }),
        operation,
      }),
      'run operation',
    );
    config.acceptSnapshot(snapshot);
    const run = findRun(snapshot.runs, current.id);
    active = operation;
    await config.publish({
      type: 'run-operation',
      eventId: agentDurableEventId('run-operation', run.id, snapshot.version),
      conversationId: run.conversationId,
      runId: run.id,
      snapshotVersion: snapshot.version,
      operation,
      emittedAt: config.now().toISOString(),
    });
  };
  const startModelRequest = (callId: string, step: number): Promise<void> =>
    record(
      AgentRunOperationSchema.parse({
        operationId: `${callId}:${step}`,
        kind: 'model-request',
        phase: 'started',
        step,
        startedAt: config.now().toISOString(),
      }),
    );

  return {
    noteProviderCall(callId: string): void {
      providerCallId = callId;
    },
    async prepareModel(
      model: LanguageModel,
      step: number,
      fallbackCallId: string,
    ): Promise<LanguageModel> {
      if (step > checkpointedStep + 1) {
        const waiter = checkpointWaiters.get(step - 1) ?? Promise.withResolvers<void>();
        checkpointWaiters.set(step - 1, waiter);
        await waiter.promise;
      }
      if (typeof model === 'string') {
        // Global provider IDs are resolved inside the SDK and therefore cannot
        // be wrapped. Admit them here with the runtime's own stable identity.
        await startModelRequest(fallbackCallId, step);
        return model;
      }
      return wrapLanguageModel({
        model,
        middleware: {
          specificationVersion: 'v4',
          wrapStream: async ({ doStream }) => {
            const callId = providerCallId;
            providerCallId = undefined;
            if (!callId) {
              throw new Error(
                'AgentRuntime model call reached the provider without lifecycle identity',
              );
            }
            // This awaited write is the admission fence: the provider is not
            // invoked when durable lifecycle storage rejects the transition.
            await startModelRequest(callId, step);
            return doStream();
          },
        },
      });
    },
    checkpointStep(step: number): void {
      checkpointedStep = Math.max(checkpointedStep, step);
      for (const [waitingFor, waiter] of checkpointWaiters) {
        if (waitingFor > checkpointedStep) continue;
        checkpointWaiters.delete(waitingFor);
        waiter.resolve();
      }
    },
    failStepCheckpoints(error: unknown): void {
      for (const waiter of checkpointWaiters.values()) waiter.reject(error);
      checkpointWaiters.clear();
    },
    startCompaction(operationId: string): Promise<void> {
      return record(
        AgentRunOperationSchema.parse({
          operationId,
          kind: 'compaction',
          phase: 'started',
          startedAt: config.now().toISOString(),
        }),
      );
    },
    firstOutput(): Promise<void> {
      if (active?.kind !== 'model-request' || active.phase !== 'started') {
        return Promise.resolve();
      }
      return record(
        AgentRunOperationSchema.parse({
          ...active,
          phase: 'first-output',
          firstOutputAt: config.now().toISOString(),
        }),
      );
    },
    finish(phase: TerminalOperationPhase): Promise<void> {
      if (!active || ['completed', 'failed', 'cancelled'].includes(active.phase)) {
        return Promise.resolve();
      }
      return record(
        AgentRunOperationSchema.parse({
          ...active,
          phase,
          finishedAt: config.now().toISOString(),
        }),
      );
    },
  };
}
