/**
 * `stitchkit/sync/postgres` server stores: every shipped store keeps the rules
 * of `checkSyncStore`, and the check names a store that breaks one. Postgres
 * runs in the `test:postgres-stores` lane, which sets `SYNC_STORE_DATABASE_URL`;
 * without it those cases are skipped here and nowhere else. There the order
 * rule is proven against two live transactions: a counter row commits versions
 * in their order; a plain sequence and a number taken outside the writer's
 * transaction — the negative controls — do not.
 */
import { afterAll, describe, expect, test } from 'bun:test';
import { SQL } from 'bun';
import * as syncPostgresEntrypoint from '../src/entrypoints/sync/postgres';
import type { PostgresSqlParameter } from '../src/internal/postgres-query';
import type { SyncServerStore } from '../src/sync/server-store';
import { checkSyncStore } from '../src/sync/server-store-check';
import { memorySyncStore } from '../src/sync/server-store-memory';
import { postgresSyncStore, postgresSyncStoreDdl } from '../src/sync/server-store-postgres';

const postgresUrl = Bun.env.SYNC_STORE_DATABASE_URL;

test('the memory store keeps the rules', async () => {
  expect(await checkSyncStore(() => memorySyncStore())).toEqual([]);
});

test('a scope starts after the version it is given, so existing cursors stay valid', async () => {
  const store = memorySyncStore({ startAfter: 41 });
  expect(await store.transaction((tx) => store.allocateVersions(tx, 'a', 2))).toEqual([
    42, 43,
  ]);
});

test('the clock dates ledger records, so prune keeps a record newer than its cut', async () => {
  let clock = 1_000;
  const store = memorySyncStore({ now: () => clock });
  await store.push({ scope: 's', replicaId: 'r', changes: [{ id: 'old' }] }, async () => ({
    outcome: 'applied',
  }));
  clock = 5_000;
  await store.push({ scope: 's', replicaId: 'r', changes: [{ id: 'new' }] }, async () => ({
    outcome: 'applied',
  }));
  expect(await store.prune({ before: 2_000 })).toBe(1);
  const again = await store.push(
    { scope: 's', replicaId: 'r', changes: [{ id: 'old' }, { id: 'new' }] },
    async () => ({ outcome: 'applied' }),
  );
  expect(again.results.map((result) => result.outcome)).toEqual(['applied', 'replayed']);
});

test('a push or a transaction inside a transaction is refused, not left waiting for itself', async () => {
  const store = memorySyncStore();
  const inner = await store
    .transaction(() =>
      store.push({ scope: 's', replicaId: 'r', changes: [{ id: 'c' }] }, async () => ({
        outcome: 'applied',
      })),
    )
    .then((outcome) => outcome.failures[0]?.error);
  expect(String(inner)).toContain('cannot open another one');
});

describe('the check names a store that breaks a rule', () => {
  const broken =
    <TX>(
      patch: (store: SyncServerStore<TX>) => Partial<SyncServerStore<TX>>,
      make: () => SyncServerStore<TX>,
    ) =>
    () => {
      const store = make();
      return { ...store, ...patch(store) };
    };

  test('a store that forgets what it applied runs a repeat again', async () => {
    const failures = await checkSyncStore(
      broken(
        (store) => ({
          push: (request, apply) =>
            store.push(
              { ...request, replicaId: `${request.replicaId}-${Math.random()}` },
              apply,
            ),
        }),
        () => memorySyncStore(),
      ),
    );
    expect(failures.some((failure) => failure.startsWith('a change runs once'))).toBe(true);
  });

  test('a feed that lists deleted entities in a full read is named', async () => {
    const failures = await checkSyncStore(
      broken(
        (store) => ({
          changesAfter: (scope, after, read) =>
            store.changesAfter(scope, after, { limit: read.limit }),
        }),
        () => memorySyncStore(),
      ),
    );
    expect(
      failures.some((failure) => failure.includes('full read listed a deleted entity')),
    ).toBe(true);
  });
});

test('a store written only inside application transactions stops asking whether its tables exist', async () => {
  const run = (readyReplies: boolean[]) => {
    const asked: object[] = [];
    const replies = [...readyReplies];
    const store = postgresSyncStore<{ id: number }>({
      prefix: 'sync_within',
      transaction: (work) => work({ id: 0 }),
      query: async (tx, text) => {
        if (text.includes('to_regclass')) {
          asked.push(tx);
          return [{ ready: replies.shift() ?? false }];
        }
        if (text.includes('current_setting')) return [{ previous: '10s' }];
        if (text.includes('RETURNING version')) return [{ version: 1 }];
        return [];
      },
    });
    return { store, asked };
  };

  // Tables another transaction committed: seen once, never asked about again.
  const committed = run([true]);
  const first = { id: 1 };
  const second = { id: 2 };
  await committed.store.allocateVersions(first, 's', 1);
  await committed.store.allocateVersions(first, 's', 1);
  await committed.store.allocateVersions(second, 's', 1);
  expect(committed.asked).toEqual([first]);

  // Tables this transaction created may roll back with it: seeing them again from inside
  // the same transaction settles nothing, and the next transaction has to look for itself.
  const own = run([false, false, true, true]);
  const creator = { id: 3 };
  const later = { id: 4 };
  await own.store.allocateVersions(creator, 's', 1);
  await own.store.allocateVersions(creator, 's', 1);
  expect(own.asked).toEqual([creator, creator, creator]);
  await own.store.allocateVersions(later, 's', 1);
  await own.store.allocateVersions(later, 's', 1);
  expect(own.asked).toEqual([creator, creator, creator, later]);
});

test('postgresSyncStore guards DDL with a prefix-keyed advisory lock, to_regclass fast-path, double-check, lock_timeout and retry', async () => {
  type Recorded = {
    readonly tx: number;
    readonly text: string;
    readonly parameters: readonly PostgresSqlParameter[];
  };
  const LOCK_SQL = 'SELECT 1 FROM pg_advisory_xact_lock($1::integer, $2::integer)';
  const runRecorder = (
    prefix: string,
    options: {
      createTables?: boolean;
      lockTimeoutMs?: number;
      readyReplies?: boolean[];
      failOnLock?: boolean;
    } = {},
  ) => {
    const calls: Recorded[] = [];
    const replies = [...(options.readyReplies ?? [])];
    let nextTx = 0;
    let shouldFail = options.failOnLock ?? false;
    const store = postgresSyncStore<number>({
      prefix,
      createTables: options.createTables,
      lockTimeoutMs: options.lockTimeoutMs,
      transaction: (work) => work(++nextTx),
      query: async (tx, text, parameters) => {
        const trimmed = text.trim();
        calls.push({ tx, text: trimmed, parameters });
        if (trimmed.includes('to_regclass')) return [{ ready: replies.shift() ?? false }];
        if (trimmed.includes('pg_advisory_xact_lock') && shouldFail) {
          shouldFail = false;
          throw new Error('simulated ddl lock failure');
        }
        if (trimmed.includes('current_setting')) return [{ previous: '10s' }];
        if (trimmed.includes('RETURNING version')) return [{ version: 1 }];
        return [];
      },
    });
    return { store, calls };
  };

  // Cold start: to_regclass -> lock_timeout -> pg_advisory_xact_lock -> double-check -> DDL -> restore.
  const first = runRecorder('sync_alpha', { lockTimeoutMs: 750 });
  await first.store.transaction((tx) => first.store.allocateVersions(tx, 's', 1));
  const ddlTx = first.calls.find((call) => call.text.startsWith('CREATE TABLE'))?.tx;
  expect(ddlTx).toBeDefined();
  const ddlCalls = first.calls.filter((call) => call.tx === ddlTx);
  const lockIndex = ddlCalls.findIndex((call) => call.text === LOCK_SQL);
  expect(lockIndex).toBeGreaterThan(0);
  const lockCall = ddlCalls[lockIndex];
  expect(lockCall?.parameters).toHaveLength(2);
  for (const key of lockCall?.parameters ?? []) {
    expect(typeof key).toBe('number');
    expect(Number.isSafeInteger(key)).toBe(true);
    expect(Number(key)).toBeGreaterThanOrEqual(-2_147_483_648);
    expect(Number(key)).toBeLessThanOrEqual(2_147_483_647);
  }
  expect(ddlCalls[0]?.text).toContain('to_regclass');
  expect(ddlCalls[lockIndex - 1]?.parameters).toEqual(['750ms']);
  expect(ddlCalls[lockIndex + 1]?.text).toContain('to_regclass');
  expect(ddlCalls.findIndex((call) => call.text.startsWith('CREATE TABLE'))).toBeGreaterThan(
    lockIndex + 1,
  );
  expect(ddlCalls.at(-1)?.parameters).toEqual(['10s']);

  // Second `store.transaction` after successful init skips to_regclass, advisory lock and DDL.
  const callsAfterFirst = first.calls.length;
  await first.store.transaction((tx) => first.store.allocateVersions(tx, 's', 1));
  const secondTxCalls = first.calls.slice(callsAfterFirst);
  expect(secondTxCalls.some((call) => call.text.includes('to_regclass'))).toBe(false);
  expect(secondTxCalls.some((call) => call.text === LOCK_SQL)).toBe(false);
  expect(secondTxCalls.some((call) => call.text.startsWith('CREATE TABLE'))).toBe(false);

  // Mixed-case prefix shares the exact same advisory lock keys (Postgres folds unquoted names).
  const mixedCase = runRecorder('Sync_Alpha');
  await mixedCase.store.allocateVersions(99, 's', 1);
  const withinCalls = mixedCase.calls.filter((call) => call.tx === 99);
  const withinLock = withinCalls.find((call) => call.text === LOCK_SQL);
  expect(withinLock?.parameters).toEqual(lockCall?.parameters);

  // Different prefix takes a different key pair.
  const otherPrefix = runRecorder('sync_beta');
  await otherPrefix.store.transaction((tx) => otherPrefix.store.allocateVersions(tx, 's', 1));
  expect(otherPrefix.calls.find((call) => call.text === LOCK_SQL)?.parameters).not.toEqual(
    lockCall?.parameters,
  );

  // Warm `within(tx)` fast-path: `to_regclass` ready=true skips advisory lock and DDL completely.
  const warm = runRecorder('sync_alpha', { readyReplies: [true] });
  await warm.store.allocateVersions(7, 's', 1);
  expect(warm.calls.some((call) => call.text === LOCK_SQL)).toBe(false);
  expect(warm.calls.some((call) => call.text.startsWith('CREATE TABLE'))).toBe(false);

  // Double-check after lock: first `to_regclass` false, second true -> skips DDL, restores lock_timeout.
  const raced = runRecorder('sync_alpha', { readyReplies: [false, true], lockTimeoutMs: 500 });
  await raced.store.allocateVersions(8, 's', 1);
  expect(raced.calls.some((call) => call.text === LOCK_SQL)).toBe(true);
  expect(raced.calls.some((call) => call.text.startsWith('CREATE TABLE'))).toBe(false);
  expect(raced.calls.some((call) => call.parameters[0] === '10s')).toBe(true);

  // Failed first `createIn` resets `ready`, so the next call retries lock + DDL and succeeds.
  const retried = runRecorder('sync_alpha', { failOnLock: true });
  await expect(
    retried.store.transaction((tx) => retried.store.allocateVersions(tx, 's', 1)),
  ).rejects.toThrow(/simulated ddl lock failure/);
  await retried.store.transaction((tx) => retried.store.allocateVersions(tx, 's', 1));
  expect(retried.calls.filter((call) => call.text === LOCK_SQL)).toHaveLength(2);
  expect(retried.calls.some((call) => call.text.startsWith('CREATE TABLE'))).toBe(true);

  // With createTables: false, neither to_regclass, advisory lock, nor DDL runs.
  const migrated = runRecorder('sync_alpha', { createTables: false });
  await migrated.store.transaction((tx) => migrated.store.allocateVersions(tx, 's', 1));
  expect(migrated.calls.some((call) => call.text.includes('to_regclass'))).toBe(false);
  expect(migrated.calls.some((call) => call.text === LOCK_SQL)).toBe(false);
  expect(migrated.calls.some((call) => call.text.startsWith('CREATE TABLE'))).toBe(false);
});

describe('postgresSyncStoreDdl', () => {
  test('exports postgresSyncStoreDdl from stitchkit/sync/postgres without a Schema alias', () => {
    expect(syncPostgresEntrypoint.postgresSyncStoreDdl).toBe(postgresSyncStoreDdl);
    expect(
      Object.keys(syncPostgresEntrypoint).filter((name) => name.endsWith('Schema')),
    ).toEqual([]);
  });

  test('generates default and prefixed DDL statements and rejects invalid prefixes', () => {
    const defaultDdl = postgresSyncStoreDdl();
    expect(defaultDdl).toContain('CREATE TABLE IF NOT EXISTS sync_counters');
    expect(defaultDdl).toContain('CREATE TABLE IF NOT EXISTS sync_feed');
    expect(defaultDdl).toContain(
      'CREATE UNIQUE INDEX IF NOT EXISTS sync_feed_version ON sync_feed (scope, version);',
    );
    expect(defaultDdl).toContain('CREATE TABLE IF NOT EXISTS sync_ledger');
    expect(defaultDdl).toContain(
      'CREATE INDEX IF NOT EXISTS sync_ledger_recorded ON sync_ledger (recorded_at);',
    );

    const customDdl = postgresSyncStoreDdl('custom_prefix');
    expect(customDdl).toContain('CREATE TABLE IF NOT EXISTS custom_prefix_counters');
    expect(customDdl).toContain('CREATE TABLE IF NOT EXISTS custom_prefix_feed');
    expect(customDdl).toContain(
      'CREATE UNIQUE INDEX IF NOT EXISTS custom_prefix_feed_version ON custom_prefix_feed (scope, version);',
    );
    expect(customDdl).toContain('CREATE TABLE IF NOT EXISTS custom_prefix_ledger');
    expect(customDdl).toContain(
      'CREATE INDEX IF NOT EXISTS custom_prefix_ledger_recorded ON custom_prefix_ledger (recorded_at);',
    );
    expect(customDdl).not.toContain('sync_counters');

    expect(() => postgresSyncStoreDdl('sync; DROP TABLE users')).toThrow(TypeError);
    expect(() => postgresSyncStoreDdl('123_sync')).toThrow(TypeError);
    expect(() => postgresSyncStoreDdl('a'.repeat(42))).toThrow(TypeError);
  });
});

describe.skipIf(postgresUrl === undefined)('Postgres', () => {
  const sql = new SQL(postgresUrl ?? 'postgres://absent');
  afterAll(() => sql.close());
  type Tx = SQL;
  const make = (prefix = `sync_${Math.random().toString(36).slice(2, 8)}`) =>
    postgresSyncStore<Tx>({
      transaction: (work) => sql.begin((tx) => work(tx)),
      query: (tx, text, parameters) => tx.unsafe(text, [...parameters]),
      prefix,
    });

  test('the Postgres store keeps the rules, twice on one database', async () => {
    const store = make();
    expect(await checkSyncStore(() => store)).toEqual([]);
    expect(await checkSyncStore(() => store)).toEqual([]);
  });

  test('tables live under the prefix; without createTables the store uses only what a migration made', async () => {
    const prefix = `sync_${Math.random().toString(36).slice(2, 8)}`;
    const migrated = postgresSyncStore<Tx>({
      transaction: (work) => sql.begin((tx) => work(tx)),
      query: (tx, text, parameters) => tx.unsafe(text, [...parameters]),
      prefix,
      createTables: false,
      startAfter: 100,
      now: () => 7,
    });
    await expect(
      migrated.transaction((tx) => migrated.allocateVersions(tx, 's', 1)),
    ).rejects.toThrow(/does not exist/);
    await sql.unsafe(postgresSyncStoreDdl(prefix));
    expect(await migrated.transaction((tx) => migrated.allocateVersions(tx, 's', 1))).toEqual([
      101,
    ]);
    await migrated.push({ scope: 's', replicaId: 'r', changes: [{ id: 'c' }] }, async () => ({
      outcome: 'applied',
    }));
    const [row] = await sql.unsafe(`SELECT recorded_at FROM ${prefix}_ledger`);
    expect(Number(row.recorded_at)).toBe(7);
  });

  test('a writer that took a version first commits it first; a reader never skips it', async () => {
    const store = make();
    const scope = 'ordered';
    await store.transaction((tx) => store.allocateVersions(tx, scope, 1));
    const { promise: firstHolds, resolve: releaseFirst } = Promise.withResolvers<void>();
    const { promise: tookFirst, resolve: firstTook } = Promise.withResolvers<void>();
    const first = store.transaction(async (tx) => {
      const versions = await store.publish(tx, scope, [
        { entity: 'task', entityId: 'slow', deleted: false },
      ]);
      firstTook();
      await firstHolds;
      return versions;
    });
    await tookFirst;
    let secondDone = false;
    const second = store
      .transaction((tx) =>
        store.publish(tx, scope, [{ entity: 'task', entityId: 'fast', deleted: false }]),
      )
      .then((versions) => {
        secondDone = true;
        return versions;
      });
    await Bun.sleep(150);
    const whileHeld = await store.changesAfter(scope, null, { limit: 10 });
    expect(secondDone).toBe(false);
    expect(whileHeld.changes).toEqual([]);
    releaseFirst();
    const [[slow], [fast]] = await Promise.all([first, second]);
    expect((slow ?? 0) < (fast ?? 0)).toBe(true);
    const after = await store.changesAfter(scope, 1, { limit: 10 });
    expect(after.changes.map((change) => change.entityId)).toEqual(['slow', 'fast']);
  });

  test('negative control: a sequence hands out numbers that commit out of order', async () => {
    const name = `sync_control_${Math.random().toString(36).slice(2, 8)}`;
    await sql.unsafe(`CREATE SEQUENCE ${name}`);
    await sql.unsafe(`CREATE TABLE ${name}_feed (version BIGINT PRIMARY KEY)`);
    const { promise: firstHolds, resolve: releaseFirst } = Promise.withResolvers<void>();
    const { promise: tookFirst, resolve: firstTook } = Promise.withResolvers<void>();
    const first = sql.begin(async (tx) => {
      await tx.unsafe(`INSERT INTO ${name}_feed SELECT nextval('${name}')`);
      firstTook();
      await firstHolds;
    });
    await tookFirst;
    await sql.begin((tx) => tx.unsafe(`INSERT INTO ${name}_feed SELECT nextval('${name}')`));
    const seen = await sql.unsafe(`SELECT version FROM ${name}_feed ORDER BY version`);
    releaseFirst();
    await first;
    const cursor = Number(seen.at(-1)?.version);
    const missed = await sql.unsafe(
      `SELECT version FROM ${name}_feed WHERE version <= ${cursor} ORDER BY version`,
    );
    // The reader saw 2 and moved its cursor past 1, which committed afterwards: 1 is never read.
    expect(seen.map((row: { version: string }) => Number(row.version))).toEqual([2]);
    expect(missed.map((row: { version: string }) => Number(row.version))).toEqual([1, 2]);
    await sql.unsafe(`DROP TABLE ${name}_feed; DROP SEQUENCE ${name}`);
  });

  test('negative control: a version taken outside the writer’s transaction is skipped by a reader', async () => {
    const prefix = `sync_${Math.random().toString(36).slice(2, 8)}`;
    const store = make(prefix);
    const scope = 'outside';
    // Taken in a transaction of its own: the counter's lock ends there, not at the writer's commit.
    const [early] = await store.transaction((tx) => store.allocateVersions(tx, scope, 1));
    const { promise: holds, resolve: release } = Promise.withResolvers<void>();
    const { promise: written, resolve: wrote } = Promise.withResolvers<void>();
    const late = sql.begin(async (tx) => {
      await tx.unsafe(
        `INSERT INTO ${prefix}_feed (scope, entity, entity_id, version, deleted) VALUES ($1, 'task', 'late', $2, false)`,
        [scope, early ?? 0],
      );
      wrote();
      await holds;
    });
    await written;
    await store.transaction((tx) =>
      store.publish(tx, scope, [{ entity: 'task', entityId: 'next', deleted: false }]),
    );
    const seen = await store.changesAfter(scope, null, { limit: 10 });
    release();
    await late;
    const after = await store.changesAfter(scope, seen.changes.at(-1)?.version ?? null, {
      limit: 10,
    });
    expect(seen.changes.map((change) => change.entityId)).toEqual(['next']);
    expect(after.changes).toEqual([]);
  });

  test('a writer waiting on the counter longer than its timeout fails instead of hanging', async () => {
    const prefix = `sync_${Math.random().toString(36).slice(2, 8)}`;
    const patient = make(prefix);
    const hasty = postgresSyncStore<Tx>({
      transaction: (work) => sql.begin((tx) => work(tx)),
      query: (tx, text, parameters) => tx.unsafe(text, [...parameters]),
      prefix,
      lockTimeoutMs: 50,
    });
    await patient.transaction((tx) => patient.allocateVersions(tx, 'held', 1));
    const { promise: holds, resolve: release } = Promise.withResolvers<void>();
    const { promise: taken, resolve: took } = Promise.withResolvers<void>();
    const holder = patient.transaction(async (tx) => {
      await patient.allocateVersions(tx, 'held', 1);
      took();
      await holds;
    });
    await taken;
    const waited = hasty.transaction((tx) => hasty.allocateVersions(tx, 'held', 1));
    await expect(waited).rejects.toThrow(/lock timeout/);
    release();
    await holder;
  });

  test('two concurrent first writes on a fresh prefix initialize tables without racing', async () => {
    const rounds = 10;
    for (let round = 0; round < rounds; round++) {
      // Path 1: two fresh store instances running concurrent `push` on a fresh prefix.
      const pushPrefix = `sync_race_push_${round}_${Math.random().toString(36).slice(2, 6)}`;
      const storeA = make(pushPrefix);
      const storeB = make(pushPrefix);
      const [pushA, pushB] = await Promise.all([
        storeA.push({ scope: 's', replicaId: 'r1', changes: [{ id: 'c1' }] }, async (tx) => {
          await storeA.publish(tx, 's', [{ entity: 'item', entityId: 'a', deleted: false }]);
          return { outcome: 'applied' };
        }),
        storeB.push({ scope: 's', replicaId: 'r2', changes: [{ id: 'c2' }] }, async (tx) => {
          await storeB.publish(tx, 's', [{ entity: 'item', entityId: 'b', deleted: false }]);
          return { outcome: 'applied' };
        }),
      ]);
      expect(pushA.failures).toEqual([]);
      expect(pushB.failures).toEqual([]);
      expect(pushA.results.map((result) => result.outcome)).toEqual(['applied']);
      expect(pushB.results.map((result) => result.outcome)).toEqual(['applied']);
      const page = await storeA.changesAfter('s', null, { limit: 10 });
      expect(page.changes.map((change) => change.entityId).sort()).toEqual(['a', 'b']);

      // Path 2: two concurrent app-owned transactions hitting `tables.within(tx)` directly.
      const withinPrefix = `sync_race_tx_${round}_${Math.random().toString(36).slice(2, 6)}`;
      const shared = make(withinPrefix);
      const [v1, v2] = await Promise.all([
        sql.begin((tx) => shared.allocateVersions(tx, 's', 1)),
        sql.begin((tx) => shared.allocateVersions(tx, 's', 1)),
      ]);
      expect([...v1, ...v2].sort((a, b) => a - b)).toEqual([1, 2]);
    }
  }, 15_000);

  test('warmed tables let concurrent app-owned transactions on different scopes proceed without blocking on the prefix lock', async () => {
    const prefix = `sync_warm_${Math.random().toString(36).slice(2, 8)}`;
    await sql.begin((tx) => make(prefix).allocateVersions(tx, 'warmup', 1));

    // Fresh store instances (`created = false`) must hit the lock-free `to_regclass` fast-path.
    const storeA = make(prefix);
    const storeB = postgresSyncStore<Tx>({
      transaction: (work) => sql.begin((tx) => work(tx)),
      query: (tx, text, parameters) => tx.unsafe(text, [...parameters]),
      prefix,
      lockTimeoutMs: 200,
    });
    const { promise: holds, resolve: release } = Promise.withResolvers<void>();
    const { promise: inside, resolve: entered } = Promise.withResolvers<void>();
    const txA = sql.begin(async (tx) => {
      const versions = await storeA.allocateVersions(tx, 'scope_a', 1);
      entered();
      await holds;
      return versions;
    });
    await inside;
    let versionsA: readonly number[] | undefined;
    try {
      // Completes while txA is still open — would hit `lock timeout` if `within(tx)` took the prefix lock.
      const versionsB = await sql.begin((tx) => storeB.allocateVersions(tx, 'scope_b', 1));
      expect(versionsB).toEqual([1]);
    } finally {
      release();
      versionsA = await txA;
    }
    expect(versionsA).toEqual([1]);
  });

  test('a cold-start writer waiting on the DDL advisory lock respects lockTimeoutMs', async () => {
    const prefix = `sync_cold_${Math.random().toString(36).slice(2, 8)}`;
    const holderStore = make(prefix);
    const hasty = postgresSyncStore<Tx>({
      transaction: (work) => sql.begin((tx) => work(tx)),
      query: (tx, text, parameters) => tx.unsafe(text, [...parameters]),
      prefix,
      lockTimeoutMs: 50,
    });
    const { promise: holds, resolve: release } = Promise.withResolvers<void>();
    const { promise: locked, resolve: acquired } = Promise.withResolvers<void>();
    const first = sql.begin(async (tx) => {
      await holderStore.allocateVersions(tx, 's', 1);
      acquired();
      await holds;
    });
    await locked;
    try {
      await expect(
        hasty.transaction((tx) => hasty.allocateVersions(tx, 's', 1)),
      ).rejects.toThrow(/lock timeout/);
    } finally {
      release();
      await first;
    }
  });
});
