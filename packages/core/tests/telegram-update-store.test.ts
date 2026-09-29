/**
 * `stitchkit/telegram` update stores: every shipped store keeps the rules of
 * `TelegramUpdateStore`, checked by the same `checkTelegramUpdateStore` an
 * application runs on its own. Postgres runs in the `test:postgres-stores`
 * lane, which sets `TELEGRAM_STORE_DATABASE_URL`; without it those rules are
 * skipped here and nowhere else.
 */
import { Database } from 'bun:sqlite';
import { afterAll, describe, expect, test } from 'bun:test';
import { SQL } from 'bun';
import {
  checkTelegramUpdateStore,
  memoryTelegramUpdateStore,
  postgresTelegramUpdateStore,
  postgresTelegramUpdateStoreSchema,
  sqliteTelegramUpdateStore,
  type TelegramPostgresQuery,
  type TelegramUpdateStore,
} from '../src/entrypoints/telegram';

// `node:sqlite` exists in Node 22.5+ and in Bun from 1.4; a Bun that predates it
// runs the rules on the other stores instead of failing the file.
const nodeSqlite = await import('node:sqlite').catch(() => undefined);
const postgresUrl = Bun.env.TELEGRAM_STORE_DATABASE_URL;

describe('telegram update stores keep the rules', () => {
  test('memory', async () => {
    expect(await checkTelegramUpdateStore(memoryTelegramUpdateStore)).toEqual([]);
  });

  test('bun:sqlite', async () => {
    expect(
      await checkTelegramUpdateStore(() =>
        sqliteTelegramUpdateStore({ database: new Database(':memory:') }),
      ),
    ).toEqual([]);
  });

  test.skipIf(nodeSqlite === undefined)('node:sqlite', async () => {
    if (!nodeSqlite) return;
    expect(
      await checkTelegramUpdateStore(() =>
        sqliteTelegramUpdateStore({ database: new nodeSqlite.DatabaseSync(':memory:') }),
      ),
    ).toEqual([]);
  });
});

describe('the check refuses a store that breaks them', () => {
  test('a claim that ignores the lease, and a settle that ignores the attempt, are named', async () => {
    const careless = (): TelegramUpdateStore => {
      const store = memoryTelegramUpdateStore();
      const attempts = new Map<number, number>();
      return {
        ...store,
        // Read, then write: takes anything recorded, however it stands.
        async claim(updateId) {
          const attempt = (attempts.get(updateId) ?? 0) + 1;
          attempts.set(updateId, attempt);
          return attempt;
        },
      };
    };
    const violations = await checkTelegramUpdateStore(careless);
    expect(violations).toContain(
      'a live lease is not taken, a lapsed one is: a claim took an update under a live lease',
    );
    expect(violations).toContain(
      'of concurrent claims exactly one takes the update: 8 of 8 concurrent claims took one update',
    );
  });

  test('a store that throws violates the rule it threw in', async () => {
    const broken = (): TelegramUpdateStore => ({
      ...memoryTelegramUpdateStore(),
      prune: () => Promise.reject(new Error('disk full')),
    });
    expect(await checkTelegramUpdateStore(broken)).toEqual([
      'settled updates are forgotten after they are pruned: threw disk full',
    ]);
  });
});

describe.skipIf(postgresUrl === undefined)('postgres', () => {
  const tables: string[] = [];
  const clients: SQL[] = [];
  const client = (options: { bigint?: boolean } = {}): SQL => {
    const sql = new SQL({ url: postgresUrl ?? '', max: 8, ...options });
    clients.push(sql);
    return sql;
  };
  const query =
    (sql: SQL): TelegramPostgresQuery =>
    (text, parameters) =>
      sql.unsafe(text, [...parameters]);
  const fresh = (sql: SQL, createTable = true) => {
    const table = `telegram_updates_${tables.length}_${process.pid}`;
    tables.push(table);
    return postgresTelegramUpdateStore({ query: query(sql), table, createTable });
  };

  afterAll(async () => {
    const [admin] = clients;
    for (const table of tables) await admin?.unsafe(`DROP TABLE IF EXISTS ${table}`);
    for (const sql of clients) await sql.close();
  });

  test('keeps the rules, with bigint columns read back as strings', async () => {
    const sql = client();
    expect(await checkTelegramUpdateStore(() => fresh(sql))).toEqual([]);
  });

  test('keeps the rules with a driver that returns bigint — as Prisma does', async () => {
    const sql = client({ bigint: true });
    expect(await checkTelegramUpdateStore(() => fresh(sql))).toEqual([]);
  });

  test('the schema for a migration is the table the store uses, and runs twice', async () => {
    const sql = client();
    const table = `telegram_updates_migrated_${process.pid}`;
    tables.push(table);
    const schema = postgresTelegramUpdateStoreSchema(table);
    await sql.unsafe(schema);
    await sql.unsafe(schema);
    const store = postgresTelegramUpdateStore({
      query: query(sql),
      table,
      createTable: false,
    });
    expect(
      await store.add({ updateId: 2 ** 40, body: 'b', receivedAt: 1_790_000_000_000 }),
    ).toBe(true);
    expect(
      await store.due({ now: 1_790_000_000_001, pendingBefore: 1_790_000_000_000, limit: 5 }),
    ).toEqual([{ updateId: 2 ** 40, body: 'b' }]);
  });

  test('without the table and without creating it, a store says so', async () => {
    const sql = client();
    const store = fresh(sql, false);
    await expect(store.add({ updateId: 1, body: 'b', receivedAt: 0 })).rejects.toThrow();
  });
});

test('a table name is checked before it reaches SQL', () => {
  expect(() => postgresTelegramUpdateStoreSchema('updates; DROP TABLE users')).toThrow(
    TypeError,
  );
  expect(() => postgresTelegramUpdateStore({ query: async () => [], table: 'a-b' })).toThrow(
    TypeError,
  );
});
