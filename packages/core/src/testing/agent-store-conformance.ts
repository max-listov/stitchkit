import { AgentMessageSchema, AgentRunSchema } from '../agent-runtime/schemas';
import type { AgentRuntimeStore } from '../agent-runtime/store';

export interface AgentStoreConformanceConfig {
  createStore(): AgentRuntimeStore | Promise<AgentRuntimeStore>;
}

function userMessage(conversationId: string, id: string) {
  return AgentMessageSchema.parse({
    schemaVersion: 1,
    id,
    conversationId,
    role: 'user',
    status: 'committed',
    parts: [{ type: 'text', text: id }],
    createdAt: '2026-08-22T00:00:00.000Z',
    updatedAt: '2026-08-22T00:00:00.000Z',
  });
}

function queuedRun(conversationId: string, inputMessageId: string, id: string) {
  return AgentRunSchema.parse({
    schemaVersion: 1,
    id,
    conversationId,
    inputMessageIds: [inputMessageId],
    assistantMessageId: `${id}-assistant`,
    state: 'queued',
    revision: 0,
    createdAt: '2026-08-22T00:00:00.000Z',
    updatedAt: '2026-08-22T00:00:00.000Z',
  });
}

function requireOutcome<OUTCOME extends string>(
  actual: { outcome: string },
  expected: OUTCOME,
): asserts actual is { outcome: OUTCOME } {
  if (actual.outcome !== expected) {
    throw new Error(
      `Agent store conformance expected ${expected}, received ${actual.outcome}`,
    );
  }
}

/** Black-box contract shared by memory and third-party durable agent stores. */
export async function runAgentStoreConformance(
  config: AgentStoreConformanceConfig,
): Promise<void> {
  const store = await config.createStore();
  const conversationId = `conformance-${crypto.randomUUID()}`;
  const firstInput = userMessage(conversationId, 'input-1');
  const firstRun = queuedRun(conversationId, firstInput.id, 'run-1');
  const accepted = await store.acceptInputAndAssignRun({
    idempotencyKey: 'request-1',
    input: firstInput,
    run: firstRun,
  });
  requireOutcome(accepted, 'applied');

  const duplicate = await store.acceptInputAndAssignRun({
    idempotencyKey: 'request-1',
    input: userMessage(conversationId, 'discarded-input'),
    run: queuedRun(conversationId, 'discarded-input', 'discarded-run'),
  });
  requireOutcome(duplicate, 'duplicate');
  if (
    duplicate.input.id !== firstInput.id ||
    duplicate.inputMessageId !== firstInput.id ||
    duplicate.runId !== firstRun.id ||
    duplicate.assistantMessageId !== firstRun.assistantMessageId
  ) {
    throw new Error('Duplicate admission did not return its original durable identity');
  }

  const secondInput = userMessage(conversationId, 'input-2');
  const coalesced = await store.acceptInputAndAssignRun({
    idempotencyKey: 'request-2',
    input: secondInput,
    run: queuedRun(conversationId, secondInput.id, 'discarded-coalesced-run'),
    coalesceIntoRunId: firstRun.id,
  });
  requireOutcome(coalesced, 'applied');
  const assigned = coalesced.snapshot.runs.find((run) => run.id === firstRun.id);
  if (assigned?.inputMessageIds.join(',') !== 'input-1,input-2') {
    throw new Error('Coalesced admission did not preserve ordered input identities');
  }

  const collidingInput = userMessage(conversationId, assigned.assistantMessageId);
  await store
    .acceptInputAndAssignRun({
      idempotencyKey: 'request-collision',
      input: collidingInput,
      run: queuedRun(conversationId, collidingInput.id, 'discarded-collision-run'),
      coalesceIntoRunId: assigned.id,
    })
    .then(
      () => {
        throw new Error('Coalesced input reused the reserved assistant identity');
      },
      (error) => {
        if (!(error instanceof TypeError)) throw error;
      },
    );

  await store
    .replaceCompactedRange({
      conversationId,
      expectedVersion: coalesced.snapshot.version,
      replacedMessageIds: [firstInput.id, secondInput.id],
      summary: AgentMessageSchema.parse({
        schemaVersion: 1,
        id: assigned.assistantMessageId,
        conversationId,
        role: 'summary',
        status: 'committed',
        parts: [{ type: 'text', text: 'invalid reserved identity' }],
        createdAt: '2026-08-22T00:00:02.000Z',
        updatedAt: '2026-08-22T00:00:02.000Z',
      }),
    })
    .then(
      () => {
        throw new Error('Compaction reused a reserved assistant identity');
      },
      (error) => {
        if (!(error instanceof TypeError)) throw error;
      },
    );

  const compacted = await store.replaceCompactedRange({
    conversationId,
    expectedVersion: coalesced.snapshot.version,
    replacedMessageIds: [firstInput.id, secondInput.id],
    summary: AgentMessageSchema.parse({
      schemaVersion: 1,
      id: 'summary-1',
      conversationId,
      role: 'summary',
      status: 'committed',
      parts: [{ type: 'text', text: 'two inputs' }],
      createdAt: '2026-08-22T00:00:02.000Z',
      updatedAt: '2026-08-22T00:00:02.000Z',
    }),
  });
  requireOutcome(compacted, 'applied');
  const duplicateAfterCompaction = await store.acceptInputAndAssignRun({
    idempotencyKey: 'request-1',
    input: userMessage(conversationId, 'discarded-after-compaction'),
    run: queuedRun(conversationId, 'discarded-after-compaction', 'discarded-run-2'),
  });
  requireOutcome(duplicateAfterCompaction, 'duplicate');
  if (duplicateAfterCompaction.input.id !== firstInput.id) {
    throw new Error('Compaction discarded the canonical duplicate admission input');
  }

  const acquired = await store.acquireRun({
    conversationId,
    runId: assigned.id,
    expectedRevision: assigned.revision,
    ownerId: 'conformance-owner',
  });
  requireOutcome(acquired, 'applied');
  const running = acquired.snapshot.runs.find((run) => run.id === assigned.id);
  if (!running) throw new Error('Acquired run disappeared');

  const stale = await store.checkpointRunAssistant({
    conversationId,
    runId: running.id,
    expectedRevision: running.revision - 1,
    ownerId: 'conformance-owner',
    assistant: AgentMessageSchema.parse({
      schemaVersion: 1,
      id: running.assistantMessageId,
      conversationId,
      runId: running.id,
      role: 'assistant',
      status: 'streaming',
      parts: [],
      createdAt: '2026-08-22T00:00:00.000Z',
      updatedAt: '2026-08-22T00:00:01.000Z',
    }),
  });
  requireOutcome(stale, 'conflict');

  const abandoned = await store.recoverRun({
    conversationId,
    runId: running.id,
    expectedRevision: running.revision,
    action: 'abandon',
  });
  requireOutcome(abandoned, 'applied');
  const terminalRun = abandoned.snapshot.runs.find((run) => run.id === running.id);
  const terminalMessage = abandoned.snapshot.messages.find(
    (message) => message.id === running.assistantMessageId,
  );
  if (terminalRun?.state !== 'abandoned' || terminalMessage?.status !== 'failed') {
    throw new Error('Abandon recovery did not atomically terminalize its assistant record');
  }
}
