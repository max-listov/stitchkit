import { AgentMessageSchema } from './schemas';
import type { AgentRuntimeStore } from './store';
import { queuedRun, requireOutcome, userMessage } from './store-conformance-support';
import { canonicalAgentJson, decodeAgentConversationArchive } from './store-events';

/** Optional capabilities are exercised when the tested adapter advertises them. */
export async function branchConformance(
  store: AgentRuntimeStore,
  source: string,
  destination: string,
  restored: string,
) {
  if (!store.branchConversation) return;
  const input = userMessage(source, `${source}-input`);
  const run = queuedRun(source, input.id, `${source}-run`);
  requireOutcome(
    await store.acceptInputAndAssignRun({ idempotencyKey: 'branch-input', input, run }),
    'applied',
  );
  requireOutcome(
    await store.acquireRun({
      conversationId: source,
      runId: run.id,
      expectedRevision: 0,
      ownerId: 'branch-conformance',
    }),
    'applied',
  );
  const assistant = AgentMessageSchema.parse({
    ...input,
    id: run.assistantMessageId,
    runId: run.id,
    role: 'assistant',
    status: 'completed',
    parts: [{ type: 'text', text: 'retained branch evidence' }],
  });
  requireOutcome(
    await store.commitRunTerminal({
      conversationId: source,
      runId: run.id,
      expectedRevision: 1,
      ownerId: 'branch-conformance',
      assistant,
      reason: 'success',
    }),
    'applied',
  );
  const before = await store.exportConversation(source);
  const request = {
    requestKey: 'branch-conformance',
    destinationConversationId: destination,
    source: { kind: 'conversation', conversationId: source, throughRunId: run.id },
  } satisfies Parameters<NonNullable<AgentRuntimeStore['branchConversation']>>[0];
  const created = await store.branchConversation(request);
  requireOutcome(created, 'created');
  const duplicate = await store.branchConversation(request);
  requireOutcome(duplicate, 'duplicate');
  if (canonicalAgentJson(created.receipt) !== canonicalAgentJson(duplicate.receipt))
    throw new Error('Branch conformance: duplicate receipt changed');
  const snapshot = await store.loadSnapshot(destination);
  if (
    snapshot.messages.length !== 2 ||
    snapshot.runs.length !== 1 ||
    snapshot.runs[0]?.id === run.id ||
    snapshot.runs[0]?.ownerId !== undefined ||
    snapshot.runs[0]?.fencingToken !== undefined
  )
    throw new Error('Branch conformance: identity or authority was inherited');
  if (Buffer.compare(before, await store.exportConversation(source)) !== 0)
    throw new Error('Branch conformance: source changed');
  const archived = await store.exportConversation(destination);
  const decoded = decodeAgentConversationArchive(archived);
  if (!decoded.events.some((event) => event.kind === 'runtime/branched'))
    throw new Error('Branch conformance: lineage is not durable');
  requireOutcome(
    await store.branchConversation({
      requestKey: 'restore-conformance',
      destinationConversationId: restored,
      source: { kind: 'archive', bytes: archived },
    }),
    'created',
  );
  const nextInput = userMessage(restored, `${restored}-next-input`);
  requireOutcome(
    await store.acceptInputAndAssignRun({
      idempotencyKey: 'next',
      input: nextInput,
      run: queuedRun(restored, nextInput.id, `${restored}-next-run`),
    }),
    'applied',
  );
  if ((await store.loadSnapshot(restored)).messages.length !== 3)
    throw new Error('Branch conformance: next input lost its history');
}
