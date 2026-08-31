import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import {
  AgentConversationPurgedError,
  AgentConversationPurgeInputSchema,
  AgentConversationPurgeResultSchema,
  AgentMessageSchema,
  AgentRunSchema,
  createMemoryAgentRuntimeStore,
  purgeAgentConversation,
} from 'stitchkit/agent-runtime';

// Built-in SQLite bindings are conditional runtime leaves, not interchangeable imports.
const sqliteModule = process.versions.bun
  ? await import('stitchkit/agent-runtime/sqlite/bun')
  : await import('stitchkit/agent-runtime/sqlite/node');
const open = process.versions.bun
  ? sqliteModule.createBunSqliteAgentRuntimeStore
  : sqliteModule.createNodeSqliteAgentRuntimeStore;
const Database = process.versions.bun
  ? (await import('bun:sqlite')).Database
  : (await import('node:sqlite')).DatabaseSync;

function admission(conversationId, suffix = '1') {
  const timestamp = '2026-08-31T00:00:00.000Z';
  const input = AgentMessageSchema.parse({
    schemaVersion: 1,
    id: `input-${suffix}`,
    conversationId,
    role: 'user',
    status: 'committed',
    parts: [{ type: 'text', text: 'retained payload' }],
    createdAt: timestamp,
    updatedAt: timestamp,
  });
  const run = AgentRunSchema.parse({
    schemaVersion: 1,
    id: `run-${suffix}`,
    conversationId,
    inputMessageIds: [input.id],
    assistantMessageId: `assistant-${suffix}`,
    state: 'queued',
    revision: 0,
    createdAt: timestamp,
    updatedAt: timestamp,
  });
  return { input, run, idempotencyKey: `key-${suffix}` };
}

async function exercise(store) {
  const input = admission('target');
  assert.equal((await store.acceptInputAndAssignRun(input)).outcome, 'applied');
  assert.deepEqual(await purgeAgentConversation(store, { conversationId: 'target' }), {
    outcome: 'active',
    runIds: ['run-1'],
  });
  assert.equal(
    (
      await store.recoverRun({
        conversationId: 'target',
        runId: 'run-1',
        expectedRevision: 0,
        action: 'abandon',
      })
    ).outcome,
    'applied',
  );
  const other = admission('other');
  await store.acceptInputAndAssignRun(other);
  const before = await store.loadSnapshot('other');
  const current = await store.loadSnapshot('target');
  assert.equal(
    (await purgeAgentConversation(store, { conversationId: 'target', expectedVersion: 0 }))
      .outcome,
    'conflict',
  );
  const request = AgentConversationPurgeInputSchema.parse({
    conversationId: 'target',
    expectedVersion: current.version,
  });
  assert.deepEqual(
    AgentConversationPurgeResultSchema.parse(await purgeAgentConversation(store, request)),
    { outcome: 'purged' },
  );
  assert.deepEqual((await store.loadSnapshot('target')).messages, []);
  assert.equal(await store.loadRun({ conversationId: 'target', runId: 'run-1' }), undefined);
  assert.deepEqual(await store.loadSnapshot('other'), before);
  assert.deepEqual(
    (await store.scanRecoverable({ limit: 10 })).items.map(
      ({ conversationId }) => conversationId,
    ),
    ['other'],
  );
  await assert.rejects(store.acceptInputAndAssignRun(input), AgentConversationPurgedError);
  await assert.rejects(
    store.acceptInputAndAssignRun(admission('target', 'new')),
    AgentConversationPurgedError,
  );
  await assert.rejects(
    store.recoverRun({
      conversationId: 'target',
      runId: 'run-1',
      expectedRevision: 0,
      action: 'requeue',
    }),
    AgentConversationPurgedError,
  );
  assert.deepEqual(await purgeAgentConversation(store, request), {
    outcome: 'already_purged',
  });
  const removeFirst = purgeAgentConversation(store, { conversationId: 'absent' });
  await assert.rejects(
    store.acceptInputAndAssignRun(admission('absent')),
    AgentConversationPurgedError,
  );
  assert.equal((await removeFirst).outcome, 'purged');
}

await exercise(createMemoryAgentRuntimeStore());
const { purgeConversation: _purge, ...unsupported } = createMemoryAgentRuntimeStore();
assert.deepEqual(await purgeAgentConversation(unsupported, { conversationId: 'target' }), {
  outcome: 'unsupported',
});
const root = await mkdtemp(path.join(tmpdir(), 'stitchkit-packed-purge-'));
const filename = path.join(root, 'runtime.sqlite');
let handle = open({ filename });
try {
  await exercise(handle.store);
  assert.deepEqual(
    (await handle.conversations.list({ limit: 10 })).items.map(
      ({ conversationId }) => conversationId,
    ),
    ['other'],
  );
  assert.deepEqual(
    (
      await handle.conversations.messages({
        conversationId: 'target',
        direction: 'before',
        limit: 10,
      })
    ).items,
    [],
  );
  await handle.close();
  handle = open({ filename });
  assert.deepEqual(await purgeAgentConversation(handle.store, { conversationId: 'target' }), {
    outcome: 'already_purged',
  });
  await assert.rejects(
    handle.store.acceptInputAndAssignRun(admission('target')),
    AgentConversationPurgedError,
  );
  await handle.close();

  // Exercise real binding rollback and reopen after a mid-delete storage error.
  const db = new Database(filename);
  let inject = true;
  const boundary = {
    exec: (sql) => db.exec(sql),
    prepare(sql) {
      const statement = db.prepare(sql);
      return {
        get: (...values) => statement.get(...values),
        all: (...values) => statement.all(...values),
        run(...values) {
          const result = statement.run(...values);
          if (inject && sql.startsWith('DELETE FROM stitchkit_agent_runtime_admissions'))
            throw new Error('injected purge failure');
          return { changes: Number(result.changes) };
        },
      };
    },
    close: () => db.close(),
  };
  handle = sqliteModule.createSqliteAgentRuntimeStore({ database: boundary });
  await handle.store.recoverRun({
    conversationId: 'other',
    runId: 'run-1',
    expectedRevision: 0,
    action: 'abandon',
  });
  const snapshot = await handle.store.loadSnapshot('other');
  await assert.rejects(
    purgeAgentConversation(handle.store, { conversationId: 'other' }),
    /injected purge failure/,
  );
  inject = false;
  await handle.close();
  handle = open({ filename });
  assert.deepEqual(await handle.store.loadSnapshot('other'), snapshot);
  assert.equal(
    (await handle.store.acceptInputAndAssignRun(admission('other'))).outcome,
    'duplicate',
  );
  assert.deepEqual(await purgeAgentConversation(handle.store, { conversationId: 'other' }), {
    outcome: 'purged',
  });
  console.log(`packed conversation purge: ok (${process.versions.bun ? 'bun' : 'node'})`);
} finally {
  await handle.close();
  await rm(root, { recursive: true, force: true });
}
