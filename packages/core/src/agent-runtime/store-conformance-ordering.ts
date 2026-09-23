/**
 * The ordering guarantees an agent store must keep across storage: causal
 * history, the order of active runs, interrupt priority, and an absorption that
 * lands whole or not at all.
 */
import { AgentMessageSchema, AgentRunSchema } from './schemas';
import type { AgentRuntimeStore } from './store';
import { queuedRun, requireOutcome, userMessage } from './store-conformance-support';

/** Urgent queued work survives storage and becomes the next acquired run. */
export async function assertInterruptPriorityOrder(
  store: AgentRuntimeStore,
  conversationId: string,
): Promise<void> {
  const inputs = ['priority-a', 'priority-b', 'priority-c'].map((id) =>
    userMessage(conversationId, id),
  );
  const [inputA, inputB, inputC] = inputs;
  if (!inputA || !inputB || !inputC) throw new Error('Priority fixture is incomplete');

  const runA = queuedRun(conversationId, inputA.id, 'priority-run-a');
  const runB = queuedRun(conversationId, inputB.id, 'priority-run-b');
  const runC = AgentRunSchema.parse({
    ...queuedRun(conversationId, inputC.id, 'priority-run-c'),
    queuePriority: 'interrupt-next',
  });
  requireOutcome(
    await store.acceptInputAndAssignRun({ idempotencyKey: runA.id, input: inputA, run: runA }),
    'applied',
  );
  const acquiredA = await store.acquireRun({
    conversationId,
    runId: runA.id,
    expectedRevision: runA.revision,
    ownerId: 'priority-owner-a',
  });
  requireOutcome(acquiredA, 'applied');
  const runningA = acquiredA.snapshot.runs.find((run) => run.id === runA.id);
  if (!runningA) throw new Error('Priority lead run disappeared after acquisition');
  requireOutcome(
    await store.acceptInputAndAssignRun({ idempotencyKey: runB.id, input: inputB, run: runB }),
    'applied',
  );
  requireOutcome(
    await store.acceptInputAndAssignRun({ idempotencyKey: runC.id, input: inputC, run: runC }),
    'applied',
  );

  const active = await store.listActiveRuns(conversationId);
  if (active.map((run) => run.id).join(',') !== `${runA.id},${runC.id},${runB.id}`) {
    throw new Error('Active runs did not place urgent work before ordinary pending work');
  }
  requireOutcome(
    await store.acquireRun({
      conversationId,
      runId: runB.id,
      expectedRevision: runB.revision,
      ownerId: 'priority-owner-b',
    }),
    'conflict',
  );

  const abandonedA = await store.recoverRun({
    conversationId,
    runId: runA.id,
    expectedRevision: runningA.revision,
    action: 'abandon',
  });
  requireOutcome(abandonedA, 'applied');
  const queuedC = abandonedA.snapshot.runs.find((run) => run.id === runC.id);
  if (!queuedC) throw new Error('Urgent run disappeared after predecessor settlement');
  const acquiredC = await store.acquireRun({
    conversationId,
    runId: runC.id,
    expectedRevision: queuedC.revision,
    ownerId: 'priority-owner-c',
  });
  requireOutcome(acquiredC, 'applied');
  const runningC = acquiredC.snapshot.runs.find((run) => run.id === runC.id);
  if (!runningC) throw new Error('Urgent run disappeared after acquisition');
  requireOutcome(
    await store.acquireRun({
      conversationId,
      runId: runB.id,
      expectedRevision: runB.revision,
      ownerId: 'priority-owner-b',
    }),
    'conflict',
  );

  const abandonedC = await store.recoverRun({
    conversationId,
    runId: runC.id,
    expectedRevision: runningC.revision,
    action: 'abandon',
  });
  requireOutcome(abandonedC, 'applied');
  const queuedB = abandonedC.snapshot.runs.find((run) => run.id === runB.id);
  if (!queuedB) throw new Error('Ordinary run disappeared after urgent settlement');
  const acquiredB = await store.acquireRun({
    conversationId,
    runId: runB.id,
    expectedRevision: queuedB.revision,
    ownerId: 'priority-owner-b',
  });
  requireOutcome(acquiredB, 'applied');

  const ordered = acquiredB.snapshot.runs.map((run) => run.id).join(',');
  if (ordered !== `${runA.id},${runC.id},${runB.id}`) {
    throw new Error(`Durable execution order was not preserved: ${ordered}`);
  }
  const [sequenceA, sequenceC, sequenceB] = acquiredB.snapshot.runs.map(
    (run) => run.executionSequence,
  );
  if (
    sequenceA === undefined ||
    sequenceC === undefined ||
    sequenceB === undefined ||
    !(sequenceA < sequenceC && sequenceC < sequenceB)
  ) {
    throw new Error('Acquisition did not persist increasing execution sequence values');
  }
}

/** Active-run reads preserve admission order when identifiers point backwards. */
export async function assertActiveRunCausalOrder(
  store: AgentRuntimeStore,
  conversationId: string,
): Promise<void> {
  for (const id of ['z-causal-run', 'a-causal-run']) {
    const input = userMessage(conversationId, `${id}-input`);
    requireOutcome(
      await store.acceptInputAndAssignRun({
        idempotencyKey: id,
        input,
        run: queuedRun(conversationId, input.id, id),
      }),
      'applied',
    );
  }
  const active = await store.listActiveRuns(conversationId);
  if (active.map((run) => run.id).join(',') !== 'z-causal-run,a-causal-run') {
    throw new Error('listActiveRuns must preserve causal history order for timestamp ties');
  }
}

/** A later durable admission follows the predecessor answer in every snapshot. */
export async function assertCausalHistoryOrder(
  store: AgentRuntimeStore,
  conversationId: string,
): Promise<void> {
  const leadInput = userMessage(conversationId, 'causal-input-1');
  const leadRun = queuedRun(conversationId, leadInput.id, 'causal-run-1');
  requireOutcome(
    await store.acceptInputAndAssignRun({
      idempotencyKey: 'causal-request-1',
      input: leadInput,
      run: leadRun,
    }),
    'applied',
  );
  const acquired = await store.acquireRun({
    conversationId,
    runId: leadRun.id,
    expectedRevision: leadRun.revision,
    ownerId: 'causal-owner',
  });
  requireOutcome(acquired, 'applied');
  const running = acquired.snapshot.runs.find((run) => run.id === leadRun.id);
  if (!running) throw new Error('Causal-order run disappeared after acquisition');

  const successorInput = userMessage(conversationId, 'causal-input-2');
  const successorRun = queuedRun(conversationId, successorInput.id, 'causal-run-2');
  requireOutcome(
    await store.acceptInputAndAssignRun({
      idempotencyKey: 'causal-request-2',
      input: successorInput,
      run: successorRun,
    }),
    'applied',
  );
  const assistant = AgentMessageSchema.parse({
    schemaVersion: 1,
    id: running.assistantMessageId,
    conversationId,
    runId: running.id,
    role: 'assistant',
    status: 'streaming',
    parts: [{ type: 'text', text: 'causal answer' }],
    createdAt: '2026-08-28T00:00:00.000Z',
    updatedAt: '2026-08-28T00:00:01.000Z',
  });
  const checkpoint = await store.checkpointRunAssistant({
    conversationId,
    runId: running.id,
    expectedRevision: running.revision,
    ownerId: 'causal-owner',
    ...(running.fencingToken !== undefined && { fencingToken: running.fencingToken }),
    assistant,
  });
  requireOutcome(checkpoint, 'applied');
  const order = checkpoint.snapshot.messages.map((message) => message.id).join(',');
  if (order !== `${leadInput.id},${assistant.id},${successorInput.id}`) {
    throw new Error(`Agent history is not in causal run order: ${order}`);
  }
}

/**
 * One terminal commit, two run records — and they land together or not at all.
 *
 * A driver that saves the run it was asked about and drops the second is the
 * failure this exists to catch: the absorbing run would claim to have answered
 * an input whose own run is still queued, and that input would then be answered
 * twice. The pair is written inside one transaction, so a driver that persists
 * one record of it fails here.
 */
export async function assertAbsorptionIsAtomic(
  store: AgentRuntimeStore,
  conversationId: string,
): Promise<void> {
  const leadInput = userMessage(conversationId, 'absorb-input-1');
  const leadRun = queuedRun(conversationId, leadInput.id, 'absorb-run-1');
  const lead = await store.acceptInputAndAssignRun({
    idempotencyKey: 'absorb-request-1',
    input: leadInput,
    run: leadRun,
  });
  requireOutcome(lead, 'applied');
  const successorInput = userMessage(conversationId, 'absorb-input-2');
  const successorRun = queuedRun(conversationId, successorInput.id, 'absorb-run-2');
  const successor = await store.acceptInputAndAssignRun({
    idempotencyKey: 'absorb-request-2',
    input: successorInput,
    run: successorRun,
  });
  requireOutcome(successor, 'applied');

  const acquired = await store.acquireRun({
    conversationId,
    runId: leadRun.id,
    expectedRevision: 0,
    ownerId: 'absorb-owner',
  });
  requireOutcome(acquired, 'applied');
  const running = acquired.snapshot.runs.find((run) => run.id === leadRun.id);
  if (!running) throw new Error('Absorbing run disappeared after acquisition');

  const answer = AgentMessageSchema.parse({
    schemaVersion: 1,
    id: running.assistantMessageId,
    conversationId,
    runId: running.id,
    role: 'assistant',
    status: 'completed',
    parts: [{ type: 'text', text: 'answered both' }],
    createdAt: '2026-08-26T00:00:00.000Z',
    updatedAt: '2026-08-26T00:00:02.000Z',
  });
  // A run that did not finish may not claim to have answered somebody else's
  // input, and the store says so rather than trusting its caller.
  await store
    .commitRunTerminal({
      conversationId,
      runId: running.id,
      expectedRevision: running.revision,
      ownerId: 'absorb-owner',
      assistant: AgentMessageSchema.parse({ ...answer, status: 'interrupted' }),
      reason: 'interrupted',
      absorb: [{ runId: successorRun.id, inputMessageIds: [successorInput.id] }],
    })
    .then(
      () => {
        throw new Error('A non-completing run absorbed a queued successor');
      },
      (error) => {
        if (!(error instanceof TypeError)) throw error;
      },
    );

  const committed = await store.commitRunTerminal({
    conversationId,
    runId: running.id,
    expectedRevision: running.revision,
    ownerId: 'absorb-owner',
    assistant: answer,
    reason: 'success',
    absorb: [{ runId: successorRun.id, inputMessageIds: [successorInput.id] }],
  });
  requireOutcome(committed, 'applied');

  const absorbingView = await store.loadRun({ conversationId, runId: leadRun.id });
  if (absorbingView?.run.inputMessageIds.join(',') !== 'absorb-input-1,absorb-input-2') {
    throw new Error('An absorbing run must record the inputs it answered');
  }
  const absorbedView = await store.loadRun({ conversationId, runId: successorRun.id });
  if (absorbedView?.run.terminalReason !== 'absorbed') {
    throw new Error('An absorbed successor must be terminal in the same transaction');
  }
  if (absorbedView.run.absorbedIntoRunId !== leadRun.id) {
    throw new Error('An absorbed run must name the run that answered its input');
  }
  if (absorbedView.assistant !== undefined) {
    throw new Error('An absorbed run produced no answer and must retain none');
  }
  if ((await store.listActiveRuns(conversationId)).length !== 0) {
    throw new Error('An absorbed successor must leave the active listing');
  }

  // The whole reason the pointer is durable: a retry of the absorbed input's
  // own idempotency key has to reach the answer, not an empty terminal record.
  const retried = await store.acceptInputAndAssignRun({
    idempotencyKey: 'absorb-request-2',
    input: userMessage(conversationId, 'absorb-discarded'),
    run: queuedRun(conversationId, 'absorb-discarded', 'absorb-discarded-run'),
  });
  requireOutcome(retried, 'duplicate');
  if (retried.runId !== leadRun.id || retried.assistant?.id !== answer.id) {
    throw new Error('A retried absorbed key must resolve to the run that answered it');
  }
  if (retried.inputMessageId !== successorInput.id) {
    throw new Error('A retried absorbed key must still name its own input');
  }
}
