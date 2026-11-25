import { AgentConversationBranchRefusedError } from './branch-refusal';
import { AgentMessageSchema } from './schemas';
import type { AgentRuntimeStore } from './store';
import { queuedRun, requireOutcome, userMessage } from './store-conformance-support';
import { canonicalAgentJson, decodeAgentConversationArchive } from './store-events';

/** Branch capabilities declared by the conformance caller. */
export async function branchConformance(
  store: AgentRuntimeStore,
  source: string,
  destination: string,
  restored: string,
  capabilities: { readonly branch: boolean; readonly planBranch: boolean },
) {
  if (!capabilities.branch) return;
  if (!store.branchConversation) {
    throw new Error(
      'Agent store conformance: capabilities.branch is true, but store.branchConversation is missing',
    );
  }
  // An attachment the application stored itself: the branch carries it only by declaration.
  const attachment = `attachments/${source}/image.png`;
  const input = AgentMessageSchema.parse({
    ...userMessage(source, `${source}-input`),
    parts: [
      { type: 'text', text: 'see the image' },
      { type: 'file', mediaType: 'image/png', reference: attachment },
    ],
  });
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
    applicationFiles: [
      { reference: attachment, destinationReference: `attachments/${destination}/image.png` },
    ],
  } satisfies Parameters<NonNullable<AgentRuntimeStore['branchConversation']>>[0];
  const undeclared = await store.branchConversation({ ...request, applicationFiles: [] }).then(
    () => undefined,
    (error: unknown) => error,
  );
  if (undeclared === undefined)
    throw new Error(
      'Branch conformance: an undeclared application file reference was not refused',
    );
  if (capabilities.planBranch) {
    if (!store.planConversationBranch) {
      throw new Error(
        'Agent store conformance: capabilities.planBranch is true, but store.planConversationBranch is missing',
      );
    }
    if (!(undeclared instanceof AgentConversationBranchRefusedError))
      throw new Error(
        'Branch conformance: a store that plans branches refuses with AgentConversationBranchRefusedError',
      );
    // A plan reads the same source the same way: one list, and nothing written.
    const planned = await store.planConversationBranch({ ...request, applicationFiles: [] });
    if (
      planned.ready ||
      canonicalAgentJson(planned.refusals) !== canonicalAgentJson(undeclared.refusals) ||
      !planned.applicationFiles.includes(attachment)
    )
      throw new Error('Branch conformance: a plan disagrees with the refusal it predicts');
    if (!(await store.planConversationBranch(request)).ready)
      throw new Error('Branch conformance: a plan refused a fully declared branch');
  }
  if ((await store.loadSnapshot(destination)).version !== 0)
    throw new Error('Branch conformance: a refused branch wrote its destination');
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
  const copiedFile = snapshot.messages
    .flatMap((message) => message.parts)
    .find((part) => part.type === 'file');
  if (
    copiedFile?.type !== 'file' ||
    copiedFile.reference !== `attachments/${destination}/image.png`
  )
    throw new Error('Branch conformance: a declared application file kept the source address');
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
      applicationFiles: [
        {
          reference: `attachments/${destination}/image.png`,
          destinationReference: `attachments/${restored}/image.png`,
        },
      ],
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
