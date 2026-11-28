import type { MutationQueue } from '../internal/mutation-queue';
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
import { AgentRuntimeConflictError, appliedSnapshot } from './terminal-commit';

type TerminalOperationPhase = 'completed' | 'failed' | 'cancelled';

export interface AgentRunOperationLifecycleConfig {
  store: AgentRuntimeStore;
  runtimeEpoch: string;
  currentRun(): AgentRun;
  acceptSnapshot(snapshot: AgentSnapshot): void;
  publish(event: AgentRuntimeEvent): Promise<void>;
  now(): Date;
  /** The order every owned mutation of this run takes its turn in. */
  serialize: MutationQueue;
}

/** One durable latest-operation state machine for an executing run. */
export function createAgentRunOperationLifecycle(config: AgentRunOperationLifecycleConfig) {
  let active: AgentRunOperation | undefined;
  let checkpointedStep = -1;

  const record = (operation: AgentRunOperation): Promise<void> =>
    // Inside the queue, so the revision this names is the one the mutation
    // before it produced rather than one read before an unrelated `await`.
    config.serialize(async () => {
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
    });

  return {
    /**
     * Durable admission fence before one provider call: fails fast if the previous
     * step's checkpoint has not landed, then writes `model-request/started` before the
     * driver is invoked. → ADR 0174, ADR 0336.
     */
    async admitModelRequest(step: number, callId: string): Promise<void> {
      if (step > checkpointedStep + 1) {
        throw new AgentRuntimeConflictError(
          `model request step ${step} admitted before step ${checkpointedStep + 1} checkpoint`,
        );
      }
      await record(
        AgentRunOperationSchema.parse({
          operationId: `${callId}:${step}`,
          kind: 'model-request',
          phase: 'started',
          step,
          startedAt: config.now().toISOString(),
        }),
      );
    },
    checkpointStep(step: number): void {
      checkpointedStep = Math.max(checkpointedStep, step);
    },
    /** Reset the durable step admission watermark when a failed attempt restarts from step 0. */
    resetCheckpointStep(): void {
      checkpointedStep = -1;
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
