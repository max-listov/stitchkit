import { expect, test } from 'bun:test';
import { createHash } from 'node:crypto';
import { z } from 'zod';
import { createSqliteAgentSpillStore } from '../src/agent-runtime/spill';
import { createBunSqliteAgentRuntimeStore } from '../src/agent-runtime/sqlite-bun';
import {
  createMemoryAgentRuntimeStore,
  decodeAgentConversationArchive,
  encodeAgentConversationArchive,
} from '../src/entrypoints/agent-runtime';
import { branch, branchTurn } from './support/agent-branch-fixture';
import { branchRuntime } from './support/agent-branch-runtime-fixture';

test('spills rekey once, use fresh policy and stay private to the destination in SQLite and memory archives', async () => {
  const sqlite = createBunSqliteAgentRuntimeStore({ filename: ':memory:' });
  try {
    const sourceSpills = createSqliteAgentSpillStore({
      sqlite,
      conversationId: 'source',
      runId: 'first',
      toolCallId: 'call',
    });
    const { reference } = await sourceSpills.write({
      data: new TextEncoder().encode('full artifact payload'),
      mediaType: 'text/plain',
      authorization: { operation: 'read', path: 'source-only' },
    });
    await branchTurn(sqlite.store, 'source', 'first', [
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
      { type: 'file', reference, mediaType: 'text/plain' },
      { type: 'file', reference, mediaType: 'text/plain' },
    ]);
    const bytes = await sqlite.store.exportConversation('source');
    for (const store of [sqlite.store, createMemoryAgentRuntimeStore()]) {
      const request = {
        requestKey: 'artifact',
        destinationConversationId: 'copy',
        source: { kind: 'archive', bytes },
      } satisfies Parameters<typeof branch>[1];
      await expect(branch(store, request)).rejects.toThrow(
        'fresh destination artifact authorization',
      );
      expect((await store.loadSnapshot('copy')).version).toBe(0);
      await branch(store, {
        ...request,
        artifactAuthorization: { operation: 'read', path: 'destination-only' },
      });
      const snapshot = await store.loadSnapshot('copy');
      const files = snapshot.messages.flatMap((message) =>
        message.parts.filter((part) => part.type === 'file'),
      );
      expect(files).toHaveLength(2);
      expect(files[0]?.reference).toBe(files[1]?.reference);
      expect(files[0]?.reference).not.toBe(reference);
      const archive = decodeAgentConversationArchive(await store.exportConversation('copy'));
      expect(archive.spills).toHaveLength(1);
      const spill = z
        .object({ reference: z.string(), authorization: z.json(), base64: z.string() })
        .parse(archive.spills[0]);
      expect(spill.authorization).toEqual({ operation: 'read', path: 'destination-only' });
      expect(Buffer.from(spill.base64, 'base64').toString()).toBe('full artifact payload');
      const runtime = branchRuntime(store);
      try {
        await runtime.submit({
          conversationId: 'copy',
          idempotencyKey: 'observe-artifact',
          context: {},
          metadata: {},
          parts: [{ type: 'text', text: 'continue' }],
        }).result;
      } finally {
        await runtime.close();
      }
      // Rebranching validates a prior receipt without reviving its historical leases.
      await branch(store, {
        requestKey: 'again',
        destinationConversationId: 'again',
        source: { kind: 'conversation', conversationId: 'copy' },
        artifactAuthorization: { operation: 'read', path: 'another-policy' },
      });
    }
    const copied = createSqliteAgentSpillStore({ sqlite, conversationId: 'copy' });
    await expect(copied.read({ reference, offset: 0, maxBytes: 100 })).rejects.toThrow();
    const snapshot = await sqlite.store.loadSnapshot('copy');
    const file = snapshot.messages
      .flatMap((message) => message.parts)
      .find((part) => part.type === 'file');
    if (file?.type !== 'file') throw new Error('Missing copied artifact');
    expect(
      new TextDecoder().decode(
        (await copied.read({ reference: file.reference, offset: 0, maxBytes: 100 })).data,
      ),
    ).toBe('full artifact payload');
    expect(await copied.authorization?.(file.reference)).toEqual({
      operation: 'read',
      path: 'destination-only',
    });
    await expect(
      sourceSpills.read({ reference: file.reference, offset: 0, maxBytes: 100 }),
    ).rejects.toThrow();
  } finally {
    await sqlite.close();
  }
});

test('refuses corrupt and missing artifacts, foreign run references and unresolved opaque reference fields atomically', async () => {
  const store = createMemoryAgentRuntimeStore();
  await branchTurn(store, 'source', 'first');
  const original = decodeAgentConversationArchive(await store.exportConversation('source'));
  const data = Buffer.from('artifact');
  const spill = {
    reference: 'ref',
    runId: 'foreign',
    bytes: data.byteLength,
    sha256: createHash('sha256').update(data).digest('hex'),
    base64: data.toString('base64'),
    mediaType: 'text/plain',
    createdAt: '2026-10-15T00:00:00.000Z',
  };
  const event = {
    schemaVersion: 1,
    eventId: 'spill-event',
    conversationId: 'source',
    seq: 4,
    kind: 'spill/created',
    occurredAt: spill.createdAt,
    payload: { reference: 'ref', bytes: spill.bytes, sha256: spill.sha256 },
  };
  for (const [index, archive] of [
    { ...original, events: [...original.events, event], spills: [spill] },
    {
      ...original,
      events: [...original.events, event],
      spills: [
        { ...spill, runId: 'first', base64: Buffer.from('corrupt!').toString('base64') },
      ],
    },
    { ...original, events: [...original.events, event] },
  ].entries()) {
    const id = `bad-${index}`;
    await expect(
      branch(store, {
        requestKey: id,
        destinationConversationId: id,
        source: { kind: 'archive', bytes: encodeAgentConversationArchive(archive) },
        artifactAuthorization: { operation: 'read', path: 'dest' },
      }),
    ).rejects.toThrow();
    expect((await store.readEvents({ conversationId: id, limit: 10 })).items).toHaveLength(0);
  }
  await branchTurn(store, 'opaque', 'opaque', [
    {
      type: 'tool-call',
      callId: 'call',
      toolName: 'unknown',
      input: { reference: 'hidden-address' },
    },
    {
      type: 'tool-result',
      callId: 'call',
      toolName: 'unknown',
      outcome: 'success',
      output: {},
    },
  ]);
  await expect(
    branch(store, {
      requestKey: 'opaque',
      destinationConversationId: 'opaque-copy',
      source: { kind: 'conversation', conversationId: 'opaque' },
    }),
  ).rejects.toThrow('opaque');
  expect((await store.loadSnapshot('opaque-copy')).version).toBe(0);
});
