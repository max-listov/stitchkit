import { describe, expect, test } from 'bun:test';
import {
  AgentConversationPurgedError,
  AgentMessageSchema,
  createMemoryAgentRuntimeStore,
  purgeAgentConversation,
} from '../src/agent-runtime';
import { createBunSqliteAgentRuntimeStore } from '../src/agent-runtime-sqlite-bun';
import {
  beginPurgeFixture,
  completePurgeFixture,
  purgeAdmission,
} from './fixtures/agent-purge';

const adapters = [
  {
    name: 'memory',
    open: () => ({ store: createMemoryAgentRuntimeStore(), close: async () => undefined }),
  },
  {
    name: 'Bun SQLite',
    open: () => createBunSqliteAgentRuntimeStore({ filename: ':memory:' }),
  },
];

for (const adapter of adapters) {
  describe(`conversation purge: ${adapter.name}`, () => {
    test('a delayed checkpoint cannot write after terminal commit and purge', async () => {
      const fixture = adapter.open();
      const release = Promise.withResolvers<void>();
      try {
        const { terminal } = await beginPurgeFixture(fixture.store);
        const checkpoint = release.promise.then(() =>
          fixture.store.checkpointRunAssistant({
            ...terminal,
            assistant: AgentMessageSchema.parse({
              ...terminal.assistant,
              status: 'streaming',
            }),
          }),
        );
        void checkpoint.catch(() => undefined);
        expect(
          (await purgeAgentConversation(fixture.store, { conversationId: 'target' })).outcome,
        ).toBe('active');
        expect(
          (await fixture.store.commitRunTerminal({ ...terminal, reason: 'success' })).outcome,
        ).toBe('applied');
        expect(
          (await purgeAgentConversation(fixture.store, { conversationId: 'target' })).outcome,
        ).toBe('purged');
        release.resolve();
        await expect(checkpoint).rejects.toBeInstanceOf(AgentConversationPurgedError);
        expect((await fixture.store.loadSnapshot('target')).messages).toEqual([]);
      } finally {
        release.resolve();
        await fixture.close();
      }
    });
    test('removes compacted and terminal history, isolates other conversations and reserves IDs', async () => {
      const fixture = adapter.open();
      try {
        const { admission, snapshot } = await completePurgeFixture(fixture.store);
        const other = await completePurgeFixture(fixture.store, 'other');
        const summary = AgentMessageSchema.parse({
          ...admission.input,
          id: 'summary',
          role: 'summary',
          parts: [{ type: 'text', text: 'private summary' }],
        });
        expect(
          (
            await fixture.store.replaceCompactedRange({
              conversationId: 'target',
              expectedVersion: snapshot.version,
              replacedMessageIds: snapshot.messages.map(({ id }) => id),
              summary,
            })
          ).outcome,
        ).toBe('applied');
        expect(
          await purgeAgentConversation(fixture.store, { conversationId: 'target' }),
        ).toEqual({ outcome: 'purged' });
        expect(await fixture.store.loadSnapshot('target')).toMatchObject({
          version: 0,
          messages: [],
          runs: [],
        });
        expect(
          await fixture.store.loadRun({ conversationId: 'target', runId: admission.run.id }),
        ).toBeUndefined();
        expect(await fixture.store.listActiveRuns('target')).toEqual([]);
        expect((await fixture.store.scanRecoverable({ limit: 10 })).items).toEqual([]);
        expect(await fixture.store.loadSnapshot('other')).toEqual(other.snapshot);
        expect(
          await purgeAgentConversation(fixture.store, {
            conversationId: 'target',
            expectedVersion: snapshot.version,
          }),
        ).toEqual({ outcome: 'already_purged' });
        await expect(fixture.store.acceptInputAndAssignRun(admission)).rejects.toBeInstanceOf(
          AgentConversationPurgedError,
        );
        await expect(
          fixture.store.acceptInputAndAssignRun(purgeAdmission('target', 'new')),
        ).rejects.toBeInstanceOf(AgentConversationPurgedError);
        expect(
          (await fixture.store.acceptInputAndAssignRun(purgeAdmission('fresh'))).outcome,
        ).toBe('applied');
      } finally {
        await fixture.close();
      }
    });

    test('refuses queued, running and interrupt-requested runs without changing data', async () => {
      const fixture = adapter.open();
      try {
        await fixture.store.acceptInputAndAssignRun(purgeAdmission());
        for (const state of ['queued', 'running', 'interrupt_requested']) {
          const before = await fixture.store.loadSnapshot('target');
          expect(String(before.runs[0]?.state)).toBe(state);
          expect(
            await purgeAgentConversation(fixture.store, { conversationId: 'target' }),
          ).toEqual({ outcome: 'active', runIds: ['run-1'] });
          expect(await fixture.store.loadSnapshot('target')).toEqual(before);
          if (state === 'queued')
            await fixture.store.acquireRun({
              conversationId: 'target',
              runId: 'run-1',
              expectedRevision: 0,
              ownerId: 'owner',
            });
          if (state === 'running')
            await fixture.store.requestRunInterrupt({
              conversationId: 'target',
              runId: 'run-1',
              expectedRevision: 1,
            });
        }
      } finally {
        await fixture.close();
      }
    });

    test('fences every stale mutation after deletion, including checkpoint and recovery', async () => {
      const fixture = adapter.open();
      try {
        const { terminal, snapshot } = await completePurgeFixture(fixture.store);
        await purgeAgentConversation(fixture.store, { conversationId: 'target' });
        const identity = { conversationId: 'target', runId: 'run-1', expectedRevision: 0 };
        for (const mutation of [
          () => fixture.store.acquireRun({ ...identity, ownerId: 'stale-owner' }),
          () => fixture.store.checkpointRunAssistant(terminal),
          () => fixture.store.commitRunTerminal({ ...terminal, reason: 'success' }),
          () => fixture.store.requestRunInterrupt(identity),
          () => fixture.store.recoverRun({ ...identity, action: 'requeue', replaySafe: true }),
          () =>
            fixture.store.replaceCompactedRange({
              conversationId: 'target',
              expectedVersion: snapshot.version,
              replacedMessageIds: ['input-1'],
              summary: terminal.assistant,
            }),
        ])
          await expect(mutation()).rejects.toBeInstanceOf(AgentConversationPurgedError);
        expect((await fixture.store.loadSnapshot('target')).messages).toEqual([]);
      } finally {
        await fixture.close();
      }
    });

    test('refuses stale versions, then serializes both admission/purge orders', async () => {
      const fixture = adapter.open();
      try {
        const completed = await completePurgeFixture(fixture.store);
        expect(
          await purgeAgentConversation(fixture.store, {
            conversationId: 'target',
            expectedVersion: 0,
          }),
        ).toEqual({ outcome: 'conflict', actualVersion: completed.snapshot.version });
        expect(await fixture.store.loadSnapshot('target')).toEqual(completed.snapshot);
        const accepted = fixture.store.acceptInputAndAssignRun(purgeAdmission('target', '2'));
        const refused = purgeAgentConversation(fixture.store, { conversationId: 'target' });
        expect((await accepted).outcome).toBe('applied');
        expect(await refused).toEqual({ outcome: 'active', runIds: ['run-2'] });
        const removed = purgeAgentConversation(fixture.store, {
          conversationId: 'unadmitted',
        });
        const late = fixture.store.acceptInputAndAssignRun(purgeAdmission('unadmitted'));
        await expect(late).rejects.toBeInstanceOf(AgentConversationPurgedError);
        expect(await removed).toEqual({ outcome: 'purged' });
      } finally {
        await fixture.close();
      }
    });
  });
}

test('unsupported stores remain source-compatible and fail explicitly without mutation', async () => {
  const { purgeConversation: _capability, ...store } = createMemoryAgentRuntimeStore();
  const completed = await completePurgeFixture(store);
  expect(await purgeAgentConversation(store, { conversationId: 'target' })).toEqual({
    outcome: 'unsupported',
  });
  expect(await store.loadSnapshot('target')).toEqual(completed.snapshot);
  await expect(purgeAgentConversation(store, { conversationId: '' })).rejects.toThrow();
});
