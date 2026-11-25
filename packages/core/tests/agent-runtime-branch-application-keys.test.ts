/**
 * An application's record of the past may name the source conversation, and a
 * branch carries it as the record it is.
 *
 * A host writes down which run took an input, and a tool that reads the host's
 * own data answers with the IDs it found. Both are observations: the branch
 * keeps them byte for byte rather than rewriting history, and the runtime never
 * reads them back as references. What a value can *do* — read a spill's bytes,
 * open an attachment — still crosses only by its own contract, so a historical
 * key whose value names one refuses the branch.
 */
import { expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { z } from 'zod';
import { createAgentSpillStore } from '../src/agent-runtime/spill';
import { createBunSqliteAgentRuntimeStore } from '../src/agent-runtime/sqlite-bun';
import {
  type AgentMessage,
  AgentMessageSchema,
  AgentRunSchema,
  type AgentRuntimeStore,
  type BranchAgentConversationInput,
  BranchAgentConversationInputSchema,
  createMemoryAgentRuntimeStore,
} from '../src/entrypoints/agent-runtime';
import { branch, branchTime, branchTurn } from './support/agent-branch-fixture';

const attachment = 'attachments/source/receipt.png';
const authorization = { operation: 'read', path: 'destination-only' } as const;

/**
 * One settled turn as a host records it: the input carries the intake receipt
 * naming the run that took it, the answer has a spilled command output and a
 * read of the host's own records that answers with source IDs.
 */
async function recordedTurn(store: AgentRuntimeStore, spill: string) {
  const conversationId = 'source';
  const input = AgentMessageSchema.parse({
    schemaVersion: 1,
    id: 'input-first',
    conversationId,
    role: 'user',
    status: 'committed',
    parts: [
      { type: 'text', text: 'what does this receipt say?' },
      { type: 'file', mediaType: 'image/png', reference: attachment },
    ],
    metadata: { intake: { runId: 'first', channel: 'telegram' } },
    createdAt: branchTime,
    updatedAt: branchTime,
  });
  const run = AgentRunSchema.parse({
    schemaVersion: 1,
    id: 'first',
    conversationId,
    inputMessageIds: [input.id],
    assistantMessageId: 'answer-first',
    state: 'queued',
    revision: 0,
    createdAt: branchTime,
    updatedAt: branchTime,
  });
  await store.acceptInputAndAssignRun({ idempotencyKey: 'key-first', input, run });
  await store.acquireRun({
    conversationId,
    runId: 'first',
    expectedRevision: 0,
    ownerId: 'o',
  });
  const parts: AgentMessage['parts'] = [
    { type: 'tool-call', callId: 'call', toolName: 'run_command', input: {} },
    {
      type: 'tool-result',
      callId: 'call',
      toolName: 'run_command',
      outcome: 'success',
      output: {
        executable: 'fixture',
        exitCode: 0,
        signal: null,
        stdout: 'preview',
        stderr: '',
        outcome: 'exited',
        artifact: {
          reference: spill,
          bytes: 21,
          truncated: true,
          headBytes: 0,
          tailBytes: 0,
          omittedBytes: 21,
        },
      },
    },
    { type: 'tool-call', callId: 'lookup', toolName: 'read_runs', input: { limit: 1 } },
    {
      type: 'tool-result',
      callId: 'lookup',
      toolName: 'read_runs',
      outcome: 'success',
      output: { runs: [{ runId: 'first', conversationId: 'source', state: 'running' }] },
    },
  ];
  const result = await store.commitRunTerminal({
    conversationId,
    runId: 'first',
    expectedRevision: 1,
    ownerId: 'o',
    assistant: AgentMessageSchema.parse({
      schemaVersion: 1,
      id: run.assistantMessageId,
      conversationId,
      runId: 'first',
      role: 'assistant',
      status: 'completed',
      parts,
      createdAt: branchTime,
      updatedAt: branchTime,
    }),
    reason: 'success',
  });
  if (result.outcome !== 'applied') throw new Error(`terminal ${result.outcome}`);
}

async function sourceOnDisk(directory: string) {
  const filename = join(directory, 'runtime.sqlite');
  const sqlite = createBunSqliteAgentRuntimeStore({ filename });
  const { reference: spill } = await createAgentSpillStore({
    host: sqlite.host,
    conversationId: 'source',
    runId: 'first',
  }).write({
    data: new TextEncoder().encode('full artifact payload'),
    mediaType: 'text/plain',
    authorization: { operation: 'read', path: 'source-only' },
    toolCallId: 'call',
  });
  await recordedTurn(sqlite.store, spill);
  return { filename, sqlite, spill };
}

const request = (destination: string) =>
  ({
    requestKey: destination,
    destinationConversationId: destination,
    source: { kind: 'conversation', conversationId: 'source' },
    artifactAuthorization: authorization,
    applicationFiles: [
      { reference: attachment, destinationReference: `granted/${destination}` },
    ],
  }) satisfies BranchAgentConversationInput;

async function refusedAtomically(
  store: AgentRuntimeStore,
  input: BranchAgentConversationInput,
  message: string | RegExp,
) {
  const before = await store.exportConversation('source');
  await expect(branch(store, input)).rejects.toThrow(message);
  expect((await store.loadSnapshot(input.destinationConversationId)).version).toBe(0);
  expect(
    (await store.readEvents({ conversationId: input.destinationConversationId, limit: 10 }))
      .items,
  ).toEqual([]);
  expect(Buffer.compare(before, await store.exportConversation('source'))).toBe(0);
}

/** The destination keeps the record as written, its own image and its own spill. */
async function carriesTheRecord(
  sqlite: ReturnType<typeof createBunSqliteAgentRuntimeStore>,
  conversationId: string,
) {
  const snapshot = await sqlite.store.loadSnapshot(conversationId);
  const input = snapshot.messages.find((message) => message.role === 'user');
  expect(input?.metadata).toEqual({ intake: { runId: 'first', channel: 'telegram' } });
  const parts = snapshot.messages.flatMap((message) => message.parts);
  expect(parts.find((part) => part.type === 'file')).toMatchObject({
    reference: `granted/${conversationId}`,
  });
  const lookup = parts.find(
    (part) => part.type === 'tool-result' && part.toolName === 'read_runs',
  );
  expect(lookup).toMatchObject({
    output: { runs: [{ runId: 'first', conversationId: 'source', state: 'running' }] },
  });
  // The record is the past; the destination's own run is a new identity.
  expect(snapshot.runs.map((run) => run.id)).not.toContain('first');
  const command = parts.find(
    (part) => part.type === 'tool-result' && part.toolName === 'run_command',
  );
  if (command?.type !== 'tool-result') throw new Error('the branch lost its command output');
  const { artifact } = BranchArtifact.parse(command.output);
  const read = await createAgentSpillStore({ host: sqlite.host, conversationId }).read({
    reference: artifact.reference,
    offset: 0,
    maxBytes: 100,
  });
  expect(new TextDecoder().decode(read.data)).toBe('full artifact payload');
}

/** Only the artifact reference matters here; the rest of the shell output is the runtime's. */
const BranchArtifact = z.object({ artifact: z.object({ reference: z.string() }) });

const retained = [
  { key: 'runId', sourceIdentity: 'retain' },
  { key: 'conversationId', sourceIdentity: 'retain' },
] as const;

test('a host record naming the source run refuses under a refusing key, as the customer saw it', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'stitchkit-branch-history-'));
  const { sqlite } = await sourceOnDisk(directory);
  try {
    await refusedAtomically(sqlite.store, request('copy'), 'declare it in applicationKeys');
    const refusing = {
      ...request('copy'),
      applicationKeys: [{ key: 'runId' }, { key: 'conversationId' }],
    } satisfies BranchAgentConversationInput;
    await refusedAtomically(
      sqlite.store,
      refusing,
      'Branch cannot carry a source identity under the application key runId at intake.runId',
    );
    // The archive a host restores from is read the same way.
    await refusedAtomically(
      sqlite.store,
      {
        ...refusing,
        source: { kind: 'archive', bytes: await sqlite.store.exportConversation('source') },
      },
      'under the application key runId at intake.runId',
    );
  } finally {
    await sqlite.close();
    rmSync(directory, { recursive: true, force: true });
  }
});

test('a retained record crosses fork, restore and restart unchanged', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'stitchkit-branch-history-'));
  const { filename, sqlite } = await sourceOnDisk(directory);
  try {
    const before = await sqlite.store.exportConversation('source');
    const fork = { ...request('fork'), applicationKeys: [...retained] };
    const created = await branch(sqlite.store, fork);
    await carriesTheRecord(sqlite, 'fork');
    // One request, one receipt, whatever order it lists its keys in; the
    // same key under another mode is another request.
    expect(
      await branch(sqlite.store, { ...fork, applicationKeys: [...retained].reverse() }),
    ).toEqual({ outcome: 'duplicate', receipt: created.receipt });
    await expect(
      branch(sqlite.store, {
        ...fork,
        applicationKeys: [
          { key: 'runId' },
          { key: 'conversationId', sourceIdentity: 'retain' },
        ],
      }),
    ).rejects.toThrow('conflicts with the destination receipt');
    const archive = await sqlite.store.exportConversation('source');
    expect(Buffer.compare(before, archive)).toBe(0);

    await branch(sqlite.store, {
      ...request('restored'),
      source: { kind: 'archive', bytes: archive },
      applicationKeys: [...retained],
    });
    await carriesTheRecord(sqlite, 'restored');
    // A branch of the branch: the record names a conversation that is no
    // longer its source, and crosses again unchanged.
    await branch(sqlite.store, {
      ...request('grandchild'),
      source: { kind: 'conversation', conversationId: 'fork' },
      applicationFiles: [
        { reference: 'granted/fork', destinationReference: 'granted/grandchild' },
      ],
      applicationKeys: [...retained],
    });
    await carriesTheRecord(sqlite, 'grandchild');

    // The memory store reads the same archive the same way.
    const memory = createMemoryAgentRuntimeStore();
    await branch(memory, {
      ...request('memory'),
      source: { kind: 'archive', bytes: archive },
      applicationKeys: [...retained],
    });
    const copied = await memory.loadSnapshot('memory');
    expect(copied.messages.find((message) => message.role === 'user')?.metadata).toEqual({
      intake: { runId: 'first', channel: 'telegram' },
    });
    await sqlite.close();

    const reopened = createBunSqliteAgentRuntimeStore({ filename });
    try {
      await carriesTheRecord(reopened, 'fork');
      await carriesTheRecord(reopened, 'restored');
    } finally {
      await reopened.close();
    }
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test('a retained key carries no spill, file or runtime identity, and no undeclared key at all', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'stitchkit-branch-history-'));
  const { sqlite, spill } = await sourceOnDisk(directory);
  const store = sqlite.store;
  try {
    // Records of the past, each naming something that grants more than it says.
    await branchTurn(store, 'source', 'second', [
      { type: 'tool-call', callId: 'peek', toolName: 'note', input: {} },
      {
        type: 'tool-result',
        callId: 'peek',
        toolName: 'note',
        outcome: 'success',
        output: { saw: [{ reference: spill }, { reference: attachment }] },
      },
    ]);
    const keys = (sourceIdentity: 'refuse' | 'retain') =>
      [
        ...retained,
        { key: 'reference', sourceIdentity },
        { key: 'callId', sourceIdentity },
      ] as const;
    await refusedAtomically(
      store,
      { ...request('copy'), applicationKeys: [...keys('retain')] },
      'Branch cannot carry a source spill under the application key reference at saw[0].reference',
    );
    // The tail after the selected run is understood too: a branch through
    // `first` still refuses what only `second` carries.
    await refusedAtomically(
      store,
      {
        ...request('copy'),
        source: { kind: 'conversation', conversationId: 'source', throughRunId: 'first' },
        applicationKeys: [...keys('retain')],
      },
      'source spill under the application key reference',
    );
    await refusedAtomically(
      store,
      { ...request('copy'), applicationKeys: [...keys('refuse')] },
      'source identity under the application key reference at saw[0].reference',
    );
    await refusedAtomically(
      store,
      { ...request('copy'), applicationKeys: [...retained] },
      'containing reference at saw[0].reference; declare it in applicationKeys',
    );
  } finally {
    await sqlite.close();
    rmSync(directory, { recursive: true, force: true });
  }
});

test('a retained key names an application file or a call and still refuses', async () => {
  const store = createMemoryAgentRuntimeStore();
  await branchTurn(store, 'source', 'first', [
    { type: 'tool-call', callId: 'call', toolName: 'note', input: {} },
    {
      type: 'tool-result',
      callId: 'call',
      toolName: 'note',
      outcome: 'success',
      output: { attachment: { reference: 'uploads/a.png' } },
    },
  ]);
  const calls = createMemoryAgentRuntimeStore();
  await branchTurn(calls, 'source', 'first', [
    { type: 'tool-call', callId: 'call', toolName: 'note', input: {} },
    { type: 'tool-result', callId: 'call', toolName: 'note', outcome: 'success', output: {} },
  ]);
  await branchTurn(calls, 'source', 'second', [
    { type: 'tool-call', callId: 'later', toolName: 'note', input: {} },
    {
      type: 'tool-result',
      callId: 'later',
      toolName: 'note',
      outcome: 'success',
      output: { answered: { callId: 'call' } },
    },
  ]);
  const base = {
    requestKey: 'copy',
    destinationConversationId: 'copy',
    source: { kind: 'conversation', conversationId: 'source' },
    applicationFiles: [{ reference: 'uploads/a.png', destinationReference: 'copy/a.png' }],
  } satisfies BranchAgentConversationInput;
  await refusedAtomically(
    store,
    {
      ...base,
      applicationKeys: [
        { key: 'reference', sourceIdentity: 'retain' },
        { key: 'callId', sourceIdentity: 'retain' },
      ],
    },
    'Branch cannot carry a source file under the application key reference at attachment.reference',
  );
  await refusedAtomically(
    store,
    {
      ...base,
      applicationKeys: [{ key: 'reference' }, { key: 'callId', sourceIdentity: 'retain' }],
    },
    'source identity under the application key reference',
  );
  // A tool call is the runtime's own identity: a record of one is not a record of the past it can keep.
  await refusedAtomically(
    calls,
    {
      ...base,
      applicationFiles: [],
      applicationKeys: [{ key: 'callId', sourceIdentity: 'retain' }],
    },
    'Branch cannot carry a source call under the application key callId at answered.callId',
  );
});

test('an application key is one of the runtime reference names, declared once', () => {
  const base = {
    requestKey: 'copy',
    destinationConversationId: 'copy',
    source: { kind: 'conversation', conversationId: 'source' },
  };
  expect(
    BranchAgentConversationInputSchema.safeParse({
      ...base,
      applicationKeys: [{ key: 'runId' }, { key: 'runId', sourceIdentity: 'retain' }],
    }).success,
  ).toBe(false);
  // A misspelt name would declare nothing; it refuses instead.
  expect(
    BranchAgentConversationInputSchema.safeParse({
      ...base,
      applicationKeys: [{ key: 'runID' }],
    }).success,
  ).toBe(false);
  expect(
    BranchAgentConversationInputSchema.parse({ ...base, applicationKeys: [{ key: 'runId' }] })
      .applicationKeys,
  ).toEqual([{ key: 'runId', sourceIdentity: 'refuse' }]);
});

test('a key the application declares as its own data crosses a branch; a source identity under it does not', async () => {
  const store = createMemoryAgentRuntimeStore();
  await branchTurn(store, 'source', 'first', [
    { type: 'tool-call', callId: 'call', toolName: 'send_message', input: { text: 'hi' } },
    {
      type: 'tool-result',
      callId: 'call',
      toolName: 'send_message',
      outcome: 'success',
      output: { messageId: 'telegram-4242', ticket: { reference: 'CRM-17' } },
    },
  ]);
  const request = {
    requestKey: 'keys',
    destinationConversationId: 'copy',
    source: { kind: 'conversation', conversationId: 'source' },
  } satisfies BranchAgentConversationInput;
  // Undeclared, the names read as runtime references and the refusal says what to declare.
  await refusedAtomically(store, request, 'declare it in applicationKeys');
  await refusedAtomically(
    store,
    { ...request, applicationKeys: [{ key: 'messageId' }] },
    'opaque payload containing reference',
  );
  await branch(store, {
    ...request,
    applicationKeys: [{ key: 'messageId' }, { key: 'reference' }],
  });
  const result = (await store.loadSnapshot('copy')).messages
    .flatMap((message) => message.parts)
    .find((part) => part.type === 'tool-result');
  expect(result).toMatchObject({
    output: { messageId: 'telegram-4242', ticket: { reference: 'CRM-17' } },
  });

  // Under a refusing key, a value that names the source's own run is a reference, not data.
  const leaking = createMemoryAgentRuntimeStore();
  await branchTurn(leaking, 'source', 'first', [
    { type: 'tool-call', callId: 'call', toolName: 'note', input: { runId: 'first' } },
    { type: 'tool-result', callId: 'call', toolName: 'note', outcome: 'success', output: {} },
  ]);
  await refusedAtomically(
    leaking,
    { ...request, applicationKeys: [{ key: 'runId' }] },
    'source identity under the application key runId',
  );
});
