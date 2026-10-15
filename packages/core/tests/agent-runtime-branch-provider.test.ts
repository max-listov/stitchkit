import { expect, test } from 'bun:test';
import { createHash } from 'node:crypto';
import { z } from 'zod';
import { ProviderJournalMessageSchema } from '../src/agent-runtime/provider-journal';
import { canonicalAgentJson } from '../src/agent-runtime/store-events';
import {
  createMemoryAgentRuntimeStore,
  decodeAgentConversationArchive,
  encodeAgentConversationArchive,
  projectAgentHistory,
} from '../src/entrypoints/agent-runtime';
import { branch, branchTurn } from './support/agent-branch-fixture';

const options = { example: { signature: 'provider-signature', cache: { type: 'ephemeral' } } };
const hash = (value: unknown) =>
  createHash('sha256').update(canonicalAgentJson(value)).digest('hex');

async function fixture() {
  const store = createMemoryAgentRuntimeStore();
  const provider = { schemaVersion: 1, provider: 'ai-sdk', data: options };
  const snapshot = await branchTurn(store, 'source', 'run', [
    { type: 'reasoning', text: 'thinking', provider },
    { type: 'tool-call', callId: 'call', toolName: 'example', input: {}, provider },
    {
      type: 'tool-result',
      callId: 'call',
      toolName: 'example',
      outcome: 'success',
      output: 1,
    },
    { type: 'text', text: 'answer' },
  ]);
  for (const message of await projectAgentHistory(snapshot.messages))
    await store.appendEvent({
      conversationId: 'source',
      kind: 'provider/message',
      payload: z.json().parse({ message, sha256: hash(message) }),
    });
  const message = {
    role: 'assistant',
    content: [{ type: 'text', text: 'answer', providerOptions: options }],
  };
  await store.appendEvent({
    conversationId: 'source',
    kind: 'provider/message',
    payload: { message, sha256: hash(message) },
  });
  return store;
}

test('provider journal metadata survives branch and archive restore without changing source bytes', async () => {
  const store = await fixture();
  const bytes = await store.exportConversation('source');
  for (const source of [
    { kind: 'conversation', conversationId: 'source' },
    { kind: 'archive', bytes },
  ] satisfies Parameters<typeof branch>[1]['source'][]) {
    const id = source.kind;
    await branch(store, { requestKey: id, destinationConversationId: id, source });
    const archive = decodeAgentConversationArchive(await store.exportConversation(id));
    for (const event of archive.events) {
      if (event.kind !== 'provider/message') continue;
      const record = ProviderJournalMessageSchema.parse(event.payload);
      expect(record.sha256).toBe(hash(record.message));
      if (typeof record.message.content === 'string') continue;
      for (const part of record.message.content) {
        if ('providerOptions' in part && part.providerOptions)
          expect(part.providerOptions).toEqual(options);
        if (part.type === 'tool-call') expect(part.toolCallId).not.toBe('call');
      }
    }
    expect(
      (await store.loadSnapshot(id)).runs.every(
        (run) => !run.ownerId && run.fencingToken === undefined,
      ),
    ).toBe(true);
  }
  expect(await store.exportConversation('source')).toEqual(bytes);
});

for (const defect of [
  'unknown',
  'hash',
  'identity',
  'metadata-identity',
  'request',
  'tagged-file',
  'file-reference',
  'binary-reference',
])
  test(`provider ${defect} refusal is atomic and leaves the source intact`, async () => {
    const store = await fixture();
    const original = await store.exportConversation('source');
    const archive = decodeAgentConversationArchive(original);
    const message = {
      role: 'assistant',
      content: [
        ...(defect === 'tagged-file' ||
        defect === 'file-reference' ||
        defect === 'binary-reference'
          ? [
              {
                type: 'file',
                mediaType: 'text/plain',
                data:
                  defect === 'tagged-file'
                    ? { type: 'text', text: 'inline', undocumented: 'extra' }
                    : defect === 'binary-reference'
                      ? { binary: 'provider', runId: 'foreign' }
                      : { type: 'reference', reference: { runId: 'foreign' } },
              },
            ]
          : []),
        {
          type: 'text',
          text: 'answer',
          providerOptions:
            defect === 'metadata-identity' ? { example: { runId: 'foreign' } } : options,
          ...(defect === 'unknown' && { unknown: true }),
        },
        ...(defect === 'identity'
          ? [{ type: 'tool-call', toolCallId: 'foreign', toolName: 'example', input: {} }]
          : []),
      ],
    };
    const last = archive.events.at(-1);
    if (!last) throw new Error('missing fixture journal');
    archive.events.push({
      ...last,
      seq: last.seq + 1,
      eventId: `bad-${defect}`,
      kind: defect === 'request' ? 'provider/request' : 'provider/message',
      payload:
        defect === 'request'
          ? {
              runId: 'run',
              attempt: 1,
              stepNumber: 0,
              modelId: 'test',
              instructionsSha256: '0'.repeat(64),
              messageShas: [],
              bodySha256: '0'.repeat(64),
            }
          : z
              .json()
              .parse({ message, sha256: defect === 'hash' ? '0'.repeat(64) : hash(message) }),
    });
    await expect(
      branch(store, {
        requestKey: defect,
        destinationConversationId: 'negative',
        source: { kind: 'archive', bytes: encodeAgentConversationArchive(archive) },
      }),
    ).rejects.toThrow(
      defect === 'unknown'
        ? 'Unrecognized key'
        : defect === 'tagged-file'
          ? 'Invalid input'
          : defect === 'identity'
            ? 'foreign or missing call'
            : defect === 'metadata-identity' ||
                defect === 'file-reference' ||
                defect === 'binary-reference'
              ? 'opaque payload'
              : 'digest is inconsistent',
    );
    expect(await store.loadSnapshot('negative')).toMatchObject({
      version: 0,
      messages: [],
      runs: [],
    });
    expect(await store.exportConversation('source')).toEqual(original);
  });
