import { expect, test } from 'bun:test';
import { createHash } from 'node:crypto';
import { z } from 'zod';
import { canonicalAgentJson } from '../src/agent-runtime/store-events';
import {
  createMemoryAgentRuntimeStore,
  decodeAgentConversationArchive,
  encodeAgentConversationArchive,
  projectAgentHistory,
} from '../src/entrypoints/agent-runtime';
import { branch, branchTurn } from './support/agent-branch-fixture';
import { branchRuntime } from './support/agent-branch-runtime-fixture';

test('archive fingerprint and clone bind the same owned bytes despite caller mutation', async () => {
  const store = createMemoryAgentRuntimeStore();
  await branchTurn(store, 'source', 'first');
  const original = await store.exportConversation('source');
  const mutable = Uint8Array.from(original);
  const changed = new TextEncoder().encode(
    new TextDecoder().decode(original).replaceAll('answer first', 'CHANGED TEXT'),
  );
  expect(changed.byteLength).toBe(mutable.byteLength);
  const request = {
    requestKey: 'bytes',
    destinationConversationId: 'copy',
    source: { kind: 'archive', bytes: mutable },
  } satisfies Parameters<typeof branch>[1];
  const pending = branch(store, request);
  mutable.set(changed);
  const result = await pending;
  expect(JSON.stringify(await store.loadSnapshot('copy'))).toContain('answer first');
  expect(JSON.stringify(await store.loadSnapshot('copy'))).not.toContain('CHANGED TEXT');
  const duplicate = await branch(store, {
    ...request,
    source: { kind: 'archive', bytes: original },
  });
  expect(duplicate).toEqual({ outcome: 'duplicate', receipt: result.receipt });
  await expect(branch(store, request)).rejects.toThrow('conflicts');
});

test('unknown opaque tail is refused even when the requested middle predates it', async () => {
  const original = createMemoryAgentRuntimeStore();
  await expect(
    branch(original, {
      requestKey: 'absent',
      destinationConversationId: 'absent-copy',
      source: { kind: 'conversation', conversationId: 'absent' },
    }),
  ).rejects.toThrow('not found');
  await branchTurn(original, 'source', 'first');
  await branchTurn(original, 'source', 'second');
  await branch(original, {
    requestKey: 'positive',
    destinationConversationId: 'positive',
    source: { kind: 'conversation', conversationId: 'source', throughRunId: 'first' },
  });
  const archive = decodeAgentConversationArchive(await original.exportConversation('source'));
  archive.events.push({
    schemaVersion: 1,
    eventId: 'future',
    conversationId: 'source',
    seq: 7,
    kind: 'future/opaque',
    ignorable: true,
    occurredAt: '2026-10-15T00:00:00.000Z',
    payload: { reference: 'foreign' },
  });
  const imported = createMemoryAgentRuntimeStore();
  await imported.importConversation(encodeAgentConversationArchive(archive));
  await expect(
    branch(imported, {
      requestKey: 'negative',
      destinationConversationId: 'negative',
      source: { kind: 'conversation', conversationId: 'source', throughRunId: 'first' },
    }),
  ).rejects.toThrow('opaque event');
  expect((await imported.loadSnapshot('negative')).version).toBe(0);
});

test('hash-only checkpoint usage cannot silently erase an opaque future field', async () => {
  const store = createMemoryAgentRuntimeStore();
  const runtime = branchRuntime(store);
  try {
    await runtime.submit({
      conversationId: 'source',
      idempotencyKey: 'first',
      context: {},
      metadata: {},
      parts: [{ type: 'text', text: 'go' }],
    }).result;
  } finally {
    await runtime.close();
  }
  const archive = decodeAgentConversationArchive(await store.exportConversation('source'));
  let changed = 0;
  archive.events = archive.events.map((event) => {
    if (event.kind !== 'runtime/transition') return event;
    const parsed = z
      .object({
        type: z.literal('checkpoint'),
        input: z.object({ usage: z.record(z.string(), z.json()).optional() }).passthrough(),
      })
      .passthrough()
      .safeParse(event.payload);
    if (!parsed.success) return event;
    changed++;
    return {
      ...event,
      payload: z.json().parse({
        ...parsed.data,
        input: {
          ...parsed.data.input,
          usage: {
            inputTokens: { provenance: 'unavailable' },
            outputTokens: { provenance: 'unavailable' },
            ...parsed.data.input.usage,
            futureOpaque: { reference: 'hidden-source-ref' },
          },
        },
      }),
    };
  });
  expect(changed).toBeGreaterThan(0);
  await expect(
    branch(store, {
      requestKey: 'opaque',
      destinationConversationId: 'negative',
      source: { kind: 'archive', bytes: encodeAgentConversationArchive(archive) },
    }),
  ).rejects.toThrow('unknown opaque field');
  expect((await store.loadSnapshot('negative')).version).toBe(0);
});

test('known provider approvals rekey and lose signatures, while structured error references refuse', async () => {
  const store = createMemoryAgentRuntimeStore();
  const snapshot = await branchTurn(store, 'source', 'first', [
    { type: 'tool-call', callId: 'call', toolName: 'example', input: {} },
    {
      type: 'tool-approval-request',
      approvalId: 'approval',
      callId: 'call',
      signature: 'source-secret-signature',
      isAutomatic: true,
    },
    { type: 'tool-approval-response', approvalId: 'approval', approved: true },
    {
      type: 'tool-result',
      callId: 'call',
      toolName: 'example',
      outcome: 'success',
      output: 'evidence',
    },
  ]);
  for (const message of await projectAgentHistory(snapshot.messages))
    await store.appendEvent({
      conversationId: 'source',
      kind: 'provider/message',
      payload: z.json().parse({
        message,
        sha256: createHash('sha256').update(canonicalAgentJson(message)).digest('hex'),
      }),
    });
  await branch(store, {
    requestKey: 'approval',
    destinationConversationId: 'positive',
    source: { kind: 'conversation', conversationId: 'source' },
  });
  const positive = new TextDecoder().decode(await store.exportConversation('positive'));
  expect(positive).not.toContain('source-secret-signature');
  expect(positive).not.toContain('"approvalId":"approval"');
  const message = {
    role: 'tool',
    content: [
      {
        type: 'tool-result',
        toolCallId: 'call',
        toolName: 'example',
        output: { type: 'error-json', value: { reference: 'foreign' } },
      },
    ],
  };
  await store.appendEvent({
    conversationId: 'source',
    kind: 'provider/message',
    payload: {
      message,
      sha256: createHash('sha256').update(canonicalAgentJson(message)).digest('hex'),
    },
  });
  await expect(
    branch(store, {
      requestKey: 'error',
      destinationConversationId: 'negative',
      source: { kind: 'conversation', conversationId: 'source' },
    }),
  ).rejects.toThrow('opaque payload');
  expect((await store.loadSnapshot('negative')).version).toBe(0);
});
