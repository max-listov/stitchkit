import { Database } from 'bun:sqlite';
import { afterEach, describe, expect, test } from 'bun:test';
import { rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { z } from 'zod';
import { AgentMessageSchema, AgentRunSchema } from '../src/agent-runtime';
import {
  createBunSqliteAgentRuntimeStore,
  type SqliteAgentRuntimeStore,
} from '../src/agent-runtime-sqlite-bun';

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
const conversationId = 'conversation-1';

function message(id: string, role: 'user' | 'assistant' | 'summary') {
  return AgentMessageSchema.parse({
    schemaVersion: 1,
    id,
    conversationId,
    role,
    status: 'committed',
    parts: [{ type: 'text', text: id }],
    createdAt: at,
    updatedAt: at,
  });
}

/** Four messages, then a summary that replaces the first three. */
async function compactedConversation(fixture: SqliteAgentRuntimeStore): Promise<void> {
  const store = fixture.store;
  for (const index of [1, 2, 3, 4]) {
    const accepted = await store.acceptInputAndAssignRun({
      idempotencyKey: `request-${index}`,
      input: message(`input-${index}`, 'user'),
      run: AgentRunSchema.parse({
        schemaVersion: 1,
        id: `run-${index}`,
        conversationId,
        inputMessageIds: [`input-${index}`],
        assistantMessageId: `run-${index}-assistant`,
        state: 'queued',
        revision: 0,
        createdAt: at,
        updatedAt: at,
      }),
    });
    expect(accepted.outcome).toBe('applied');
  }
  const snapshot = await store.loadSnapshot(conversationId);
  const compacted = await store.replaceCompactedRange({
    conversationId,
    expectedVersion: snapshot.version,
    replacedMessageIds: ['input-1', 'input-2', 'input-3'],
    summary: message('summary-1', 'summary'),
  });
  expect(compacted.outcome).toBe('applied');
}

describe('reading the history compaction removed', () => {
  test('the model view is unchanged and the person view is complete', async () => {
    const fixture = createBunSqliteAgentRuntimeStore({
      filename: databasePath('compacted-read'),
    });
    try {
      await compactedConversation(fixture);

      const model = await fixture.conversations.messages({
        conversationId,
        limit: 100,
        direction: 'after',
      });
      expect(model.items.map((item) => item.id)).toEqual(['summary-1', 'input-4']);
      expect(model.compacted).toEqual([]);

      const person = await fixture.conversations.messages({
        conversationId,
        limit: 100,
        direction: 'after',
        includeCompacted: true,
      });
      expect(person.items.map((item) => item.id)).toEqual([
        'input-1',
        'summary-1',
        'input-2',
        'input-3',
        'input-4',
      ]);
      // The boundary compaction drew, named on the same sequence.
      expect(person.compacted).toEqual(['input-1', 'input-2', 'input-3']);
      // The snapshot the model runs on never sees them.
      const snapshot = await fixture.store.loadSnapshot(conversationId);
      expect(snapshot.messages.map((item) => item.id)).toEqual(['summary-1', 'input-4']);
    } finally {
      await fixture.close();
    }
  });

  test('pages the full history one message at a time in both directions', async () => {
    const fixture = createBunSqliteAgentRuntimeStore({
      filename: databasePath('compacted-page'),
    });
    try {
      await compactedConversation(fixture);
      const expected = ['input-1', 'summary-1', 'input-2', 'input-3', 'input-4'];

      const forward: string[] = [];
      let cursor: string | undefined;
      for (let guard = 0; guard < 10; guard += 1) {
        const page = await fixture.conversations.messages({
          conversationId,
          limit: 1,
          direction: 'after',
          includeCompacted: true,
          ...(cursor && { cursor }),
        });
        forward.push(...page.items.map((item) => item.id));
        if (!page.nextCursor) break;
        cursor = page.nextCursor;
      }
      // A shared position — the summary sits where the first replaced message
      // did — used to make one of these repeat or vanish.
      expect(forward).toEqual(expected);

      const backward: string[] = [];
      cursor = undefined;
      for (let guard = 0; guard < 10; guard += 1) {
        const page = await fixture.conversations.messages({
          conversationId,
          limit: 1,
          direction: 'before',
          includeCompacted: true,
          ...(cursor && { cursor }),
        });
        backward.unshift(...page.items.map((item) => item.id));
        if (!page.nextCursor) break;
        cursor = page.nextCursor;
      }
      expect(backward).toEqual(expected);
    } finally {
      await fixture.close();
    }
  });
});

describe('the v1 baseline carries the compacted history', () => {
  test('a migrated file can reconstruct what compaction removed', async () => {
    const filename = databasePath('v1-compacted');
    const first = createBunSqliteAgentRuntimeStore({ filename });
    await compactedConversation(first);
    await first.close();

    const v1 = new Database(filename, { readwrite: true });
    v1.exec(`
      DROP TABLE stitchkit_agent_runtime_events_fts;
      DROP TABLE stitchkit_agent_runtime_events;
      DROP TABLE stitchkit_agent_runtime_projections;
      DROP TABLE stitchkit_agent_runtime_spills;
      DROP TABLE stitchkit_agent_runtime_schedules;
      DROP TABLE stitchkit_agent_runtime_children;
      UPDATE stitchkit_agent_runtime_meta SET value = '1' WHERE key = 'schema_version';
    `);
    v1.close();

    const migrated = createBunSqliteAgentRuntimeStore({ filename });
    try {
      const events = await migrated.store.readEvents({ conversationId, limit: 10 });
      expect(events.items[0]).toMatchObject({ kind: 'runtime/baseline', seq: 1 });
      const payload = z
        .object({
          messages: z.array(z.object({ id: z.string() }).loose()),
          compacted: z.array(z.string()),
        })
        .loose()
        .parse(events.items[0]?.payload);
      // Without the compacted rows the ledger could not answer what the person
      // said, while the normalized table still held it.
      expect(payload.messages.map((item) => item.id)).toEqual([
        'input-1',
        'summary-1',
        'input-2',
        'input-3',
        'input-4',
      ]);
      expect(payload.compacted).toEqual(['input-1', 'input-2', 'input-3']);
    } finally {
      await migrated.close();
    }
  });
});
