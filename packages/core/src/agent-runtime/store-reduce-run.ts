import {
  AgentMessageSchema,
  type AgentRun,
  AgentRunSchema,
  type AgentSnapshot,
} from './schemas';
import type {
  AcquireAgentRun,
  CheckpointRunAssistant,
  RecordRunOperation,
  RecoverAgentRun,
  RequestRunInterrupt,
} from './store';
import { AgentStoredRunSchema, isActiveRunState } from './store-driver-contract';
import { applied, conflict, type ReducedMutation } from './store-reduce-shared';
import { replaceMessage, replaceRun } from './store-snapshot';

/** Take the lease on a queued run that nothing ahead of it blocks. */
export function reduceAcquire(
  current: AgentSnapshot,
  run: AgentRun,
  input: AcquireAgentRun,
): ReducedMutation {
  const runPosition = current.runs.findIndex((candidate) => candidate.id === run.id);
  const acquisitionBlocked = current.runs.some(
    (candidate, index) =>
      candidate.id !== run.id &&
      (candidate.state === 'running' ||
        candidate.state === 'interrupt_requested' ||
        (index < runPosition && candidate.state === 'queued')),
  );
  if (
    run.revision !== input.expectedRevision ||
    run.state !== 'queued' ||
    acquisitionBlocked
  ) {
    return conflict(run.revision);
  }
  const next = AgentRunSchema.parse({
    ...run,
    state: 'running',
    executionSequence: run.executionSequence ?? current.version + 1,
    ownerId: input.ownerId,
    fencingToken: (run.fencingToken ?? 0) + 1,
    revision: run.revision + 1,
    updatedAt: new Date().toISOString(),
  });
  return applied(
    current,
    { runs: replaceRun(current.runs, next) },
    {
      runRecords: [AgentStoredRunSchema.parse({ schemaVersion: 1, run: next })],
    },
  );
}

/** Persist the owner's streaming assistant draft and usage so far. */
export function reduceCheckpoint(
  current: AgentSnapshot,
  run: AgentRun,
  input: CheckpointRunAssistant,
): ReducedMutation {
  if (
    run.revision !== input.expectedRevision ||
    run.state !== 'running' ||
    run.ownerId !== input.ownerId ||
    (input.fencingToken !== undefined && run.fencingToken !== input.fencingToken) ||
    input.assistant.runId !== run.id ||
    input.assistant.id !== run.assistantMessageId ||
    input.assistant.conversationId !== run.conversationId ||
    input.assistant.role !== 'assistant' ||
    input.assistant.status !== 'streaming'
  ) {
    return conflict(run.revision);
  }
  const next = AgentRunSchema.parse({
    ...run,
    ...(input.usage && { usage: input.usage }),
    revision: run.revision + 1,
    updatedAt: new Date().toISOString(),
  });
  return applied(
    current,
    {
      runs: replaceRun(current.runs, next),
      messages: replaceMessage(current.messages, input.assistant),
    },
    {
      runRecords: [AgentStoredRunSchema.parse({ schemaVersion: 1, run: next })],
      historyMutations: [{ type: 'upsert-assistant', message: input.assistant }],
    },
  );
}

/** Record the operation a run is currently performing. */
export function reduceOperation(
  current: AgentSnapshot,
  run: AgentRun,
  input: RecordRunOperation,
): ReducedMutation {
  if (
    run.revision !== input.expectedRevision ||
    (run.state !== 'running' && run.state !== 'interrupt_requested') ||
    run.ownerId !== input.ownerId ||
    (input.fencingToken !== undefined && run.fencingToken !== input.fencingToken)
  ) {
    return conflict(run.revision);
  }
  const next = AgentRunSchema.parse({
    ...run,
    lastOperation: input.operation,
    revision: run.revision + 1,
    updatedAt: new Date().toISOString(),
  });
  return applied(
    current,
    { runs: replaceRun(current.runs, next) },
    { runRecords: [AgentStoredRunSchema.parse({ schemaVersion: 1, run: next })] },
  );
}

/** Ask a running run to stop. */
export function reduceInterrupt(
  current: AgentSnapshot,
  run: AgentRun,
  input: RequestRunInterrupt,
): ReducedMutation {
  if (run.revision !== input.expectedRevision || run.state !== 'running') {
    return conflict(run.revision);
  }
  const next = AgentRunSchema.parse({
    ...run,
    state: 'interrupt_requested',
    revision: run.revision + 1,
    updatedAt: new Date().toISOString(),
  });
  return applied(
    current,
    { runs: replaceRun(current.runs, next) },
    {
      runRecords: [AgentStoredRunSchema.parse({ schemaVersion: 1, run: next })],
    },
  );
}

/** Release an orphaned run's lease: requeue it, or abandon it with a failed answer. */
export function reduceRecover(
  current: AgentSnapshot,
  run: AgentRun,
  input: RecoverAgentRun,
): ReducedMutation {
  if (run.revision !== input.expectedRevision || !isActiveRunState(run.state)) {
    return conflict(run.revision);
  }
  if (input.action === 'requeue' && run.state !== 'queued' && input.replaySafe !== true) {
    throw new TypeError('Recovering an acquired run requires explicit replaySafe evidence');
  }
  // Carry the record forward and override what recovery changes, rather than
  // rebuilding it from a list of fields. The list was the defect: it silently
  // dropped every field added to `AgentRun` after it was written, and two of
  // them mattered. `usage` is what a crashed attempt already spent — the
  // figure this whole durable field exists to preserve, deleted by the one
  // path that exists to recover from a crash. `fencingToken` is documented as
  // monotonic so a distributed adapter can reject an old owner *even if an
  // owner label is reused*, and resetting it to undefined made the next
  // acquisition mint token 1 again — defeating precisely the named scenario.
  //
  // `ownerId` is the one field recovery really does clear: the lease is
  // released, and that is the point of recovering.
  const { ownerId: _released, ...carried } = run;
  const next = AgentRunSchema.parse({
    ...carried,
    state: input.action === 'requeue' ? 'queued' : 'abandoned',
    revision: run.revision + 1,
    ...(input.action === 'abandon' && { terminalReason: 'abandoned' }),
    updatedAt: new Date().toISOString(),
  });
  if (input.action === 'abandon') {
    const existingAssistant = current.messages.find(
      (message) => message.id === run.assistantMessageId,
    );
    const assistant = AgentMessageSchema.parse({
      ...(existingAssistant ?? {
        schemaVersion: 1,
        id: run.assistantMessageId,
        conversationId: run.conversationId,
        runId: run.id,
        role: 'assistant',
        parts: [],
        createdAt: run.createdAt,
      }),
      status: 'failed',
      updatedAt: new Date().toISOString(),
    });
    return applied(
      current,
      {
        runs: replaceRun(current.runs, next),
        messages: replaceMessage(current.messages, assistant),
      },
      {
        runRecords: [
          AgentStoredRunSchema.parse({
            schemaVersion: 1,
            run: next,
            terminalAssistant: assistant,
          }),
        ],
        historyMutations: [{ type: 'upsert-assistant', message: assistant }],
      },
    );
  }
  return applied(
    current,
    { runs: replaceRun(current.runs, next) },
    {
      runRecords: [AgentStoredRunSchema.parse({ schemaVersion: 1, run: next })],
    },
  );
}
