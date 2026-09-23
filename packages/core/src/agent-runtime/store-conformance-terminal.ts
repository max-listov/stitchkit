/**
 * How a run ends in the conformance kit: a terminal race that exactly one
 * commit wins, and an abandoned run terminalized atomically.
 */
import { AgentMessageSchema, type AgentRun, type AgentUsage } from './schemas';
import type { AgentRuntimeStore } from './store';
import type { fencingPhase } from './store-conformance-lifecycle';
import { queuedRun, requireOutcome, userMessage } from './store-conformance-support';

/** Two terminal commits race and exactly one applies; the result survives compaction. */
export async function terminalPhase(
  store: AgentRuntimeStore,
  conversationId: string,
  checkpointed: Awaited<ReturnType<typeof fencingPhase>>,
  interruptedRun: AgentRun,
): Promise<void> {
  const { running, terminalAssistant } = checkpointed;
  const terminalUsage = {
    inputTokens: { value: 3_000, provenance: 'computed' },
    outputTokens: { value: 300, provenance: 'computed' },
    reasoningTokens: { value: 30, provenance: 'computed' },
    cacheReadTokens: { value: 200, provenance: 'computed' },
    cacheWriteTokens: { value: 100, provenance: 'computed' },
    cost: { value: 1.5, currency: 'USD', provenance: 'computed' },
  } satisfies AgentUsage;
  const terminalResults = await Promise.all([
    store.commitRunTerminal({
      conversationId,
      runId: running.id,
      expectedRevision: interruptedRun.revision,
      ownerId: 'conformance-owner',
      assistant: terminalAssistant,
      reason: 'success',
      usage: terminalUsage,
    }),
    store.commitRunTerminal({
      conversationId,
      runId: running.id,
      expectedRevision: interruptedRun.revision,
      ownerId: 'conformance-owner',
      assistant: terminalAssistant,
      reason: 'success',
      usage: terminalUsage,
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
  if (JSON.stringify(settledRun?.usage) !== JSON.stringify(terminalUsage)) {
    throw new Error('Terminal commit did not persist the run usage it was given');
  }
  // The terminal read: this is the one shape `commitAgentRunTerminal` resolves
  // a lost race with, and it is the only reason `assistant` is on the view.
  const terminalView = await store.loadRun({ conversationId, runId: running.id });
  if (terminalView?.run.terminalReason !== 'success') {
    throw new Error('loadRun must report the terminal reason a settled run ended with');
  }
  if (JSON.stringify(terminalView.run.usage) !== JSON.stringify(terminalUsage)) {
    throw new Error('loadRun must return every persisted terminal usage field');
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
}

/** An abandoned run is terminalized atomically and leaves the recoverable index. */
export async function abandonPhase(
  store: AgentRuntimeStore,
  recoveryConversationId: string,
): Promise<void> {
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
  const abandonedView = await store.loadRun({
    conversationId: recoveryConversationId,
    runId: abandonedRun.id,
  });
  if (
    abandonedView?.run.state !== 'abandoned' ||
    abandonedView.run.terminalReason !== 'abandoned' ||
    abandonedView.assistant?.status !== 'failed'
  ) {
    throw new Error('The canonical run record disagrees with its abandoned index projection');
  }
  const afterAbandon = await store.scanRecoverable({ limit: 100 });
  if (afterAbandon.items.some((item) => item.run.id === abandonedRun.id)) {
    throw new Error('The recoverable index still exposes a canonically abandoned run');
  }
}
