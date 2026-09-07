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

  return {
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
    startModelRequest(providerCallId: string, step: number): Promise<void> {
      return record(
        AgentRunOperationSchema.parse({
          operationId: `${providerCallId}:${step}`,
          kind: 'model-request',
          phase: 'started',
          step,
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
