/**
 * The run-lifecycle scenario of the agent-store conformance kit, in the phases
 * it walks one run through: admitted, acquired and fenced, read back, operated
 * and interrupted, settled by a terminal race — and a second run abandoned.
 * Each phase hands the next exactly what it needs.
 */
import { AgentMessageSchema, type AgentRun } from './schemas';
import type { AgentRuntimeStore } from './store';
import { queuedRun, requireOutcome, userMessage } from './store-conformance-support';

/** Admission: idempotent, coalescing, refusing reserved identities, surviving compaction. */
export async function admissionPhase(store: AgentRuntimeStore, conversationId: string) {
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
  return assigned;
}

/** Acquisition and fencing: a stale revision, a stale token and another owner all conflict. */
export async function fencingPhase(
  store: AgentRuntimeStore,
  conversationId: string,
  assigned: AgentRun,
) {
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

  await store
    .recoverRun({
      conversationId,
      runId: running.id,
      expectedRevision: running.revision,
      action: 'requeue',
    })
    .then(
      () => {
        throw new Error('Acquired recovery replayed without explicit safety evidence');
      },
      (error) => {
        if (!(error instanceof TypeError)) throw error;
      },
    );

  const checkpoint = await store.checkpointRunAssistant({
    conversationId,
    runId: running.id,
    expectedRevision: running.revision,
    ownerId: 'conformance-owner',
    assistant: AgentMessageSchema.parse({
      schemaVersion: 1,
      id: running.assistantMessageId,
      conversationId,
      runId: running.id,
      role: 'assistant',
      status: 'streaming',
      parts: [{ type: 'text', text: 'checkpoint' }],
      createdAt: '2026-08-22T00:00:00.000Z',
      updatedAt: '2026-08-22T00:00:01.000Z',
    }),
    usage: {
      inputTokens: { value: 1_000, provenance: 'provider-reported' },
      outputTokens: { value: 100, provenance: 'provider-reported' },
      cost: { value: 0.25, currency: 'USD', provenance: 'provider-reported' },
    },
  });
  requireOutcome(checkpoint, 'applied');
  const checkpointedRun = checkpoint.snapshot.runs.find((run) => run.id === running.id);
  if (!checkpointedRun) throw new Error('Checkpointed run disappeared');
  // A process that dies mid-stream never reaches the terminal commit, so a
  // driver that drops the checkpointed figure loses everything the run had
  // spent — and the figure has no other durable home.
  if (checkpointedRun.usage?.cost?.value !== 0.25) {
    throw new Error('Checkpoint did not persist the run usage it was given');
  }
  const terminalAssistant = AgentMessageSchema.parse({
    schemaVersion: 1,
    id: running.assistantMessageId,
    conversationId,
    runId: running.id,
    role: 'assistant',
    status: 'completed',
    parts: [{ type: 'text', text: 'done' }],
    createdAt: '2026-08-22T00:00:00.000Z',
    updatedAt: '2026-08-22T00:00:02.000Z',
  });
  // A driver that drops `fencingToken` on the way to storage passes every other
  // check here and then fails *every checkpoint of every run* in production:
  // `acquireRun` returns the token from the reducer's in-memory record, and the
  // reloaded row has none, so the fenced compare-and-swap conflicts forever.
  if (checkpointedRun.fencingToken === undefined) {
    throw new Error('Acquisition must persist a fencing token the store can read back');
  }
  // And it must be rejected when it is stale. Nothing asserted this, so an
  // adapter that ignores the token — or the owner — certified clean.
  const staleFence = await store.checkpointRunAssistant({
    conversationId,
    runId: running.id,
    expectedRevision: checkpointedRun.revision,
    ownerId: 'conformance-owner',
    fencingToken: checkpointedRun.fencingToken + 1,
    assistant: AgentMessageSchema.parse({
      schemaVersion: 1,
      id: running.assistantMessageId,
      conversationId,
      runId: running.id,
      role: 'assistant',
      status: 'streaming',
      parts: [{ type: 'text', text: 'stale fence' }],
      createdAt: '2026-08-22T00:00:00.000Z',
      updatedAt: '2026-08-22T00:00:01.500Z',
    }),
  });
  if (staleFence.outcome !== 'conflict') {
    throw new Error('A checkpoint with a stale fencing token must conflict');
  }
  const foreignOwner = await store.checkpointRunAssistant({
    conversationId,
    runId: running.id,
    expectedRevision: checkpointedRun.revision,
    ownerId: 'a-different-runtime',
    assistant: AgentMessageSchema.parse({
      schemaVersion: 1,
      id: running.assistantMessageId,
      conversationId,
      runId: running.id,
      role: 'assistant',
      status: 'streaming',
      parts: [{ type: 'text', text: 'foreign owner' }],
      createdAt: '2026-08-22T00:00:00.000Z',
      updatedAt: '2026-08-22T00:00:01.700Z',
    }),
  });
  if (foreignOwner.outcome !== 'conflict') {
    throw new Error('A checkpoint from another owner must conflict');
  }
  return { running, checkpoint, checkpointedRun, terminalAssistant };
}

/** The two bounded reads answer what the snapshot answers, and nothing across conversations. */
export async function boundedReadsPhase(
  store: AgentRuntimeStore,
  conversationId: string,
  absentConversationId: string,
  checkpointed: Awaited<ReturnType<typeof fencingPhase>>,
): Promise<void> {
  const { running, checkpoint, checkpointedRun } = checkpointed;
  // The two bounded reads. Everything below is the same fact the snapshot
  // carries, asked for without the conversation — so a driver that answers one
  // and not the other is the failure this section exists to catch.
  const liveView = await store.loadRun({ conversationId, runId: running.id });
  if (!liveView) throw new Error('loadRun must find a run of this conversation');
  if (liveView.run.id !== running.id || liveView.run.conversationId !== conversationId) {
    throw new Error('loadRun returned a run it was not asked for');
  }
  if (liveView.run.revision !== checkpointedRun.revision) {
    throw new Error('loadRun must return the run as the last mutation left it');
  }
  if (liveView.run.usage?.cost?.value !== 0.25) {
    throw new Error('loadRun must carry the figure the run has spent so far');
  }
  if (liveView.snapshotVersion !== checkpoint.snapshot.version) {
    throw new Error('loadRun must report the conversation version it read at');
  }
  // A live run has no retained answer yet — its draft is history, not a
  // terminal record — and a driver that hands one back here would let the
  // terminal path resolve a run that has not finished.
  if (liveView.assistant !== undefined) {
    throw new Error('loadRun must not report a terminal answer for a live run');
  }
  if (await store.loadRun({ conversationId, runId: 'no-such-run' })) {
    throw new Error('loadRun must return undefined for an unknown run');
  }
  if (await store.loadRun({ conversationId: absentConversationId, runId: running.id })) {
    throw new Error('loadRun must not cross conversation boundaries');
  }
  const activeRuns = await store.listActiveRuns(conversationId);
  if (!activeRuns.some((run) => run.id === running.id)) {
    throw new Error('listActiveRuns must report a run that is in flight');
  }
  if (activeRuns.some((run) => run.terminalReason !== undefined)) {
    throw new Error('listActiveRuns must not report a run that has ended');
  }
  for (let index = 1; index < activeRuns.length; index += 1) {
    const previous = activeRuns[index - 1];
    const current = activeRuns[index];
    if (!previous || !current) continue;
    const ordered =
      previous.createdAt === current.createdAt
        ? previous.id.localeCompare(current.id) < 0
        : previous.createdAt < current.createdAt;
    if (!ordered) {
      throw new Error('listActiveRuns must order by createdAt and then by id');
    }
  }
  if ((await store.listActiveRuns(absentConversationId)).length !== 0) {
    throw new Error('listActiveRuns must be empty for an unknown conversation');
  }
}

/** A recoverable scan, a recorded operation and a durable interrupt of the live run. */
export async function interruptPhase(
  store: AgentRuntimeStore,
  conversationId: string,
  checkpointed: Awaited<ReturnType<typeof fencingPhase>>,
) {
  const { running, checkpointedRun } = checkpointed;
  // The one member `recover()` calls, and it had no coverage at all.
  const recoverable = await store.scanRecoverable({ limit: 10 });
  if (!recoverable.items.some((item) => item.run.id === running.id)) {
    throw new Error('A running run must appear in a recoverable scan');
  }
  const operation = await store.recordRunOperation({
    conversationId,
    runId: running.id,
    expectedRevision: checkpointedRun.revision,
    ownerId: 'conformance-owner',
    fencingToken: checkpointedRun.fencingToken,
    operation: {
      operationId: 'model-call-1:0',
      kind: 'model-request',
      phase: 'first-output',
      step: 0,
      startedAt: '2026-08-22T00:00:01.800Z',
      firstOutputAt: '2026-08-22T00:00:01.900Z',
    },
  });
  requireOutcome(operation, 'applied');
  const operatedRun = operation.snapshot.runs.find((run) => run.id === running.id);
  if (operatedRun?.lastOperation?.operationId !== 'model-call-1:0') {
    throw new Error('Run operation identity did not survive its durable mutation');
  }
  const operatedView = await store.loadRun({ conversationId, runId: running.id });
  if (operatedView?.run.lastOperation?.startedAt !== '2026-08-22T00:00:01.800Z') {
    throw new Error('loadRun did not retain the original operation timestamp');
  }
  const interrupted = await store.requestRunInterrupt({
    conversationId,
    runId: running.id,
    expectedRevision: operatedRun.revision,
  });
  requireOutcome(interrupted, 'applied');
  const interruptedRun = interrupted.snapshot.runs.find((run) => run.id === running.id);
  if (interruptedRun?.state !== 'interrupt_requested') {
    throw new Error('A durable interrupt must move the run to interrupt_requested');
  }
  if (interruptedRun.usage?.cost?.value !== 0.25) {
    throw new Error('An interrupt must not discard the figure the run had already spent');
  }
  return interruptedRun;
}
