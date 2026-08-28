import { AgentMessageSchema, AgentRunSchema } from '../agent-runtime/schemas';
import type { AgentRuntimeStore } from '../agent-runtime/store';

/**
 * What the scenario is about to touch, handed over before the first mutation.
 *
 * The kit used to pick its conversation identities *after* `createStore()`
 * returned, which locked out exactly the adapters it exists to certify: a
 * durable store whose runtime rows hang off an application-owned conversation
 * row cannot serve the first admission, because nobody ever told it which
 * parent to provision. Running the kit against the memory reference store
 * instead proves the reducer — which is not the thing under test.
 */
export interface AgentStoreConformanceContext {
  /**
   * Every conversation the scenario mutates, in the order it first touches
   * them. Provision one parent per id before returning the store, and remove
   * them again in `cleanup`.
   */
  readonly conversationIds: readonly string[];
}

export interface AgentStoreConformanceConfig {
  /**
   * Build the store under test. The context arrives first so an adapter can
   * provision fixture state; a factory that needs none may ignore it, and an
   * existing zero-argument factory stays valid unchanged.
   */
  createStore(
    context: AgentStoreConformanceContext,
  ): AgentRuntimeStore | Promise<AgentRuntimeStore>;
  /**
   * Remove whatever `createStore` provisioned.
   *
   * Runs exactly once, after the scenario, whether it passed or failed — a kit
   * that only cleans up on success leaks a row for every red run, which is the
   * shape that makes a failing suite un-rerunnable. A failure here never
   * replaces the scenario's own: the answer to "does this adapter conform" is
   * not overwritten by the answer to "did the teardown work".
   */
  cleanup?(context: AgentStoreConformanceContext): void | Promise<void>;
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
  const run = `conformance-${crypto.randomUUID()}`;
  const context: AgentStoreConformanceContext = {
    conversationIds: [
      run,
      `${run}-recovery`,
      `${run}-absorb`,
      `${run}-causal-history`,
      `${run}-causal-active`,
      `${run}-interrupt-priority`,
    ],
  };
  const store = await config.createStore(context);
  let failure: unknown;
  try {
    await conformanceScenario(store, context.conversationIds);
  } catch (error) {
    failure = error;
  }
  try {
    await config.cleanup?.(context);
  } catch (cleanupError) {
    if (failure === undefined) throw cleanupError;
    // Both failed. The scenario's message leads, so an assertion on it still
    // matches, and the teardown failure travels with it instead of replacing
    // it or vanishing.
    throw new AggregateError(
      [failure, cleanupError],
      `${failure instanceof Error ? failure.message : String(failure)} (cleanup also failed: ${
        cleanupError instanceof Error ? cleanupError.message : String(cleanupError)
      })`,
    );
  }
  if (failure !== undefined) throw failure;
}

async function conformanceScenario(
  store: AgentRuntimeStore,
  conversationIds: readonly string[],
): Promise<void> {
  const [
    conversationId,
    recoveryConversationId,
    absorbConversationId,
    causalHistoryConversationId,
    causalActiveConversationId,
    interruptPriorityConversationId,
  ] = conversationIds;
  if (
    !conversationId ||
    !recoveryConversationId ||
    !absorbConversationId ||
    !causalHistoryConversationId ||
    !causalActiveConversationId ||
    !interruptPriorityConversationId
  ) {
    throw new Error('Agent store conformance requires six conversation identities');
  }
  /**
   * An identity the scenario asserts is ABSENT, and therefore deliberately not
   * in `conversationIds` — provisioning it would destroy the assertion.
   *
   * Generated rather than written out: the literal `'no-such-conversation'` it
   * used to be is a string a consumer's own database may legitimately contain,
   * and then a green adapter failed here for a reason that has nothing to do
   * with the contract.
   */
  const absentConversationId = `${conversationId}-absent`;
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

  // The one member `recover()` calls, and it had no coverage at all.
  const recoverable = await store.scanRecoverable({ limit: 10 });
  if (!recoverable.items.some((item) => item.run.id === running.id)) {
    throw new Error('A running run must appear in a recoverable scan');
  }
  const interrupted = await store.requestRunInterrupt({
    conversationId,
    runId: running.id,
    expectedRevision: checkpointedRun.revision,
  });
  requireOutcome(interrupted, 'applied');
  const interruptedRun = interrupted.snapshot.runs.find((run) => run.id === running.id);
  if (interruptedRun?.state !== 'interrupt_requested') {
    throw new Error('A durable interrupt must move the run to interrupt_requested');
  }
  if (interruptedRun.usage?.cost?.value !== 0.25) {
    throw new Error('An interrupt must not discard the figure the run had already spent');
  }

  const terminalResults = await Promise.all([
    store.commitRunTerminal({
      conversationId,
      runId: running.id,
      expectedRevision: interruptedRun.revision,
      ownerId: 'conformance-owner',
      assistant: terminalAssistant,
      reason: 'success',
      usage: {
        inputTokens: { value: 3_000, provenance: 'computed' },
        outputTokens: { value: 300, provenance: 'computed' },
        cost: { value: 1.5, currency: 'USD', provenance: 'computed' },
      },
    }),
    store.commitRunTerminal({
      conversationId,
      runId: running.id,
      expectedRevision: interruptedRun.revision,
      ownerId: 'conformance-owner',
      assistant: terminalAssistant,
      reason: 'success',
      usage: {
        inputTokens: { value: 3_000, provenance: 'computed' },
        outputTokens: { value: 300, provenance: 'computed' },
        cost: { value: 1.5, currency: 'USD', provenance: 'computed' },
      },
    }),
  ]);
  const terminalOutcomes = terminalResults.map((result) => result.outcome).sort();
  if (terminalOutcomes.join(',') !== 'applied,conflict') {
    throw new Error(`Terminal race was not linearized: ${terminalOutcomes.join(',')}`);
  }
  const terminalApplied = terminalResults.find((result) => result.outcome === 'applied');
  if (terminalApplied?.outcome !== 'applied') {
    throw new Error('Terminal race produced no applied result');
  }
  const settledRun = terminalApplied.snapshot.runs.find((run) => run.id === running.id);
  if (settledRun?.usage?.cost?.value !== 1.5) {
    throw new Error('Terminal commit did not persist the run usage it was given');
  }
  // The terminal read: this is the one shape `commitAgentRunTerminal` resolves
  // a lost race with, and it is the only reason `assistant` is on the view.
  const terminalView = await store.loadRun({ conversationId, runId: running.id });
  if (terminalView?.run.terminalReason !== 'success') {
    throw new Error('loadRun must report the terminal reason a settled run ended with');
  }
  if (JSON.stringify(terminalView.assistant) !== JSON.stringify(terminalAssistant)) {
    throw new Error('loadRun must retain the answer a settled run produced');
  }
  if ((await store.listActiveRuns(conversationId)).some((run) => run.id === running.id)) {
    throw new Error('listActiveRuns must drop a run once it has ended');
  }

  const compactedTerminal = await store.replaceCompactedRange({
    conversationId,
    expectedVersion: terminalApplied.snapshot.version,
    replacedMessageIds: ['summary-1', terminalAssistant.id],
    summary: AgentMessageSchema.parse({
      schemaVersion: 1,
      id: 'summary-2',
      conversationId,
      role: 'summary',
      status: 'committed',
      parts: [{ type: 'text', text: 'terminal history' }],
      createdAt: '2026-08-22T00:00:03.000Z',
      updatedAt: '2026-08-22T00:00:03.000Z',
    }),
  });
  requireOutcome(compactedTerminal, 'applied');
  const duplicateTerminal = await store.acceptInputAndAssignRun({
    idempotencyKey: 'request-1',
    input: userMessage(conversationId, 'discarded-terminal-input'),
    run: queuedRun(conversationId, 'discarded-terminal-input', 'discarded-terminal-run'),
  });
  requireOutcome(duplicateTerminal, 'duplicate');
  if (
    duplicateTerminal.run.terminalReason !== 'success' ||
    JSON.stringify(duplicateTerminal.assistant) !== JSON.stringify(terminalAssistant)
  ) {
    throw new Error('Compaction discarded the canonical duplicate terminal result');
  }

  const recoveryInput = userMessage(recoveryConversationId, 'recovery-input');
  const recoveryRun = queuedRun(recoveryConversationId, recoveryInput.id, 'recovery-run');
  const recoveryAccepted = await store.acceptInputAndAssignRun({
    idempotencyKey: 'recovery-request',
    input: recoveryInput,
    run: recoveryRun,
  });
  requireOutcome(recoveryAccepted, 'applied');
  const recoveryAssigned = recoveryAccepted.snapshot.runs.find(
    (run) => run.id === recoveryRun.id,
  );
  if (!recoveryAssigned) throw new Error('Recovery run disappeared after admission');
  const recoveryAcquired = await store.acquireRun({
    conversationId: recoveryConversationId,
    runId: recoveryAssigned.id,
    expectedRevision: recoveryAssigned.revision,
    ownerId: 'abandoned-owner',
  });
  requireOutcome(recoveryAcquired, 'applied');
  const abandonedRun = recoveryAcquired.snapshot.runs.find((run) => run.id === recoveryRun.id);
  if (!abandonedRun) throw new Error('Recovery run disappeared after acquisition');
  const abandoned = await store.recoverRun({
    conversationId: recoveryConversationId,
    runId: abandonedRun.id,
    expectedRevision: abandonedRun.revision,
    action: 'abandon',
  });
  requireOutcome(abandoned, 'applied');
  const terminalRun = abandoned.snapshot.runs.find((run) => run.id === abandonedRun.id);
  const terminalMessage = abandoned.snapshot.messages.find(
    (message) => message.id === abandonedRun.assistantMessageId,
  );
  if (terminalRun?.state !== 'abandoned' || terminalMessage?.status !== 'failed') {
    throw new Error('Abandon recovery did not atomically terminalize its assistant record');
  }

  await assertCausalHistoryOrder(store, causalHistoryConversationId);
  await assertActiveRunCausalOrder(store, causalActiveConversationId);
  await assertInterruptPriorityOrder(store, interruptPriorityConversationId);
  await assertAbsorptionIsAtomic(store, absorbConversationId);
}

/** Urgent queued work survives storage and becomes the next acquired run. */
async function assertInterruptPriorityOrder(
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
async function assertActiveRunCausalOrder(
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
async function assertCausalHistoryOrder(
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
async function assertAbsorptionIsAtomic(
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
