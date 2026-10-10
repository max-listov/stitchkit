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
  type TelegramUpdateAttemptIdentity,
  type TelegramUpdateDurableStore,
  type TelegramUpdateFencedStore,
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
      'an attempt fence expires and never adopts a later claim: threw disk full',
      'durable exhaustion survives owner loss until its exact acknowledgement: threw disk full',
    ]);
  });

  test('a fenced-only store is checked even without durable exhaustion methods', async () => {
    const broken = (): TelegramUpdateFencedStore => {
      const store = memoryTelegramUpdateStore();
      return {
        add: store.add,
        claim: store.claim,
        renew: store.renew,
        settle: store.settle,
        due: store.due,
        prune: store.prune,
        claimOwned: store.claimOwned,
        renewOwned: store.renewOwned,
        owns: store.owns,
        settleOwned: async () => true,
      };
    };
    expect(await checkTelegramUpdateStore(broken)).toContain(
      'only the attempt holding the update renews or settles it: an attempt whose lease expired settled the update',
    );
  });

  test('names non-atomic fenced claims and every method that ignores claimId', async () => {
    let unsafeClaim = 0;
    const nonAtomic = (): TelegramUpdateDurableStore => ({
      ...memoryTelegramUpdateStore(),
      claimOwned: async (updateId) => ({
        updateId,
        attempt: 1,
        claimId: `unsafe-${unsafeClaim++}`,
      }),
    });
    expect(await checkTelegramUpdateStore(nonAtomic)).toContain(
      'of concurrent fenced claims exactly one takes the update: 8 of 8 concurrent fenced claims took one update',
    );

    const unfencedRenew = (): TelegramUpdateDurableStore => {
      const store = memoryTelegramUpdateStore();
      return {
        ...store,
        renewOwned: (identity, leaseUntil, at) =>
          store.renew(identity.updateId, identity.attempt, leaseUntil, at),
      };
    };
    expect(await checkTelegramUpdateStore(unfencedRenew)).toContain(
      'an attempt fence expires and never adopts a later claim: a different claim token renewed the current attempt',
    );

    const unfencedSettle = (): TelegramUpdateDurableStore => {
      const store = memoryTelegramUpdateStore();
      return {
        ...store,
        settleOwned: async (identity, settlement) => {
          await store.settle(identity.updateId, identity.attempt, settlement);
          return true;
        },
      };
    };
    expect(await checkTelegramUpdateStore(unfencedSettle)).toContain(
      'an attempt fence expires and never adopts a later claim: a different claim token settled a recycled update_id',
    );

    const unfencedTerminal = (): TelegramUpdateDurableStore => {
      const store = memoryTelegramUpdateStore();
      const claims = new Map<number, TelegramUpdateAttemptIdentity>();
      return {
        ...store,
        claimOwned: async (...args) => {
          const identity = await store.claimOwned(...args);
          if (identity) claims.set(identity.updateId, identity);
          return identity;
        },
        exhaust: (identity, exhaustion) =>
          store.exhaust(claims.get(identity.updateId) ?? identity, exhaustion),
        acknowledgeExhaustion: (identity, at) =>
          store.acknowledgeExhaustion(claims.get(identity.updateId) ?? identity, at),
      };
    };
    const terminalViolations = await checkTelegramUpdateStore(unfencedTerminal);
    expect(terminalViolations).toContain(
      'durable exhaustion survives owner loss until its exact acknowledgement: a different claim token acknowledged the exhaustion',
    );
    expect(terminalViolations).toContain(
      'durable exhaustion survives owner loss until its exact acknowledgement: a different claim token persisted terminal exhaustion',
    );
  });
});

test('sqlite adds claim_id to an existing 0.108 table', async () => {
  const database = new Database(':memory:');
  database.exec(`CREATE TABLE telegram_updates (
    update_id INTEGER PRIMARY KEY,
    body TEXT NOT NULL,
    state TEXT NOT NULL,
    attempts INTEGER NOT NULL,
    due_at INTEGER NOT NULL,
    received_at INTEGER NOT NULL,
    settled_at INTEGER,
    error TEXT
  )`);
  const store = sqliteTelegramUpdateStore({ database });
  await store.add({ updateId: 1, body: 'b', receivedAt: 0 });
  expect(await store.claimOwned(1, { now: 0, leaseUntil: 10, maxAttempts: 2 })).toMatchObject({
    updateId: 1,
    attempt: 1,
    claimId: expect.any(String),
  });
});

test('sqlite accepts another process winning the claim_id migration race', () => {
  const database = new Database(':memory:');
  database.exec(`CREATE TABLE telegram_updates (
    update_id INTEGER PRIMARY KEY,
    body TEXT NOT NULL,
    state TEXT NOT NULL,
    attempts INTEGER NOT NULL,
    due_at INTEGER NOT NULL,
    received_at INTEGER NOT NULL,
    settled_at INTEGER,
    error TEXT
  )`);
  let raced = false;
  const racingDatabase = {
    prepare: database.prepare.bind(database),
    exec(sql: string) {
      if (!raced && sql.startsWith('ALTER TABLE')) {
        raced = true;
        database.exec(sql);
        throw new Error('duplicate column name: claim_id');
      }
      return database.exec(sql);
    },
  };
  expect(() => sqliteTelegramUpdateStore({ database: racingDatabase })).not.toThrow();
  expect(raced).toBe(true);
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

  test('a transactional fence check locks out reclaim until the domain transaction commits', async () => {
    const setup = client();
    const transactionClient = client();
    const reclaimClient = client();
    const table = `telegram_updates_fence_${process.pid}`;
    tables.push(table);
    const setupStore = postgresTelegramUpdateStore({ query: query(setup), table });
    await setupStore.add({ updateId: 1, body: 'b', receivedAt: 0 });
    const first = await setupStore.claimOwned(1, { now: 0, leaseUntil: 10, maxAttempts: 2 });
    if (!first) throw new Error('fixture claim was not taken');

    let checked = (): void => undefined;
    const checkFinished = new Promise<void>((resolve) => {
      checked = resolve;
    });
    let commit = (): void => undefined;
    const mayCommit = new Promise<void>((resolve) => {
      commit = resolve;
    });
    const transaction = transactionClient.begin(async (tx) => {
      const transactionStore = postgresTelegramUpdateStore({
        query: query(tx),
        table,
        createTable: false,
      });
      expect(await transactionStore.owns(first, 10)).toBe(true);
      checked();
      await mayCommit;
    });
    await checkFinished;

    const reclaimStore = postgresTelegramUpdateStore({
      query: query(reclaimClient),
      table,
      createTable: false,
    });
    const reclaim = reclaimStore
      .claimOwned(1, { now: 11, leaseUntil: 20, maxAttempts: 2 })
      .then((identity) => ({ state: 'settled' as const, attempt: identity?.attempt }));
    try {
      expect(
        await Promise.race([
          reclaim,
          Bun.sleep(50).then(() => ({ state: 'blocked' as const })),
        ]),
      ).toEqual({ state: 'blocked' });
    } finally {
      commit();
    }
    await transaction;
    expect(await reclaim).toEqual({ state: 'settled', attempt: 2 });
  });

  test('legacy methods still work against an unmigrated 0.108 table', async () => {
    const sql = client();
    const table = `telegram_updates_legacy_${process.pid}`;
    tables.push(table);
    await sql.unsafe(`CREATE TABLE ${table} (
      update_id BIGINT PRIMARY KEY,
      body TEXT NOT NULL,
      state TEXT NOT NULL,
      attempts INTEGER NOT NULL,
      due_at BIGINT NOT NULL,
      received_at BIGINT NOT NULL,
      settled_at BIGINT,
      error TEXT
    )`);
    const store = postgresTelegramUpdateStore({
      query: query(sql),
      table,
      createTable: false,
    });
    await store.add({ updateId: 1, body: 'b', receivedAt: 0 });
    expect(await store.claim(1, { now: 0, leaseUntil: 10, maxAttempts: 2 })).toBe(1);
    expect(await store.renew(1, 1, 20, 5)).toBe(true);
    await store.settle(1, 1, { state: 'completed', at: 6 });
    expect(await store.due({ now: 100, pendingBefore: 100, limit: 10 })).toEqual([]);
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
