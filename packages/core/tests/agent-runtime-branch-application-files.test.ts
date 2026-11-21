/**
 * A file part the application stored itself survives a branch only by the
 * host's declaration.
 *
 * The runtime holds spills; an image a user uploaded lives in the application's
 * own store, under a reference the application chose and checks against the
 * conversation that owns it. A branch cannot copy those bytes or grant access to
 * them, so the host grants the destination first and declares the new reference;
 * an undeclared reference is refused, as a foreign one always was.
 */
import { expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { z } from 'zod';
import { createSqliteAgentSpillStore } from '../src/agent-runtime/spill';
import { createBunSqliteAgentRuntimeStore } from '../src/agent-runtime/sqlite-bun';
import {
  type AgentMessage,
  AgentMessageSchema,
  AgentRunSchema,
  type AgentRuntimeStore,
  type BranchAgentConversationInput,
  createMemoryAgentRuntimeStore,
} from '../src/entrypoints/agent-runtime';
import { branch, branchTime } from './support/agent-branch-fixture';

const PNG = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3]);
const attachment = 'attachments/source/first-image.png';
const destinationAuthorization = { operation: 'read', path: 'destination-only' } as const;

/**
 * The application's attachment store: bytes under a reference, readable only by
 * the conversation it was granted to — the check the host's attachment reader
 * makes before it hands out bytes.
 */
function attachments() {
  const files = new Map<string, { conversationId: string; bytes: Uint8Array }>();
  const grants: string[] = [];
  return {
    files,
    grants,
    put(reference: string, conversationId: string, bytes: Uint8Array) {
      files.set(reference, { conversationId, bytes });
    },
    /** What the host does before branching: the same bytes, granted to the destination. */
    grant(reference: string, destination: string): string {
      const source = files.get(reference);
      if (!source) throw new Error(`no attachment ${reference}`);
      const granted = `attachments/${destination}/${reference.split('/').at(-1)}`;
      files.set(granted, { conversationId: destination, bytes: source.bytes });
      grants.push(granted);
      return granted;
    },
    read(reference: string, conversationId: string): Uint8Array {
      const file = files.get(reference);
      if (!file || file.conversationId !== conversationId)
        throw new Error(`${conversationId} may not read ${reference}`);
      return file.bytes;
    },
  };
}

/** One settled turn: an input with an attached image, an answer whose command output spilled. */
async function turn(
  store: AgentRuntimeStore,
  input: { conversationId: string; id: string; parts: AgentMessage['parts'] },
  answer: AgentMessage['parts'],
) {
  const { conversationId, id } = input;
  const message = AgentMessageSchema.parse({
    schemaVersion: 1,
    id: `input-${id}`,
    conversationId,
    role: 'user',
    status: 'committed',
    parts: input.parts,
    createdAt: branchTime,
    updatedAt: branchTime,
  });
  const run = AgentRunSchema.parse({
    schemaVersion: 1,
    id,
    conversationId,
    inputMessageIds: [message.id],
    assistantMessageId: `answer-${id}`,
    state: 'queued',
    revision: 0,
    createdAt: branchTime,
    updatedAt: branchTime,
  });
  await store.acceptInputAndAssignRun({ idempotencyKey: `key-${id}`, input: message, run });
  await store.acquireRun({ conversationId, runId: id, expectedRevision: 0, ownerId: 'owner' });
  const result = await store.commitRunTerminal({
    conversationId,
    runId: id,
    expectedRevision: 1,
    ownerId: 'owner',
    assistant: AgentMessageSchema.parse({
      schemaVersion: 1,
      id: run.assistantMessageId,
      conversationId,
      runId: id,
      role: 'assistant',
      status: 'completed',
      parts: answer,
      createdAt: branchTime,
      updatedAt: branchTime,
    }),
    reason: 'success',
  });
  if (result.outcome !== 'applied') throw new Error(`terminal ${result.outcome}`);
}

function commandOutput(reference: string): AgentMessage['parts'] {
  return [
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
          reference,
          bytes: 21,
          truncated: true,
          headBytes: 0,
          tailBytes: 0,
          omittedBytes: 21,
        },
      },
    },
  ];
}

const imageInput = (reference: string): AgentMessage['parts'] => [
  { type: 'text', text: 'what is on this picture?' },
  { type: 'file', mediaType: 'image/png', reference, filename: 'first-image.png' },
];

/** A SQLite source on disk with one attached image and one runtime spill. */
async function sourceOnDisk(directory: string) {
  const filename = join(directory, 'runtime.sqlite');
  const sqlite = createBunSqliteAgentRuntimeStore({ filename });
  const { reference: spill } = await createSqliteAgentSpillStore({
    sqlite,
    conversationId: 'source',
    runId: 'first',
    toolCallId: 'call',
  }).write({
    data: new TextEncoder().encode('full artifact payload'),
    mediaType: 'text/plain',
    authorization: { operation: 'read', path: 'source-only' },
  });
  await turn(
    sqlite.store,
    { conversationId: 'source', id: 'first', parts: imageInput(attachment) },
    commandOutput(spill),
  );
  return { filename, sqlite, spill };
}

async function refusedAtomically(
  store: AgentRuntimeStore,
  request: BranchAgentConversationInput,
  message: string | RegExp,
) {
  const before = await store.exportConversation('source');
  await expect(branch(store, request)).rejects.toThrow(message);
  expect((await store.loadSnapshot(request.destinationConversationId)).version).toBe(0);
  expect(
    (await store.readEvents({ conversationId: request.destinationConversationId, limit: 10 }))
      .items,
  ).toEqual([]);
  expect(Buffer.compare(before, await store.exportConversation('source'))).toBe(0);
}

/** What the destination reads: its image through the host store, its spill through the runtime. */
async function readsBoth(
  sqlite: ReturnType<typeof createBunSqliteAgentRuntimeStore>,
  store: ReturnType<typeof attachments>,
  conversationId: string,
) {
  const snapshot = await sqlite.store.loadSnapshot(conversationId);
  const parts = snapshot.messages.flatMap((message) => message.parts);
  const image = parts.find((part) => part.type === 'file');
  if (image?.type !== 'file') throw new Error('the branch lost its image');
  expect(image.reference).not.toBe(attachment);
  expect(store.read(image.reference, conversationId)).toEqual(PNG);
  const result = parts.find((part) => part.type === 'tool-result');
  const artifact = z
    .object({ output: z.object({ artifact: z.object({ reference: z.string() }) }) })
    .parse(result);
  const spills = createSqliteAgentSpillStore({ sqlite, conversationId });
  const read = await spills.read({
    reference: artifact.output.artifact.reference,
    offset: 0,
    maxBytes: 100,
  });
  expect(new TextDecoder().decode(read.data)).toBe('full artifact payload');
  return image.reference;
}

test('an attached image and a runtime spill are both readable after fork, restore and restart', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'stitchkit-branch-files-'));
  try {
    const host = attachments();
    host.put(attachment, 'source', PNG);
    const { filename, sqlite } = await sourceOnDisk(directory);
    const forked = host.grant(attachment, 'fork');
    await branch(sqlite.store, {
      requestKey: 'fork',
      destinationConversationId: 'fork',
      source: { kind: 'conversation', conversationId: 'source', throughRunId: 'first' },
      artifactAuthorization: destinationAuthorization,
      applicationFiles: [{ reference: attachment, destinationReference: forked }],
    });
    expect(await readsBoth(sqlite, host, 'fork')).toBe(forked);

    const archive = await sqlite.store.exportConversation('source');
    const restored = host.grant(attachment, 'restored');
    await branch(sqlite.store, {
      requestKey: 'restore',
      destinationConversationId: 'restored',
      source: { kind: 'archive', bytes: archive },
      artifactAuthorization: destinationAuthorization,
      applicationFiles: [{ reference: attachment, destinationReference: restored }],
    });
    expect(await readsBoth(sqlite, host, 'restored')).toBe(restored);
    // The source keeps its own address and its own grant.
    expect(host.read(attachment, 'source')).toEqual(PNG);
    expect(() => host.read(attachment, 'fork')).toThrow();
    await sqlite.close();

    const reopened = createBunSqliteAgentRuntimeStore({ filename });
    try {
      expect(await readsBoth(reopened, host, 'fork')).toBe(forked);
      expect(await readsBoth(reopened, host, 'restored')).toBe(restored);
    } finally {
      await reopened.close();
    }
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test('a missing, foreign or mis-declared reference creates no branch and leaves the source unchanged', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'stitchkit-branch-files-'));
  const { sqlite, spill } = await sourceOnDisk(directory);
  const host = attachments();
  host.put(attachment, 'source', PNG);
  const store = sqlite.store;
  const base = {
    requestKey: 'refused',
    destinationConversationId: 'refused',
    source: { kind: 'conversation', conversationId: 'source' },
    artifactAuthorization: destinationAuthorization,
  } satisfies BranchAgentConversationInput;
  try {
    await refusedAtomically(store, base, 'foreign or missing file reference');
    await refusedAtomically(
      store,
      {
        ...base,
        applicationFiles: [
          { reference: 'attachments/other/image.png', destinationReference: 'granted' },
        ],
      },
      'foreign or missing file reference',
    );
    // One reference has one owner: a spill of the archive cannot be redeclared as the host's.
    await refusedAtomically(
      store,
      {
        ...base,
        applicationFiles: [
          { reference: attachment, destinationReference: 'granted' },
          { reference: spill, destinationReference: 'stolen' },
        ],
      },
      'also a spill reference',
    );
    await refusedAtomically(
      store,
      {
        ...base,
        applicationFiles: [
          { reference: attachment, destinationReference: 'granted' },
          { reference: attachment, destinationReference: 'again' },
        ],
      },
      'repeat a reference',
    );
    await refusedAtomically(
      store,
      {
        ...base,
        applicationFiles: [
          { reference: attachment, destinationReference: 'granted' },
          { reference: 'attachments/source/second.png', destinationReference: 'granted' },
        ],
      },
      'repeat a destinationReference',
    );

    // An undeclared reference only in the tail after the selected run still refuses:
    // the whole supplied history is understood before a prefix is chosen.
    await turn(
      store,
      {
        conversationId: 'source',
        id: 'second',
        parts: imageInput('attachments/source/later.png'),
      },
      [{ type: 'text', text: 'a later answer' }],
    );
    await refusedAtomically(
      store,
      {
        ...base,
        source: { kind: 'conversation', conversationId: 'source', throughRunId: 'first' },
        applicationFiles: [{ reference: attachment, destinationReference: 'granted' }],
      },
      'foreign or missing file reference',
    );
    // The host's own store was never touched by the runtime.
    expect([...host.files.keys()]).toEqual([attachment]);
  } finally {
    await sqlite.close();
    rmSync(directory, { recursive: true, force: true });
  }
});

test('the same request returns the same receipt; a different declaration conflicts', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'stitchkit-branch-files-'));
  const { sqlite } = await sourceOnDisk(directory);
  try {
    const request = {
      requestKey: 'once',
      destinationConversationId: 'copy',
      source: { kind: 'conversation', conversationId: 'source' },
      artifactAuthorization: destinationAuthorization,
      applicationFiles: [
        { reference: attachment, destinationReference: 'attachments/copy/a.png' },
      ],
    } satisfies BranchAgentConversationInput;
    const created = await branch(sqlite.store, request);
    expect(created.outcome).toBe('created');
    // The destination moves on; the retry still answers with the original receipt.
    await turn(
      sqlite.store,
      { conversationId: 'copy', id: 'next', parts: [{ type: 'text', text: 'continue' }] },
      [{ type: 'text', text: 'continued' }],
    );
    const duplicate = await branch(sqlite.store, request);
    expect(duplicate).toEqual({ outcome: 'duplicate', receipt: created.receipt });
    await expect(
      branch(sqlite.store, {
        ...request,
        applicationFiles: [
          { reference: attachment, destinationReference: 'attachments/copy/other.png' },
        ],
      }),
    ).rejects.toThrow('conflicts with the destination receipt');
    const image = (await sqlite.store.loadSnapshot('copy')).messages
      .flatMap((message) => message.parts)
      .find((part) => part.type === 'file');
    expect(image).toMatchObject({ reference: 'attachments/copy/a.png' });
  } finally {
    await sqlite.close();
    rmSync(directory, { recursive: true, force: true });
  }
});

test('the memory store branches the same archive the same way, and import keeps the original address', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'stitchkit-branch-files-'));
  const { sqlite } = await sourceOnDisk(directory);
  try {
    const archive = await sqlite.store.exportConversation('source');
    const memory = createMemoryAgentRuntimeStore();
    await branch(memory, {
      requestKey: 'memory',
      destinationConversationId: 'copy',
      source: { kind: 'archive', bytes: archive },
      artifactAuthorization: destinationAuthorization,
      applicationFiles: [
        { reference: attachment, destinationReference: 'attachments/copy/a.png' },
      ],
    });
    const copied = (await memory.loadSnapshot('copy')).messages.flatMap((m) => m.parts);
    expect(copied.find((part) => part.type === 'file')).toMatchObject({
      reference: 'attachments/copy/a.png',
    });

    // Import restores the same conversation, so its file parts keep their address.
    const imported = createMemoryAgentRuntimeStore();
    await imported.importConversation(archive);
    const restored = (await imported.loadSnapshot('source')).messages.flatMap((m) => m.parts);
    expect(restored.find((part) => part.type === 'file')).toMatchObject({
      reference: attachment,
    });
  } finally {
    await sqlite.close();
    rmSync(directory, { recursive: true, force: true });
  }
});

test('a key the application declares as its own data crosses a branch; a source identity under it does not', async () => {
  const store = createMemoryAgentRuntimeStore();
  const base = { conversationId: 'source', id: 'first' };
  await turn(store, { ...base, parts: [{ type: 'text', text: 'hello' }] }, [
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
    { ...request, applicationKeys: ['messageId'] },
    'opaque payload containing reference',
  );
  await branch(store, { ...request, applicationKeys: ['messageId', 'reference'] });
  const result = (await store.loadSnapshot('copy')).messages
    .flatMap((message) => message.parts)
    .find((part) => part.type === 'tool-result');
  expect(result).toMatchObject({
    output: { messageId: 'telegram-4242', ticket: { reference: 'CRM-17' } },
  });

  // Declared or not, a value that names the source's own run is a reference, not data.
  const leaking = createMemoryAgentRuntimeStore();
  await turn(leaking, { ...base, parts: [{ type: 'text', text: 'hello' }] }, [
    { type: 'tool-call', callId: 'call', toolName: 'note', input: { runId: 'first' } },
    { type: 'tool-result', callId: 'call', toolName: 'note', outcome: 'success', output: {} },
  ]);
  await refusedAtomically(
    leaking,
    { ...request, applicationKeys: ['runId'] },
    'source identity under the application key runId',
  );
});

test('the order of declarations is not part of the request', async () => {
  const store = createMemoryAgentRuntimeStore();
  await turn(
    store,
    {
      conversationId: 'source',
      id: 'first',
      parts: [
        { type: 'file', mediaType: 'image/png', reference: 'uploads/a.png' },
        { type: 'file', mediaType: 'image/png', reference: 'uploads/b.png' },
      ],
    },
    [{ type: 'text', text: 'two pictures' }],
  );
  const a = { reference: 'uploads/a.png', destinationReference: 'copy/a.png' };
  const b = { reference: 'uploads/b.png', destinationReference: 'copy/b.png' };
  const request = {
    requestKey: 'order',
    destinationConversationId: 'copy',
    source: { kind: 'conversation', conversationId: 'source' },
  } satisfies BranchAgentConversationInput;
  const created = await branch(store, {
    ...request,
    applicationFiles: [a, b],
    applicationKeys: ['messageId', 'reference'],
  });
  const again = await branch(store, {
    ...request,
    applicationFiles: [b, a],
    applicationKeys: ['reference', 'messageId', 'reference'],
  });
  expect(again).toEqual({ outcome: 'duplicate', receipt: created.receipt });
});
