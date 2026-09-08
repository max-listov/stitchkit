import { Database } from 'bun:sqlite';
import { describe, expect, test } from 'bun:test';
import {
  createSqliteAgentRuntimeStore,
  type SqliteDatabase,
  type SqliteValue,
} from '../src/agent-runtime-sqlite-bun';

/** A connection whose SQLite was built without FTS5. */
function withoutFts5(): SqliteDatabase {
  const raw = new Database(':memory:');
  return {
    exec: (sql) => {
      if (/fts5/i.test(sql)) throw new Error('no such module: fts5');
      raw.exec(sql);
    },
    prepare(sql) {
      const statement = raw.query(sql);
      return {
        get: (...parameters: SqliteValue[]) => statement.get(...parameters),
        all: (...parameters: SqliteValue[]) => statement.all(...parameters),
        run: (...parameters: SqliteValue[]) => ({
          changes: statement.run(...parameters).changes,
        }),
      };
    },
    close: () => raw.close(),
  };
}

describe('SQLite without FTS5', () => {
  test('refuses to open with the reason named, rather than failing on the first search', () => {
    expect(() => createSqliteAgentRuntimeStore({ database: withoutFts5() })).toThrow(
      'requires FTS5 support',
    );
  });
});

describe('the SQLite transaction scope', () => {
  test('refuses a store call from inside itself instead of hanging', async () => {
    const raw = new Database(':memory:');
    const database: SqliteDatabase = {
      exec: (sql) => raw.exec(sql),
      prepare(sql) {
        const statement = raw.query(sql);
        return {
          get: (...parameters: SqliteValue[]) => statement.get(...parameters),
          all: (...parameters: SqliteValue[]) => statement.all(...parameters),
          run: (...parameters: SqliteValue[]) => ({
            changes: statement.run(...parameters).changes,
          }),
        };
      },
      close: () => raw.close(),
    };
    const handle = createSqliteAgentRuntimeStore({ database });
    await expect(
      handle.transaction(() => handle.store.readEvents({ conversationId: 'x', limit: 1 })),
    ).rejects.toThrow('inside its own transaction scope');
    await handle.close();
  });
});
