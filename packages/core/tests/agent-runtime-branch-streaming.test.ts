import { expect, test } from 'bun:test';
import { z } from 'zod';
import {
  AgentStoreTransitionRecordSchema,
  agentSummaryProjection,
  createMemoryAgentRuntimeStore,
  createSqliteAgentProjectionStore,
  decodeAgentConversationArchive,
} from '../src/entrypoints/agent-runtime';
import { createBunSqliteAgentRuntimeStore } from '../src/entrypoints/agent-runtime/sqlite/bun';
import { branch } from './support/agent-branch-fixture';
import { branchRuntime } from './support/agent-branch-runtime-fixture';

test('public SQLite streaming export with companion projection branches and restores without importing caches', async () => {
  const sqlite = createBunSqliteAgentRuntimeStore({ filename: ':memory:' });
  const runtime = branchRuntime(sqlite.store);
  try {
    await runtime.submit({
      conversationId: 'source',
      idempotencyKey: 'stream',
      context: {},
      parts: [{ type: 'text', text: 'retain streamed context' }],
      metadata: {},
    }).result;
    const projections = createSqliteAgentProjectionStore({ sqlite });
    await projections.advance('source', agentSummaryProjection);
    const bytes = await sqlite.store.exportConversation('source');
    const archive = decodeAgentConversationArchive(bytes);
    expect(archive.projections).toHaveLength(2);
    expect(
      archive.events.some(
        (event) =>
          event.kind === 'runtime/transition' &&
          JSON.stringify(event.payload).includes('"sha256"'),
      ),
    ).toBe(true);
    for (const event of archive.events) {
      if (event.kind === 'runtime/transition')
        expect(z.json().parse(AgentStoreTransitionRecordSchema.parse(event.payload))).toEqual(
          event.payload,
        );
    }
    const imported = createMemoryAgentRuntimeStore();
    await imported.importConversation(bytes);
    expect((await imported.loadSnapshot('source')).messages).toHaveLength(2);
    const original = await sqlite.store.loadSnapshot('source');
    const runId = original.runs[0]?.id;
    expect(runId).toBeDefined();
    const created = await branch(sqlite.store, {
      requestKey: 'stream-copy',
      destinationConversationId: 'copy',
      source: { kind: 'conversation', conversationId: 'source', throughRunId: runId },
    });
    const restored = createMemoryAgentRuntimeStore();
    await branch(restored, {
      requestKey: 'stream-restore',
      destinationConversationId: 'restore',
      source: { kind: 'archive', bytes },
    });
    for (const [store, id] of [
      [sqlite.store, 'copy'],
      [restored, 'restore'],
    ] satisfies [typeof restored, string][]) {
      const snapshot = await store.loadSnapshot(id);
      expect(snapshot.messages.map((message) => message.parts)).toEqual(
        original.messages.map((message) => message.parts),
      );
      expect(
        snapshot.runs.every((run) => !run.ownerId && run.fencingToken === undefined),
      ).toBe(true);
      expect(
        snapshot.messages.every(
          (message) => !original.messages.some((source) => source.id === message.id),
        ),
      ).toBe(true);
    }
    expect(projections.load('copy', agentSummaryProjection)).toBeUndefined();
    expect(
      (await projections.advance('copy', agentSummaryProjection)).value.eventCount,
    ).toBeGreaterThan(0);
    expect(await sqlite.store.exportConversation('source')).toEqual(bytes);
    expect(
      await branch(sqlite.store, {
        requestKey: 'stream-copy',
        destinationConversationId: 'copy',
        source: { kind: 'conversation', conversationId: 'source', throughRunId: runId },
      }),
    ).toEqual({ outcome: 'duplicate', receipt: created.receipt });
  } finally {
    await runtime.close();
    await sqlite.close();
  }
});
