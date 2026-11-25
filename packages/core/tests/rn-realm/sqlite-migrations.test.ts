import { Database } from 'bun:sqlite';
import { expect, test } from 'bun:test';
import { join } from 'node:path';
import type { AsyncSqliteConnection } from '../../src/application/sqlite-migrations';
import { bundleBrowserIife, CORE_SRC, createRnRealm } from './rn-realm';

const bundle = bundleBrowserIife(`
  import { defineSqliteMigrations, runSqliteMigrations, runSqliteMigrationsAsync }
    from ${JSON.stringify(join(CORE_SRC, 'entrypoints/application.ts'))};
  const run = { scope: 'phone', migrations: Object.freeze(defineSqliteMigrations([
    { version: 10, name: 'seed', statements: ["INSERT INTO items VALUES ('seed')"] },
    { version: 2, name: 'items', statements: ['CREATE TABLE items (label TEXT NOT NULL)'] },
  ])) };
  globalThis.migrate = () => globalThis.asyncConnection
    ? runSqliteMigrationsAsync(globalThis.asyncConnection, run)
    : runSqliteMigrations(globalThis.database, run);
`);

test.each(['sync', 'async'])(
  '%s SQLite migrations run in version order without toSorted',
  async (mode) => {
    using database = new Database(':memory:');
    const realm = createRnRealm();
    // Match the Hermes Array prototype in this isolated realm, leaving the host untouched.
    realm.evaluate('delete Array.prototype.toSorted');
    realm.context.database = database;
    if (mode === 'async') {
      const connection: AsyncSqliteConnection = {
        exec: async (sql) => {
          database.exec(sql);
        },
        all: async (sql) => database.prepare(sql).all(),
        run: async (sql, ...args) => {
          database.prepare(sql).run(...args);
        },
      };
      realm.context.asyncConnection = connection;
    }
    realm.evaluate(await bundle);
    const migrate =
      realm.evaluate<() => readonly number[] | Promise<readonly number[]>>('migrate');
    expect(await migrate()).toEqual([2, 10]);
    expect(await migrate()).toEqual([]);
    expect(database.query('SELECT label FROM items').all()).toEqual([{ label: 'seed' }]);
  },
);
