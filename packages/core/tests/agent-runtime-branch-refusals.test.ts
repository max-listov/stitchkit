/**
 * A branch says everything a host must declare in one answer, and where.
 *
 * A consuming project branches archives of hundreds of events. The branch used
 * to stop at the first refusal and name no event, so the host learnt what to
 * declare one refusal per attempt, and could not plan the attachment access it
 * must grant before the call. Now every refusal a declaration lifts comes back
 * in one list, each with its event, message, tool and key path and never a
 * value; a plan gives the same list without writing; and the answer does not
 * depend on the order the source happened to record its identities in.
 */
import { describe, expect, test } from 'bun:test';
import { createBunSqliteAgentRuntimeStore } from '../src/agent-runtime/sqlite-bun';
import {
  type AgentBranchRefusal,
  AgentConversationBranchRefusedError,
  type AgentMessage,
  AgentMessageSchema,
  AgentRunSchema,
  type AgentRuntimeStore,
  type BranchAgentConversationInput,
  createMemoryAgentRuntimeStore,
} from '../src/entrypoints/agent-runtime';
import { branch, branchTime, branchTurn } from './support/agent-branch-fixture';

const attachment = 'attachments/source/receipt.png';

const stores: [string, () => AgentRuntimeStore][] = [
  ['memory', () => createMemoryAgentRuntimeStore()],
  ['sqlite', () => createBunSqliteAgentRuntimeStore({ filename: ':memory:' }).store],
];

function plan(store: AgentRuntimeStore, input: BranchAgentConversationInput) {
  if (!store.planConversationBranch) throw new Error('store cannot plan a branch');
  return store.planConversationBranch(input);
}

async function refusalOf(
  work: Promise<unknown>,
): Promise<AgentConversationBranchRefusedError> {
  const error = await work.then(
    () => undefined,
    (cause: unknown) => cause,
  );
  if (!(error instanceof AgentConversationBranchRefusedError))
    throw new Error(`expected a branch refusal, got ${String(error)}`);
  return error;
}

/** What a refusal says, without the event numbers a store assigns. */
function shape(refusal: AgentBranchRefusal) {
  return [
    refusal.code,
    refusal.key ?? refusal.reference ?? '',
    refusal.eventKind ?? '',
    refusal.messageId ?? '',
    refusal.toolName ?? '',
    refusal.path ?? '',
  ].join(' | ');
}

/** One settled turn whose input the host wrote: an attachment and an intake receipt. */
async function turnWithInput(store: AgentRuntimeStore, input: AgentMessage, runId: string) {
  const run = AgentRunSchema.parse({
    schemaVersion: 1,
    id: runId,
    conversationId: input.conversationId,
    inputMessageIds: [input.id],
    assistantMessageId: `answer-${runId}`,
    state: 'queued',
    revision: 0,
    createdAt: branchTime,
    updatedAt: branchTime,
  });
  await store.acceptInputAndAssignRun({ idempotencyKey: `key-${runId}`, input, run });
  await store.acquireRun({
    conversationId: input.conversationId,
    runId,
    expectedRevision: 0,
    ownerId: 'source-owner',
  });
  const result = await store.commitRunTerminal({
    conversationId: input.conversationId,
    runId,
    expectedRevision: 1,
    ownerId: 'source-owner',
    assistant: AgentMessageSchema.parse({
      schemaVersion: 1,
      id: run.assistantMessageId,
      conversationId: input.conversationId,
      runId,
      role: 'assistant',
      status: 'completed',
      parts: [{ type: 'text', text: 'seen' }],
      createdAt: branchTime,
      updatedAt: branchTime,
    }),
    reason: 'success',
  });
  if (result.outcome !== 'applied') throw new Error(`terminal ${result.outcome}`);
}

/**
 * Three places a host's own data names runtime keys, one undeclared
 * attachment: four refusals, each lifted by a declaration.
 */
async function sourceWithFourRefusals(store: AgentRuntimeStore) {
  const parts: AgentMessage['parts'] = [
    { type: 'tool-call', callId: 'lookup', toolName: 'read_runs', input: { limit: 1 } },
    {
      type: 'tool-result',
      callId: 'lookup',
      toolName: 'read_runs',
      outcome: 'success',
      output: { runs: [{ callId: 'their-call', state: 'done' }] },
    },
  ];
  await branchTurn(store, 'source', 'first', parts);
  await store.appendEvent({
    conversationId: 'source',
    kind: 'state/set',
    payload: { name: 'note', version: 1, value: { messageId: 'm-1' }, actor: 'agent' },
  });
  await turnWithInput(
    store,
    AgentMessageSchema.parse({
      schemaVersion: 1,
      id: 'input-second',
      conversationId: 'source',
      role: 'user',
      status: 'committed',
      parts: [
        { type: 'text', text: 'what does this receipt say?' },
        { type: 'file', mediaType: 'image/png', reference: attachment },
      ],
      metadata: { intake: { runId: 'first', channel: 'telegram' } },
      createdAt: branchTime,
      updatedAt: branchTime,
    }),
    'second',
  );
}

const request = (destination: string): BranchAgentConversationInput => ({
  requestKey: `branch-${destination}`,
  destinationConversationId: destination,
  source: { kind: 'conversation', conversationId: 'source' },
});

describe.each(stores)('every refusal in one answer (%s)', (_name, open) => {
  test('a branch with four undeclared things refuses once, naming all four by address', async () => {
    const store = open();
    await sourceWithFourRefusals(store);
    const refused = await refusalOf(branch(store, request('copy')));
    expect(refused).toBeInstanceOf(TypeError);
    expect(refused.refusals.map(shape).sort()).toEqual(
      [
        'application-file-undeclared | attachments/source/receipt.png | runtime/transition | input-second |  | ',
        'application-key-undeclared | callId | runtime/transition | answer-first | read_runs | runs[0].callId',
        'application-key-undeclared | messageId | state/set |  |  | messageId',
        'application-key-undeclared | runId | runtime/transition | input-second |  | intake.runId',
      ].sort(),
    );
    for (const refusal of refused.refusals) {
      expect(refusal.seq).toBeGreaterThan(0);
      // Never a value: neither the run the receipt named nor the call it found.
      expect(refusal.message).not.toContain("'first'");
      expect(refusal.message).not.toContain('their-call');
    }
    expect(refused.message).toContain('and 3 more refusals');
    expect((await store.loadSnapshot('copy')).version).toBe(0);
  });

  test('a plan returns the same list, writes nothing, and names what to declare', async () => {
    const store = open();
    await sourceWithFourRefusals(store);
    const refused = await refusalOf(branch(store, request('copy')));
    const planned = await plan(store, request('copy'));
    expect(planned.ready).toBe(false);
    expect(planned.refusals).toEqual([...refused.refusals]);
    expect(planned.undeclaredKeys).toEqual(['callId', 'messageId', 'runId']);
    expect(planned.applicationFiles).toEqual([attachment]);
    expect((await store.loadSnapshot('copy')).version).toBe(0);
    expect((await store.readEvents({ conversationId: 'copy', limit: 10 })).items).toEqual([]);

    const declared: BranchAgentConversationInput = {
      ...request('copy'),
      // The intake receipt names the run that took the input: a record of the past.
      applicationKeys: [
        { key: 'callId' },
        { key: 'messageId' },
        { key: 'runId', sourceIdentity: 'retain' },
      ],
      applicationFiles: [
        { reference: attachment, destinationReference: 'attachments/copy/receipt.png' },
      ],
    };
    const ready = await plan(store, declared);
    expect(ready).toMatchObject({ ready: true, refusals: [], undeclaredKeys: [] });
    expect((await branch(store, declared)).outcome).toBe('created');
  });

  test('a source identity under a refuse key refuses whichever event defines it first', async () => {
    for (const order of ['reference first', 'definition first'] as const) {
      const store = open();
      await branchTurn(store, 'source', 'first');
      const reference = {
        conversationId: 'source',
        kind: 'state/set' as const,
        payload: {
          name: 'note',
          version: 1,
          value: { operationId: 'sched-1' },
          actor: 'agent',
        },
      };
      const definition = {
        conversationId: 'source',
        kind: 'schedule/set' as const,
        payload: { id: 'sched-1', kind: 'after', nextAt: branchTime },
      };
      for (const event of order === 'reference first'
        ? [reference, definition]
        : [definition, reference])
        await store.appendEvent(event);
      const refused = await refusalOf(
        branch(store, { ...request('copy'), applicationKeys: [{ key: 'operationId' }] }),
      );
      expect(refused.refusals.map(shape)).toEqual([
        'application-key-source-identity | operationId | state/set |  |  | operationId',
      ]);
    }
  });

  test('a broken event stops the branch at once, with its address', async () => {
    const store = open();
    await branchTurn(store, 'source', 'first');
    await store.appendEvent({
      conversationId: 'source',
      kind: 'state/set',
      payload: { name: 'note', version: 1, value: {}, actor: 'agent', extra: true },
    });
    const refused = await refusalOf(branch(store, request('copy')));
    expect(refused.refusals).toHaveLength(1);
    expect(refused.refusals[0]).toMatchObject({ code: 'integrity', eventKind: 'state/set' });
    expect(refused.refusals[0]?.seq).toBeGreaterThan(0);
  });
});
