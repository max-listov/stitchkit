import { Database } from 'bun:sqlite';
import { afterEach, describe, expect, test } from 'bun:test';
import { rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { AgentMessageSchema, AgentRunSchema } from '../src/agent-runtime';
import {
  type AgentRuntimeSqliteDatabase,
  type AgentRuntimeSqliteValue,
  createBunSqliteAgentRuntimeStore,
  createSqliteAgentRuntimeStore,
} from '../src/agent-runtime-sqlite-bun';
import { runAgentStoreConformance } from '../src/testing';

const paths: string[] = [];

function databasePath(label: string): string {
  const path = join(tmpdir(), `stitchkit-${label}-${crypto.randomUUID()}.sqlite`);
  paths.push(path);
  return path;
}

afterEach(async () => {
  await Promise.all(paths.splice(0).map((path) => rm(path, { force: true })));
});

function input(conversationId: string, id: string) {
  return AgentMessageSchema.parse({
    schemaVersion: 1,
    id,
    conversationId,
    role: 'user',
    status: 'committed',
    parts: [{ type: 'text', text: id }],
    createdAt: '2026-08-28T00:00:00.000Z',
    updatedAt: '2026-08-28T00:00:00.000Z',
  });
}

function run(conversationId: string, inputMessageId: string, id: string) {
  return AgentRunSchema.parse({
    schemaVersion: 1,
    id,
    conversationId,
    inputMessageIds: [inputMessageId],
    assistantMessageId: `${id}-assistant`,
    state: 'queued',
    revision: 0,
    createdAt: '2026-08-28T00:00:00.000Z',
    updatedAt: '2026-08-28T00:00:00.000Z',
  });
}

describe('SQLite agent-runtime store', () => {
  test('passes the public store conformance suite and closes its connection', async () => {
    const fixture = createBunSqliteAgentRuntimeStore({
      filename: databasePath('conformance'),
    });
    await runAgentStoreConformance({
      createStore: () => fixture.store,
      cleanup: () => fixture.close(),
    });
  });

  test('survives close and reopen without a memory or JSON fallback', async () => {
    const filename = databasePath('reopen');
    const first = createBunSqliteAgentRuntimeStore({ filename });
    const message = input('reopen-conversation', 'input-1');
    await first.store.acceptInputAndAssignRun({
      idempotencyKey: 'request-1',
      input: message,
      run: run(message.conversationId, message.id, 'run-1'),
    });
    await first.close();

    const second = createBunSqliteAgentRuntimeStore({ filename });
    const snapshot = await second.store.loadSnapshot(message.conversationId);
    expect(snapshot.version).toBe(1);
    expect(snapshot.messages.map(({ id }) => id)).toEqual(['input-1']);
    expect(snapshot.runs.map(({ id }) => id)).toEqual(['run-1']);
    expect((await second.store.scanRecoverable({ limit: 10 })).items).toHaveLength(1);
    await second.close();
  });

  test('pages conversation summaries and active history through an optional reader', async () => {
    const fixture = createBunSqliteAgentRuntimeStore({ filename: databasePath('reader') });
    const records: [string, string, string][] = [
      ['alpha', 'alpha-1', 'run-alpha-1'],
      ['alpha', 'alpha-2', 'run-alpha-2'],
      ['beta', 'beta-1', 'run-beta-1'],
    ];
    for (const [conversationId, messageId, runId] of records) {
      const message = input(conversationId, messageId);
      await fixture.store.acceptInputAndAssignRun({
        idempotencyKey: `${conversationId}:${messageId}`,
        input: message,
        run: run(conversationId, messageId, runId),
      });
    }

    const first = await fixture.conversations.list({ limit: 1 });
    expect(first.items).toEqual([
      expect.objectContaining({
        conversationId: 'alpha',
        version: 2,
        preview: 'alpha-2',
        activeRuns: 2,
      }),
    ]);
    expect(first.nextCursor).toBeDefined();
    expect(await fixture.conversations.list({ cursor: first.nextCursor, limit: 1 })).toEqual({
      items: [
        expect.objectContaining({
          conversationId: 'beta',
          version: 1,
          preview: 'beta-1',
          activeRuns: 1,
        }),
      ],
    });

    const latest = await fixture.conversations.messages({
      conversationId: 'alpha',
      limit: 1,
      direction: 'before',
    });
    expect(latest.items.map(({ id }) => id)).toEqual(['alpha-2']);
    expect(latest.nextCursor).toBeDefined();
    expect(
      await fixture.conversations.messages({
        conversationId: 'alpha',
        cursor: latest.nextCursor,
        limit: 1,
        direction: 'before',
      }),
    ).toMatchObject({ items: [{ id: 'alpha-1' }] });
    await fixture.close();
  });

  test('fails competing same-thread writers promptly and permits a deterministic retry', async () => {
    const filename = databasePath('contention');
    const firstDatabase = new Database(filename, { create: true, readwrite: true });
    firstDatabase.exec('PRAGMA busy_timeout = 0');
    const firstWriteLock = Promise.withResolvers<void>();
    const firstBoundary: AgentRuntimeSqliteDatabase = {
      exec(sql) {
        firstDatabase.exec(sql);
        if (sql === 'BEGIN IMMEDIATE') firstWriteLock.resolve();
      },
      prepare(sql) {
        const statement = firstDatabase.query(sql);
        return {
          get: (...parameters: AgentRuntimeSqliteValue[]) => statement.get(...parameters),
          all: (...parameters: AgentRuntimeSqliteValue[]) => statement.all(...parameters),
          run: (...parameters: AgentRuntimeSqliteValue[]) => {
            const result = statement.run(...parameters);
            return { changes: result.changes };
          },
        };
      },
      close: () => firstDatabase.close(),
    };
    const first = createSqliteAgentRuntimeStore({ database: firstBoundary });
    const second = createBunSqliteAgentRuntimeStore({ filename });
    const firstMessage = input('contention-a', 'input-a');
    const secondMessage = input('contention-b', 'input-b');
    const firstAttempt = first.store.acceptInputAndAssignRun({
      idempotencyKey: 'request-a',
      input: firstMessage,
      run: run(firstMessage.conversationId, firstMessage.id, 'run-a'),
    });
    await firstWriteLock.promise;
    const attempts = await Promise.allSettled([
      firstAttempt,
      second.store.acceptInputAndAssignRun({
        idempotencyKey: 'request-b',
        input: secondMessage,
        run: run(secondMessage.conversationId, secondMessage.id, 'run-b'),
      }),
    ]);
    expect(attempts.filter(({ status }) => status === 'fulfilled')).toHaveLength(1);
    const rejected = attempts.find(({ status }) => status === 'rejected');
    expect(rejected).toBeDefined();
    if (rejected?.status !== 'rejected') throw new Error('contention fixture did not reject');
    expect(String(rejected.reason)).toContain('locked');

    const retryStore = attempts[0]?.status === 'rejected' ? first.store : second.store;
    const retryMessage = attempts[0]?.status === 'rejected' ? firstMessage : secondMessage;
    const retryRunId = attempts[0]?.status === 'rejected' ? 'run-a' : 'run-b';
    expect(
      (
        await retryStore.acceptInputAndAssignRun({
          idempotencyKey: attempts[0]?.status === 'rejected' ? 'request-a' : 'request-b',
          input: retryMessage,
          run: run(retryMessage.conversationId, retryMessage.id, retryRunId),
        })
      ).outcome,
    ).toBe('applied');
    await Promise.all([first.close(), second.close()]);
  });

  test('restores acquired and urgent queue order after reopen', async () => {
    const filename = databasePath('priority-reopen');
    const first = createBunSqliteAgentRuntimeStore({ filename });
    const conversationId = 'priority-reopen';
    const messageA = input(conversationId, 'input-a');
    const admittedA = await first.store.acceptInputAndAssignRun({
      idempotencyKey: 'request-a',
      input: messageA,
      run: run(conversationId, messageA.id, 'run-a'),
    });
    if (admittedA.outcome !== 'applied') throw new Error('A was not admitted');
    const runA = admittedA.snapshot.runs.find(({ id }) => id === 'run-a');
    if (!runA) throw new Error('A disappeared');
    await first.store.acquireRun({
      conversationId,
      runId: runA.id,
      expectedRevision: runA.revision,
      ownerId: 'fixture-owner',
    });
    const messageB = input(conversationId, 'input-b');
    await first.store.acceptInputAndAssignRun({
      idempotencyKey: 'request-b',
      input: messageB,
      run: run(conversationId, messageB.id, 'run-b'),
    });
    const messageC = input(conversationId, 'input-c');
    await first.store.acceptInputAndAssignRun({
      idempotencyKey: 'request-c',
      input: messageC,
      run: AgentRunSchema.parse({
        ...run(conversationId, messageC.id, 'run-c'),
        queuePriority: 'interrupt-next',
      }),
    });
    await first.close();

    const reopened = createBunSqliteAgentRuntimeStore({ filename });
    expect(
      (await reopened.store.loadSnapshot(conversationId)).runs.map(({ id }) => id),
    ).toEqual(['run-a', 'run-c', 'run-b']);
    await reopened.close();
  });

  test('rolls back every normalized row when a transaction fails after history apply', async () => {
    const filename = databasePath('rollback');
    const database = new Database(filename, { create: true, readwrite: true });
    let failHistoryWrite = true;
    const boundary: AgentRuntimeSqliteDatabase = {
      exec: (sql) => database.exec(sql),
      prepare(sql) {
        const statement = database.query(sql);
        return {
          get: (...parameters: AgentRuntimeSqliteValue[]) => statement.get(...parameters),
          all: (...parameters: AgentRuntimeSqliteValue[]) => statement.all(...parameters),
          run: (...parameters: AgentRuntimeSqliteValue[]) => {
            const result = statement.run(...parameters);
            if (
              failHistoryWrite &&
              sql.includes('INSERT INTO stitchkit_agent_runtime_messages')
            ) {
              failHistoryWrite = false;
              throw new Error('injected history failure');
            }
            return { changes: result.changes };
          },
        };
      },
      close: () => database.close(),
    };
    const fixture = createSqliteAgentRuntimeStore({ database: boundary });
    const message = input('rollback-conversation', 'input-1');
    await expect(
      fixture.store.acceptInputAndAssignRun({
        idempotencyKey: 'request-1',
        input: message,
        run: run(message.conversationId, message.id, 'run-1'),
      }),
    ).rejects.toThrow('injected history failure');
    expect(await fixture.store.loadSnapshot(message.conversationId)).toMatchObject({
      version: 0,
      messages: [],
      runs: [],
    });
    await fixture.close();
  });

  test('close drains accepted operations and then refuses new work', async () => {
    const fixture = createBunSqliteAgentRuntimeStore({ filename: databasePath('close') });
    const message = input('close-conversation', 'input-1');
    const operation = fixture.store.acceptInputAndAssignRun({
      idempotencyKey: 'request-1',
      input: message,
      run: run(message.conversationId, message.id, 'run-1'),
    });
    const closing = fixture.close();
    expect((await operation).outcome).toBe('applied');
    await closing;
    await expect(fixture.store.loadSnapshot(message.conversationId)).rejects.toThrow(
      'closing',
    );
  });

  test('refuses unknown and partial owned schemas without touching application tables', () => {
    const unknownPath = databasePath('unknown-schema');
    const unknown = new Database(unknownPath, { create: true, readwrite: true });
    unknown.exec(`
      CREATE TABLE application_rows (id TEXT PRIMARY KEY);
      INSERT INTO application_rows (id) VALUES ('kept');
      CREATE TABLE stitchkit_agent_runtime_meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);
      INSERT INTO stitchkit_agent_runtime_meta (key, value) VALUES ('schema_version', '2');
    `);
    unknown.close();
    expect(() => createBunSqliteAgentRuntimeStore({ filename: unknownPath })).toThrow(
      'Unsupported Stitchkit agent-runtime SQLite schema version 2',
    );
    const verifyUnknown = new Database(unknownPath, { readwrite: true });
    expect(verifyUnknown.query('SELECT id FROM application_rows').get()).toEqual({
      id: 'kept',
    });
    verifyUnknown.close();

    const partialPath = databasePath('partial-schema');
    const partial = new Database(partialPath, { create: true, readwrite: true });
    partial.exec(
      'CREATE TABLE stitchkit_agent_runtime_heads (conversation_id TEXT PRIMARY KEY)',
    );
    partial.close();
    expect(() => createBunSqliteAgentRuntimeStore({ filename: partialPath })).toThrow(
      'unversioned partial',
    );
  });
});
