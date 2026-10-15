import { describe, expect, test } from 'bun:test';
import { createBunSqliteAgentRuntimeStore } from '../src/agent-runtime/sqlite-bun';
import {
  type AgentConversationArchive,
  AgentMessageSchema,
  createMemoryAgentRuntimeStore,
  decodeAgentConversationArchive,
  encodeAgentConversationArchive,
} from '../src/entrypoints/agent-runtime';
import { branch, branchInput, branchTurn } from './support/agent-branch-fixture';

for (const adapter of ['memory', 'sqlite'])
  describe(`${adapter} independent conversation branches`, () => {
    function fixture() {
      const sqlite =
        adapter === 'sqlite'
          ? createBunSqliteAgentRuntimeStore({ filename: ':memory:' })
          : undefined;
      return {
        store: sqlite?.store ?? createMemoryAgentRuntimeStore(),
        close: () => sqlite?.close(),
      };
    }

    test('branches an exact middle, keeps source bytes and continues under a fresh identity', async () => {
      const { store, close } = fixture();
      try {
        await branchTurn(store, 'source', 'first');
        await branchTurn(store, 'source', 'second');
        const before = await store.exportConversation('source');
        const result = await branch(store, {
          requestKey: 'middle',
          destinationConversationId: 'middle',
          source: { kind: 'conversation', conversationId: 'source', throughRunId: 'first' },
        });
        expect(result.outcome).toBe('created');
        expect(result.receipt).toMatchObject({
          sourceSeq: 3,
          sourceVersion: 3,
          throughRunId: 'first',
        });
        const snapshot = await store.loadSnapshot('middle');
        expect(snapshot.messages.map((message) => message.parts)).toEqual([
          [{ type: 'text', text: 'input-first' }],
          [{ type: 'text', text: 'answer first' }],
        ]);
        expect(snapshot.runs).toHaveLength(1);
        expect(snapshot.runs[0]?.id).not.toBe('first');
        expect(snapshot.runs[0]?.ownerId).toBeUndefined();
        expect(snapshot.runs[0]?.fencingToken).toBeUndefined();
        expect(await store.exportConversation('source')).toEqual(before);
        await branchTurn(store, 'middle', 'next');
        expect((await store.loadSnapshot('middle')).messages).toHaveLength(4);
        expect(await store.listActiveRuns('middle')).toHaveLength(0);
      } finally {
        await close();
      }
    });

    test('restores a validated archive and retains compacted history without executing tools', async () => {
      const { store, close } = fixture();
      try {
        const first = await branchTurn(store, 'source', 'first', [
          {
            type: 'tool-call',
            callId: 'call',
            toolName: 'example',
            input: { value: 'input-first' },
          },
          {
            type: 'tool-result',
            callId: 'call',
            toolName: 'example',
            outcome: 'success',
            output: { value: 'stored output' },
          },
        ]);
        await store.replaceCompactedRange({
          conversationId: 'source',
          expectedVersion: first.version,
          replacedMessageIds: first.messages.map((message) => message.id),
          summary: AgentMessageSchema.parse({
            ...branchInput('source', 'summary'),
            role: 'summary',
            parts: [{ type: 'text', text: 'summary' }],
          }),
        });
        await branchTurn(store, 'source', 'second');
        const bytes = await store.exportConversation('source');
        await branch(store, {
          requestKey: 'restore',
          destinationConversationId: 'restore',
          source: { kind: 'archive', bytes },
        });
        const snapshot = await store.loadSnapshot('restore');
        expect(snapshot.messages.map((message) => message.role)).toEqual([
          'summary',
          'user',
          'assistant',
        ]);
        const archive = decodeAgentConversationArchive(
          await store.exportConversation('restore'),
        );
        expect(JSON.stringify(archive.events)).toContain('stored output');
        expect(JSON.stringify(archive.events)).not.toContain('"callId":"call"');
        expect(archive.events).toHaveLength(8);
        await branchTurn(store, 'restore', 'after-restore');
        expect((await store.loadSnapshot('restore')).messages).toHaveLength(5);
      } finally {
        await close();
      }
    });

    test('serializes duplicates and refuses changed requests without partial state', async () => {
      const { store, close } = fixture();
      try {
        await branchTurn(store, 'source', 'first');
        const input = {
          requestKey: 'same',
          destinationConversationId: 'copy',
          source: { kind: 'conversation', conversationId: 'source' },
        } satisfies Parameters<typeof branch>[1];
        const results = await Promise.all([branch(store, input), branch(store, input)]);
        expect(results.map((result) => result.outcome).sort()).toEqual([
          'created',
          'duplicate',
        ]);
        expect(results[0]?.receipt).toEqual(results[1]?.receipt);
        const before = await store.exportConversation('copy');
        await expect(branch(store, { ...input, requestKey: 'other' })).rejects.toThrow(
          'conflicts',
        );
        expect(await store.exportConversation('copy')).toEqual(before);
        await branchTurn(store, 'source', 'later');
        expect((await branch(store, input)).receipt).toEqual(results[0]?.receipt);
      } finally {
        await close();
      }
    });

    test('refuses truncated, corrupt, foreign and unknown payload archives before mutation', async () => {
      const { store, close } = fixture();
      try {
        await branchTurn(store, 'source', 'first');
        const archive = decodeAgentConversationArchive(
          await store.exportConversation('source'),
        );
        const corruptions: AgentConversationArchive[] = [
          { ...archive, events: archive.events.slice(0, -1) },
          { ...archive, projections: [] },
          {
            ...archive,
            events: archive.events.map((event, index) =>
              index === 0 ? { ...event, conversationId: 'foreign' } : event,
            ),
          },
          { ...archive, projections: [...archive.projections, { name: 'opaque', value: {} }] },
          {
            ...archive,
            events: archive.events.map((event, index) =>
              index === 0 ? { ...event, kind: 'future/unknown', ignorable: true } : event,
            ),
          },
        ];
        for (const [index, corrupt] of corruptions.entries()) {
          const destinationConversationId = `bad-${index}`;
          await expect(
            branch(store, {
              requestKey: 'bad',
              destinationConversationId,
              source: { kind: 'archive', bytes: encodeAgentConversationArchive(corrupt) },
            }),
          ).rejects.toThrow();
          expect((await store.loadSnapshot(destinationConversationId)).version).toBe(0);
          expect(
            (await store.readEvents({ conversationId: destinationConversationId, limit: 10 }))
              .items,
          ).toEqual([]);
        }
      } finally {
        await close();
      }
    });
  });
