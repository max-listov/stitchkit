import { afterEach, describe, expect, test } from 'bun:test';
import { rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { AgentMessageSchema, AgentRunSchema } from '../src/agent-runtime';
import type { AgentRuntimeStore } from '../src/agent-runtime/store';
import { createMemoryAgentRuntimeStore } from '../src/agent-runtime/store-driver';
import { createBunSqliteAgentRuntimeStore } from '../src/agent-runtime-sqlite-bun';

const paths: string[] = [];

function databasePath(label: string): string {
  const path = join(tmpdir(), `stitchkit-${label}-${crypto.randomUUID()}.sqlite`);
  paths.push(path);
  return path;
}

afterEach(async () => {
  await Promise.all(paths.splice(0).map((path) => rm(path, { force: true })));
});

const at = '2026-09-08T00:00:00.000Z';

function input(conversationId: string, id: string) {
  return AgentMessageSchema.parse({
    schemaVersion: 1,
    id,
    conversationId,
    role: 'user',
    status: 'committed',
    parts: [{ type: 'text', text: id }],
    createdAt: at,
    updatedAt: at,
  });
}

function queuedRun(conversationId: string, inputMessageId: string, id: string) {
  return AgentRunSchema.parse({
    schemaVersion: 1,
    id,
    conversationId,
    inputMessageIds: [inputMessageId],
    assistantMessageId: `${id}-assistant`,
    state: 'queued',
    revision: 0,
    createdAt: at,
    updatedAt: at,
  });
}

/** One accepted turn plus a plain event: a conversation that actually happened. */
async function seed(store: AgentRuntimeStore, conversationId: string): Promise<void> {
  await store.acceptInputAndAssignRun({
    idempotencyKey: 'request-1',
    input: input(conversationId, 'input-1'),
    run: queuedRun(conversationId, 'input-1', 'run-1'),
  });
  await store.appendEvent({
    conversationId,
    kind: 'state/set',
    payload: { name: 'topic', value: 'archive' },
  });
}

describe('agent conversation archive round trip', () => {
  /**
   * The defect this pins: the SQLite head compare-and-swap read its outcome
   * from the driver's `changes`, which counts the FTS5 index rows the event
   * trigger wrote earlier in the same transaction. Every archive whose
   * snapshot carried a run — that is, every conversation with a turn in it —
   * was refused by a store that had just reported the target empty.
   */
  test('imports a conversation that has a run into a fresh SQLite store', async () => {
    const source = createBunSqliteAgentRuntimeStore({
      filename: databasePath('archive-source'),
    });
    const target = createBunSqliteAgentRuntimeStore({
      filename: databasePath('archive-target'),
    });
    try {
      await seed(source.store, 'with-run');
      const before = await target.store.loadSnapshot('with-run');
      expect({
        version: before.version,
        messages: before.messages.length,
        runs: before.runs.length,
      }).toEqual({ version: 0, messages: 0, runs: 0 });

      const bytes = await source.store.exportConversation('with-run');
      expect(await target.store.importConversation(bytes)).toEqual({
        conversationId: 'with-run',
        events: 2,
      });

      const restored = await target.store.loadSnapshot('with-run');
      expect(restored).toEqual(await source.store.loadSnapshot('with-run'));
      const events = await target.store.readEvents({ conversationId: 'with-run', limit: 10 });
      expect(events.items.map((event) => event.kind)).toEqual([
        'runtime/transition',
        'state/set',
      ]);
      expect(await target.store.exportConversation('with-run')).toEqual(bytes);
    } finally {
      await source.close();
      await target.close();
    }
  });

  test('imports the same conversation into the memory reference store', async () => {
    const source = createMemoryAgentRuntimeStore();
    const target = createMemoryAgentRuntimeStore();
    await seed(source, 'with-run');
    const bytes = await source.exportConversation('with-run');
    expect(await target.importConversation(bytes)).toEqual({
      conversationId: 'with-run',
      events: 2,
    });
    expect(await target.loadSnapshot('with-run')).toEqual(
      await source.loadSnapshot('with-run'),
    );
  });

  test('still refuses a target whose event log is not empty', async () => {
    const source = createBunSqliteAgentRuntimeStore({
      filename: databasePath('archive-busy-a'),
    });
    const target = createBunSqliteAgentRuntimeStore({
      filename: databasePath('archive-busy-b'),
    });
    try {
      await seed(source.store, 'with-run');
      await seed(target.store, 'with-run');
      const bytes = await source.store.exportConversation('with-run');
      await expect(target.store.importConversation(bytes)).rejects.toThrow(
        'Conversation event log must be empty before import',
      );
    } finally {
      await source.close();
      await target.close();
    }
  });
});
