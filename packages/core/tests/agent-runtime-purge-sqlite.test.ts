import { Database } from 'bun:sqlite';
import { expect, test } from 'bun:test';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { AgentConversationPurgedError, purgeAgentConversation } from '../src/agent-runtime';
import {
  createBunSqliteAgentRuntimeStore,
  createSqliteAgentRuntimeStore,
  type SqliteDatabase,
} from '../src/agent-runtime-sqlite-bun';
import { completePurgeFixture, purgeAdmission } from './fixtures/agent-purge';

const tables = ['messages', 'admissions', 'runs', 'heads'];

test('SQLite purge rolls back after each deletion and commit failure, then survives reopen', async () => {
  const root = await mkdtemp(join(tmpdir(), 'stitchkit-purge-'));
  const filename = join(root, 'runtime.sqlite');
  const database = new Database(filename);
  let failAt = '';
  const boundary: SqliteDatabase = {
    exec(sql) {
      if (failAt === 'commit' && sql === 'COMMIT') throw new Error('injected commit failure');
      database.exec(sql);
    },
    prepare(sql) {
      const statement = database.query(sql);
      return {
        get: (...values) => statement.get(...values),
        all: (...values) => statement.all(...values),
        run: (...values) => {
          const result = statement.run(...values);
          if (
            failAt &&
            sql === `DELETE FROM stitchkit_agent_runtime_${failAt} WHERE conversation_id = ?`
          ) {
            throw new Error(`injected ${failAt} failure`);
          }
          return result;
        },
      };
    },
    close: () => database.close(),
  };
  let fixture = createSqliteAgentRuntimeStore({ database: boundary });
  try {
    const { admission, snapshot } = await completePurgeFixture(fixture.store);
    const other = await completePurgeFixture(fixture.store, 'other');
    for (const table of tables)
      database.exec(
        `CREATE TEMP TABLE prior_${table} AS SELECT * FROM stitchkit_agent_runtime_${table} WHERE conversation_id = 'target'`,
      );
    database.exec(
      "CREATE TABLE application_data (id TEXT); INSERT INTO application_data VALUES ('keep')",
    );
    for (const phase of [...tables, 'commit']) {
      failAt = phase;
      await expect(
        purgeAgentConversation(fixture.store, { conversationId: 'target' }),
      ).rejects.toThrow(`injected ${phase} failure`);
      failAt = '';
      expect(await fixture.store.loadSnapshot('target')).toEqual(snapshot);
      expect((await fixture.store.acceptInputAndAssignRun(admission)).outcome).toBe(
        'duplicate',
      );
      expect(database.query('SELECT * FROM stitchkit_agent_runtime_purged').all()).toEqual([]);
    }
    expect(
      await purgeAgentConversation(fixture.store, {
        conversationId: 'target',
        expectedVersion: snapshot.version,
      }),
    ).toEqual({ outcome: 'purged' });
    for (const table of tables) {
      expect(
        database
          .query(`SELECT * FROM stitchkit_agent_runtime_${table} WHERE conversation_id = ?`)
          .all('target'),
      ).toEqual([]);
    }
    expect(database.query('SELECT * FROM stitchkit_agent_runtime_purged').all()).toEqual([
      { conversation_id: 'target' },
    ]);
    expect(database.query('SELECT * FROM application_data').all()).toEqual([{ id: 'keep' }]);
    // Existing writers cannot bypass the new reducer by using the v1 INSERT/UPDATE SQL.
    expect(() =>
      database
        .query('INSERT INTO stitchkit_agent_runtime_heads VALUES (?, ?)')
        .run('target', 1),
    ).toThrow('purged');
    for (const table of tables) {
      expect(() =>
        database
          .query(
            `UPDATE stitchkit_agent_runtime_${table} SET conversation_id = ? WHERE conversation_id = ?`,
          )
          .run('target', 'other'),
      ).toThrow('purged');
      expect(() =>
        database
          .query(`INSERT INTO stitchkit_agent_runtime_${table} SELECT * FROM prior_${table}`)
          .run(),
      ).toThrow('purged');
    }
    expect(await fixture.store.loadSnapshot('other')).toEqual(other.snapshot);
    expect(
      (await fixture.conversations.list({ limit: 10 })).items.map(
        ({ conversationId }) => conversationId,
      ),
    ).toEqual(['other']);
    expect(
      (
        await fixture.conversations.messages({
          conversationId: 'target',
          direction: 'before',
          limit: 10,
        })
      ).items,
    ).toEqual([]);
    await fixture.close();
    fixture = createBunSqliteAgentRuntimeStore({ filename });
    expect(await purgeAgentConversation(fixture.store, { conversationId: 'target' })).toEqual({
      outcome: 'already_purged',
    });
    await expect(fixture.store.acceptInputAndAssignRun(admission)).rejects.toBeInstanceOf(
      AgentConversationPurgedError,
    );
    expect((await fixture.store.scanRecoverable({ limit: 10 })).items).toEqual([]);
  } finally {
    await fixture.close();
    await rm(root, { recursive: true, force: true });
  }
});

test('competing SQLite connection cannot submit through an in-flight purge transaction', async () => {
  const root = await mkdtemp(join(tmpdir(), 'stitchkit-purge-race-'));
  const filename = join(root, 'runtime.sqlite');
  const first = createBunSqliteAgentRuntimeStore({ filename });
  const second = createBunSqliteAgentRuntimeStore({ filename });
  try {
    const removed = purgeAgentConversation(first.store, { conversationId: 'target' });
    const submitted = second.store.acceptInputAndAssignRun(purgeAdmission());
    await expect(submitted).rejects.toThrow('locked');
    expect(await removed).toEqual({ outcome: 'purged' });
    await expect(
      second.store.acceptInputAndAssignRun(purgeAdmission()),
    ).rejects.toBeInstanceOf(AgentConversationPurgedError);
    expect((await second.store.loadSnapshot('target')).messages).toEqual([]);
  } finally {
    await first.close();
    await second.close();
    await rm(root, { recursive: true, force: true });
  }
});

test('additive v1 initialization fences an already-open pre-purge writer', async () => {
  const root = await mkdtemp(join(tmpdir(), 'stitchkit-purge-migration-'));
  const filename = join(root, 'runtime.sqlite');
  const initialized = createBunSqliteAgentRuntimeStore({ filename });
  await initialized.close();
  const schema = new Database(filename);
  // Construct the original v1 schema; no private table layout is needed by a consumer.
  for (const table of tables) {
    for (const operation of ['insert', 'update'])
      schema.exec(`DROP TRIGGER stitchkit_agent_runtime_${table}_purge_${operation}`);
  }
  schema.exec('DROP TABLE stitchkit_agent_runtime_purged');
  schema.close();
  const oldWriter = createBunSqliteAgentRuntimeStore({ filename, initialize: false });
  try {
    const completed = await completePurgeFixture(oldWriter.store);
    expect(
      await purgeAgentConversation(oldWriter.store, { conversationId: 'target' }),
    ).toEqual({ outcome: 'unsupported' });
    const upgraded = createBunSqliteAgentRuntimeStore({ filename });
    try {
      expect(await upgraded.store.loadSnapshot('target')).toEqual(completed.snapshot);
      expect(
        await purgeAgentConversation(upgraded.store, { conversationId: 'target' }),
      ).toEqual({ outcome: 'purged' });
      await expect(oldWriter.store.acceptInputAndAssignRun(purgeAdmission())).rejects.toThrow(
        'purged',
      );
      expect((await upgraded.store.loadSnapshot('target')).messages).toEqual([]);
      expect(
        (await oldWriter.store.acceptInputAndAssignRun(purgeAdmission('other'))).outcome,
      ).toBe('applied');
    } finally {
      await upgraded.close();
    }
  } finally {
    await oldWriter.close();
    await rm(root, { recursive: true, force: true });
  }
});
