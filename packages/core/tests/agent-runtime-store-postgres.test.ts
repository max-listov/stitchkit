/**
 * The Postgres agent store against a real Postgres, through Bun's SQL client.
 *
 * Runs in the `test:postgres-stores` lane, which sets `AGENT_STORE_DATABASE_URL`
 * to a throwaway database; without it every case here is skipped, and
 * nowhere else. Each case takes its own table prefix, so cases never see each
 * other's rows.
 */
import { afterAll, describe, expect, test } from 'bun:test';
import { SQL } from 'bun';
import {
  createPostgresAgentRuntimeStore,
  createPostgresAgentRuntimeStoreDriver,
  type PostgresAgentRuntimeStoreConfig,
} from '../src/agent-runtime/postgres';
import {
  initializePostgresAgentStore,
  POSTGRES_AGENT_STORE_SCHEMA_VERSION,
  postgresAgentRuntimeStoreDdl,
} from '../src/agent-runtime/postgres-schema';
import { AgentMessageSchema, AgentRunSchema } from '../src/agent-runtime/schemas';
import type { AgentSqlSession } from '../src/agent-runtime/sql-session';
import { createAgentRuntimeStore } from '../src/agent-runtime/store-create';
import * as agentRuntimePostgresEntrypoint from '../src/entrypoints/agent-runtime/postgres';
import { runAgentStoreConformance } from '../src/entrypoints/agent-runtime/testing';
import type { PostgresSqlParameter } from '../src/internal/postgres-query';

const url = Bun.env.AGENT_STORE_DATABASE_URL;
if (url && !new URL(url).pathname.startsWith('/sk_lane_')) {
  throw new Error('The Postgres agent store proof refuses a non-disposable database');
}
const sql = url ? new SQL(url, { max: 24 }) : undefined;

afterAll(async () => {
  await sql?.close();
});

function prefix(): string {
  return `sk_${crypto.randomUUID().replaceAll('-', '').slice(0, 12)}`;
}

type Tx = SQL;

function bunConfig(
  database: SQL,
  overrides: Partial<PostgresAgentRuntimeStoreConfig<Tx>> = {},
): PostgresAgentRuntimeStoreConfig<Tx> & { transactions: () => number } {
  let transactions = 0;
  return {
    transaction: (work) => {
      transactions += 1;
      return database.begin((tx) => work(tx));
    },
    query: (tx, text, parameters: readonly PostgresSqlParameter[]) =>
      tx.unsafe(text, [...parameters]),
    prefix: prefix(),
    transactions: () => transactions,
    ...overrides,
  };
}

/**
 * A write skew with a concurrent transaction that commits first: each reads
 * the row the other writes, so Postgres has to abort the armed one, and with
 * nothing left to run it does so at that transaction's COMMIT.
 */
function commitConflictConfig(database: SQL) {
  const config = bunConfig(database);
  const probe = `${config.prefix}_probe`;
  let armed = false;
  const skew = async (tx: Tx) => {
    await tx.unsafe(`SELECT v FROM ${probe} WHERE id = 'b'`);
    await tx.unsafe(`UPDATE ${probe} SET v = v + 1 WHERE id = 'a'`);
    await database.begin(async (concurrent) => {
      await concurrent.unsafe('SET TRANSACTION ISOLATION LEVEL SERIALIZABLE');
      await concurrent.unsafe(`SELECT v FROM ${probe} WHERE id = 'a'`);
      await concurrent.unsafe(`UPDATE ${probe} SET v = v + 1 WHERE id = 'b'`);
    });
  };
  return {
    config: {
      ...config,
      transaction: <RESULT>(work: (tx: Tx) => Promise<RESULT>) =>
        config.transaction(async (tx) => {
          const result = await work(tx);
          if (armed) {
            armed = false;
            await skew(tx);
          }
          return result;
        }),
    },
    async arm() {
      await database.unsafe(
        `CREATE TABLE IF NOT EXISTS ${probe} (id text PRIMARY KEY, v integer NOT NULL);
         INSERT INTO ${probe} VALUES ('a', 0), ('b', 0) ON CONFLICT DO NOTHING`,
      );
      armed = true;
    },
  };
}

function message(
  conversationId: string,
  id: string,
  createdAt = '2026-11-24T01:00:00.000+08:00',
) {
  return AgentMessageSchema.parse({
    schemaVersion: 1,
    id,
    conversationId,
    role: 'user',
    status: 'committed',
    parts: [{ type: 'text', text: id }],
    createdAt,
    updatedAt: createdAt,
  });
}

function run(conversationId: string, input: string, id: string) {
  return AgentRunSchema.parse({
    schemaVersion: 1,
    id,
    conversationId,
    inputMessageIds: [input],
    assistantMessageId: `${id}-assistant`,
    state: 'queued',
    revision: 0,
    createdAt: '2026-11-24T01:00:00.000+08:00',
    updatedAt: '2026-11-24T01:00:00.000+08:00',
  });
}

/**
 * Cold-start two single-connection clients against one empty prefix under an
 * elevated session default isolation level (`SERIALIZABLE` or `REPEATABLE READ`),
 * holding the first store inside `pg_advisory_xact_lock` until `pg_locks` proves
 * the second store's backend PID is blocked on the same advisory lock.
 */
async function coldStartUnderIsolation(
  database: SQL,
  level: 'SERIALIZABLE' | 'REPEATABLE READ',
  secondCreateTables: boolean,
): Promise<{ secondStatements: string[] }> {
  const shared = prefix();
  const clientA = await database.reserve();
  const clientB = await database.reserve();
  let releaseTx1: () => void = () => undefined;
  try {
    await clientA.unsafe(
      `SET SESSION CHARACTERISTICS AS TRANSACTION ISOLATION LEVEL ${level}`,
    );
    await clientB.unsafe(
      `SET SESSION CHARACTERISTICS AS TRANSACTION ISOLATION LEVEL ${level}`,
    );
    const [infoA] = await clientA.unsafe(
      "SELECT current_setting('default_transaction_isolation') AS level",
    );
    const [infoB] = await clientB.unsafe(
      "SELECT current_setting('default_transaction_isolation') AS level, pg_backend_pid() AS pid",
    );
    expect(infoA?.level).toBe(level.toLowerCase());
    expect(infoB?.level).toBe(level.toLowerCase());
    const pidB = Number(infoB?.pid);
    expect(Number.isSafeInteger(pidB) && pidB > 0).toBe(true);

    let markTx1Locked: () => void = () => undefined;
    const tx1Locked = new Promise<void>((resolve) => {
      markTx1Locked = resolve;
    });
    const tx1CanProceed = new Promise<void>((resolve) => {
      releaseTx1 = resolve;
    });

    const first = createPostgresAgentRuntimeStore<Tx>({
      transaction: (work) => clientA.begin((tx) => work(tx)),
      query: async (tx, text, parameters) => {
        const rows = await tx.unsafe(text, [...parameters]);
        if (text.includes('pg_advisory_xact_lock')) {
          markTx1Locked();
          await tx1CanProceed;
        }
        return rows;
      },
      prefix: shared,
      createTables: true,
    }).store;

    const secondStatements: string[] = [];
    const second = createPostgresAgentRuntimeStore<Tx>({
      transaction: (work) => clientB.begin((tx) => work(tx)),
      query: async (tx, text, parameters) => {
        secondStatements.push(text);
        return tx.unsafe(text, [...parameters]);
      },
      prefix: shared,
      createTables: secondCreateTables,
    }).store;

    const firstPromise = first.appendEvent({
      conversationId: 'first-init',
      kind: 'state/set',
      payload: {},
    });
    await Promise.race([tx1Locked, firstPromise]);

    const secondPromise = secondCreateTables
      ? second.appendEvent({
          conversationId: 'second-init',
          kind: 'state/set',
          payload: {},
        })
      : second.readEvents({ conversationId: 'first-init', limit: 1 });
    let secondSettled = false;
    void secondPromise.then(
      () => {
        secondSettled = true;
      },
      () => {
        secondSettled = true;
      },
    );

    const deadline = Date.now() + 5_000;
    let observedWaiting = false;
    while (!secondSettled && Date.now() < deadline) {
      const waiting = await database.unsafe(
        "SELECT 1 AS waiting FROM pg_locks WHERE locktype = 'advisory' AND NOT granted AND pid = $1 LIMIT 1",
        [pidB],
      );
      if (waiting.length > 0) {
        observedWaiting = true;
        break;
      }
      await Bun.sleep(5);
    }
    releaseTx1();

    const [firstResult] = await Promise.all([firstPromise, secondPromise]);
    expect(observedWaiting).toBe(true);
    expect(firstResult.seq).toBe(1);
    return { secondStatements };
  } finally {
    releaseTx1();
    await Promise.allSettled([
      clientA.unsafe(
        'SET SESSION CHARACTERISTICS AS TRANSACTION ISOLATION LEVEL READ COMMITTED',
      ),
      clientB.unsafe(
        'SET SESSION CHARACTERISTICS AS TRANSACTION ISOLATION LEVEL READ COMMITTED',
      ),
    ]);
    clientA.release();
    clientB.release();
  }
}

describe('postgresAgentRuntimeStoreDdl', () => {
  test('exports postgresAgentRuntimeStoreDdl from stitchkit/agent-runtime/postgres without a Schema alias', () => {
    expect(agentRuntimePostgresEntrypoint.postgresAgentRuntimeStoreDdl).toBe(
      postgresAgentRuntimeStoreDdl,
    );
    expect(
      Object.keys(agentRuntimePostgresEntrypoint).filter((name) => name.endsWith('Schema')),
    ).toEqual([]);
  });

  test('generates default and prefixed DDL statements and rejects invalid prefixes', () => {
    const defaultDdl = postgresAgentRuntimeStoreDdl();
    expect(defaultDdl).toContain('CREATE TABLE IF NOT EXISTS stitchkit_agent_runtime_meta');
    expect(defaultDdl).toContain('CREATE TABLE IF NOT EXISTS stitchkit_agent_runtime_runs');
    expect(defaultDdl).toContain('CREATE TABLE IF NOT EXISTS stitchkit_agent_runtime_events');
    expect(defaultDdl).toContain(
      'CREATE INDEX IF NOT EXISTS stitchkit_agent_runtime_event_search_document ON stitchkit_agent_runtime_event_search USING GIN (document);',
    );
    expect(defaultDdl).toContain(
      `INSERT INTO stitchkit_agent_runtime_meta (key, value) VALUES ('schema_version', '${POSTGRES_AGENT_STORE_SCHEMA_VERSION}') ON CONFLICT (key) DO NOTHING;`,
    );

    const customDdl = postgresAgentRuntimeStoreDdl('custom_agent');
    expect(customDdl).toContain('CREATE TABLE IF NOT EXISTS custom_agent_meta');
    expect(customDdl).toContain(
      'CREATE INDEX IF NOT EXISTS custom_agent_runs_recoverable ON custom_agent_runs',
    );
    expect(customDdl).toContain(
      'CREATE INDEX IF NOT EXISTS custom_agent_event_search_document ON custom_agent_event_search USING GIN (document);',
    );
    expect(customDdl).toContain(
      `INSERT INTO custom_agent_meta (key, value) VALUES ('schema_version', '${POSTGRES_AGENT_STORE_SCHEMA_VERSION}') ON CONFLICT (key) DO NOTHING;`,
    );
    expect(customDdl).not.toContain('stitchkit_agent_runtime_');

    expect(() => postgresAgentRuntimeStoreDdl('UpperCase')).toThrow(TypeError);
    expect(() => postgresAgentRuntimeStoreDdl('agent; DROP TABLE users')).toThrow(TypeError);
    expect(() => postgresAgentRuntimeStoreDdl('p'.repeat(45))).toThrow(TypeError);
  });

  test('initializePostgresAgentStore with createTables false names postgresAgentRuntimeStoreDdl', async () => {
    const emptySession: AgentSqlSession = {
      all: async () => [],
      get: async () => undefined,
      run: async () => undefined,
    };
    let caught: unknown;
    try {
      await initializePostgresAgentStore(emptySession, 'custom_agent', false);
    } catch (error) {
      caught = error;
    }
    expect(caught).toBeInstanceOf(Error);
    const message = caught instanceof Error ? caught.message : '';
    expect(message).toContain(
      'createTables is false; run postgresAgentRuntimeStoreDdl("custom_agent") in a migration',
    );
    expect(message).not.toContain('StoreSchema');
  });
});

describe('createPostgresAgentRuntimeStore', () => {
  test('refuses a maxAttempts that is not a positive safe integer before any transaction', () => {
    let transactions = 0;
    const config = (maxAttempts: number) => ({
      transaction: async <RESULT>(work: (tx: unknown) => Promise<RESULT>) => {
        transactions += 1;
        return work(undefined);
      },
      query: async () => [],
      maxAttempts,
    });
    for (const maxAttempts of [Number.NaN, Number.POSITIVE_INFINITY, 0, -1, 1.5]) {
      expect(() =>
        agentRuntimePostgresEntrypoint.createPostgresAgentRuntimeStore(config(maxAttempts)),
      ).toThrow(`maxAttempts must be a positive safe integer, received ${maxAttempts}`);
    }
    expect(transactions).toBe(0);
  });
});

describe.skipIf(!sql)('the Postgres agent store', () => {
  const database = sql as SQL;

  test('passes the store conformance contract, a conflict at COMMIT included', async () => {
    const conflict = commitConflictConfig(database);
    const { store } = createPostgresAgentRuntimeStore(conflict.config);
    await runAgentStoreConformance({
      createStore: () => store,
      capabilities: { branch: true, planBranch: true, archive: true, historyRestore: true },
      commitConflict: { arm: conflict.arm },
    });
  }, 60_000);

  test('maxAttempts bounds the retries of a conflicting transaction', async () => {
    const once = commitConflictConfig(database);
    const bounded = createPostgresAgentRuntimeStore({ ...once.config, maxAttempts: 1 }).store;
    await bounded.readEvents({ conversationId: 'warm', limit: 1 });
    await once.arm();
    await expect(
      bounded.appendEvent({ conversationId: 'bounded', kind: 'state/set', payload: {} }),
    ).rejects.toMatchObject({ errno: '40001' });
    const retried = commitConflictConfig(database);
    const store = createPostgresAgentRuntimeStore({ ...retried.config, maxAttempts: 2 }).store;
    await store.readEvents({ conversationId: 'warm', limit: 1 });
    await retried.arm();
    expect(
      (await store.appendEvent({ conversationId: 'retried', kind: 'state/set', payload: {} }))
        .seq,
    ).toBe(1);
  });

  test('twenty concurrent appends to one conversation all land, numbered 1 to 20', async () => {
    const { store } = createPostgresAgentRuntimeStore(bunConfig(database));
    const appended = await Promise.all(
      Array.from({ length: 20 }, (_, index) =>
        store.appendEvent({ conversationId: 'crowd', kind: 'state/set', payload: { index } }),
      ),
    );
    expect(appended.map((event) => event.seq).sort((a, b) => a - b)).toEqual(
      Array.from({ length: 20 }, (_, index) => index + 1),
    );
  }, 30_000);

  test('concurrent first admissions to one conversation each take the next version', async () => {
    const { store } = createPostgresAgentRuntimeStore(bunConfig(database));
    const conversationId = 'first-cas';
    const results = await Promise.all(
      Array.from({ length: 5 }, (_, index) =>
        store.acceptInputAndAssignRun({
          idempotencyKey: `request-${index}`,
          input: message(conversationId, `input-${index}`),
          run: run(conversationId, `input-${index}`, `run-${index}`),
        }),
      ),
    );
    expect(results.every((result) => result.outcome !== 'conflict')).toBe(true);
    const snapshot = await store.loadSnapshot(conversationId);
    expect(snapshot.version).toBe(5);
    expect(snapshot.messages.map((entry) => entry.id).sort()).toEqual(
      Array.from({ length: 5 }, (_, index) => `input-${index}`),
    );
  }, 30_000);

  test('a purge racing the first admission leaves either the conversation or the tombstone', async () => {
    for (let round = 0; round < 10; round += 1) {
      const { store } = createPostgresAgentRuntimeStore(bunConfig(database));
      const conversationId = `race-${round}`;
      const [, purge] = await Promise.allSettled([
        store.acceptInputAndAssignRun({
          idempotencyKey: 'first',
          input: message(conversationId, 'first'),
          run: run(conversationId, 'first', 'run'),
        }),
        store.purgeConversation?.({ conversationId }),
      ]);
      const purged = purge.status === 'fulfilled' && purge.value?.outcome === 'purged';
      const events = await store
        .readEvents({ conversationId, limit: 10 })
        .catch(() => undefined);
      if (purged) expect(events?.items ?? []).toEqual([]);
      else expect(events?.items.length).toBeGreaterThan(0);
    }
  }, 60_000);

  test('a duplicate event id is refused in one attempt, not retried', async () => {
    const config = bunConfig(database);
    const driver = createPostgresAgentRuntimeStoreDriver(config);
    const draft = {
      schemaVersion: 1,
      eventId: crypto.randomUUID(),
      conversationId: 'dup',
      kind: 'state/set',
      occurredAt: '2026-11-24T01:00:00.000+08:00',
      payload: {},
    };
    await driver.transaction((session) => driver.events.append(session, draft));
    const before = config.transactions();
    await expect(
      driver.transaction((session) => driver.events.append(session, draft)),
    ).rejects.toThrow();
    expect(config.transactions() - before).toBe(1);
  });

  test('a transaction the application already used is refused in words', async () => {
    const config = bunConfig(database);
    const { store } = createPostgresAgentRuntimeStore({
      ...config,
      transaction: (work) =>
        config.transaction(async (tx) => {
          await tx.unsafe('SELECT 1');
          return work(tx);
        }),
    });
    await expect(store.readEvents({ conversationId: 'used', limit: 1 })).rejects.toThrow(
      'opens its own transactions',
    );
  });

  test('an export round-trips byte for byte with an offset timestamp and a non-ASCII id', async () => {
    const source = createPostgresAgentRuntimeStore(bunConfig(database)).store;
    const conversationId = 'разговор-ü-日本';
    await source.acceptInputAndAssignRun({
      idempotencyKey: 'ключ',
      input: message(conversationId, 'сообщение', '2026-11-24T01:00:00.123+08:00'),
      run: run(conversationId, 'сообщение', 'запуск'),
    });
    await source.appendEvent({
      conversationId,
      kind: 'state/set',
      occurredAt: '2026-11-24T01:00:00.123+08:00',
      payload: { text: 'ü' },
    });
    const exported = await source.exportConversation(conversationId);
    expect(new TextDecoder().decode(exported)).toContain('2026-11-24T01:00:00.123+08:00');
    const target = createPostgresAgentRuntimeStore(bunConfig(database)).store;
    await target.importConversation(exported);
    expect(Buffer.from(await target.exportConversation(conversationId))).toEqual(
      Buffer.from(exported),
    );
  });

  test('an id with NUL is refused by the schema before Postgres sees it', async () => {
    const { store } = createPostgresAgentRuntimeStore(bunConfig(database));
    await expect(
      (async () =>
        store.appendEvent({ conversationId: 'a\0b', kind: 'state/set', payload: {} }))(),
    ).rejects.toThrow('NUL');
  });

  describe('the schema', () => {
    test('two stores starting at once on an empty prefix both come up', async () => {
      const shared = prefix();
      const stores = Array.from(
        { length: 4 },
        () => createPostgresAgentRuntimeStore(bunConfig(database, { prefix: shared })).store,
      );
      const results = await Promise.all(
        stores.map((store, index) =>
          store.appendEvent({
            conversationId: `parallel-${index}`,
            kind: 'state/set',
            payload: {},
          }),
        ),
      );
      expect(results.map((event) => event.seq)).toEqual([1, 1, 1, 1]);
    });

    test('an unknown version is refused', async () => {
      const config = bunConfig(database);
      await createPostgresAgentRuntimeStore(config).store.readEvents({
        conversationId: 'x',
        limit: 1,
      });
      await database.unsafe(`UPDATE ${config.prefix}_meta SET value = '2'`);
      await expect(
        createPostgresAgentRuntimeStore(config).store.readEvents({
          conversationId: 'x',
          limit: 1,
        }),
      ).rejects.toThrow('Unsupported Stitchkit agent store schema version 2');
    });

    test('a partial schema is refused, with or without its version row', async () => {
      const config = bunConfig(database);
      await createPostgresAgentRuntimeStore(config).store.readEvents({
        conversationId: 'x',
        limit: 1,
      });
      await database.unsafe(`DROP TABLE ${config.prefix}_spills`);
      await expect(
        createPostgresAgentRuntimeStore(config).store.readEvents({
          conversationId: 'x',
          limit: 1,
        }),
      ).rejects.toThrow(`missing ${config.prefix}_spills`);
      const bare = bunConfig(database);
      await database.unsafe(`CREATE TABLE ${bare.prefix}_heads (conversation_id text)`);
      await expect(
        createPostgresAgentRuntimeStore(bare).store.readEvents({
          conversationId: 'x',
          limit: 1,
        }),
      ).rejects.toThrow('unversioned partial');
    });

    test('createTables false refuses an empty prefix and accepts a migrated one', async () => {
      const config = bunConfig(database, { createTables: false });
      await expect(
        createPostgresAgentRuntimeStore(config).store.readEvents({
          conversationId: 'x',
          limit: 1,
        }),
      ).rejects.toThrow(
        `createTables is false; run postgresAgentRuntimeStoreDdl("${config.prefix}") in a migration`,
      );
      await database.unsafe(postgresAgentRuntimeStoreDdl(config.prefix));
      const page = await createPostgresAgentRuntimeStore(config).store.readEvents({
        conversationId: 'x',
        limit: 1,
      });
      expect(page.items).toEqual([]);
      // Re-running raw DDL is idempotent and preserves a newer schema_version row.
      await database.unsafe(postgresAgentRuntimeStoreDdl(config.prefix));
      await database.unsafe(
        `UPDATE ${config.prefix}_meta SET value = '2' WHERE key = 'schema_version'`,
      );
      await database.unsafe(postgresAgentRuntimeStoreDdl(config.prefix));
      const [versionRow] = await database.unsafe(
        `SELECT value FROM ${config.prefix}_meta WHERE key = 'schema_version'`,
      );
      expect(versionRow).toEqual({ value: '2' });
    });

    test('concurrent cold start under SERIALIZABLE and REPEATABLE READ sees committed tables', async () => {
      const levels: readonly ('SERIALIZABLE' | 'REPEATABLE READ')[] = [
        'SERIALIZABLE',
        'REPEATABLE READ',
      ];
      for (const level of levels) {
        for (const secondCreateTables of [true, false]) {
          const { secondStatements } = await coldStartUnderIsolation(
            database,
            level,
            secondCreateTables,
          );
          expect(secondStatements[0]).toBe('SET TRANSACTION ISOLATION LEVEL READ COMMITTED');
          expect(secondStatements[1]).toContain('pg_advisory_xact_lock');
          expect(
            secondStatements.some((statement) => statement.includes('CREATE TABLE')),
          ).toBe(false);
        }
      }
    }, 30_000);

    test('a prefix whose table names pass 63 bytes is refused', () => {
      expect(() =>
        createPostgresAgentRuntimeStore(bunConfig(database, { prefix: 'p'.repeat(45) })),
      ).toThrow('Postgres keeps 63');
      expect(() =>
        createPostgresAgentRuntimeStore(bunConfig(database, { prefix: 'Upper' })),
      ).toThrow('[a-z_][a-z0-9_]*');
    });
  });

  test('the driver alone assembles into a store', async () => {
    const store = createAgentRuntimeStore(
      createPostgresAgentRuntimeStoreDriver(bunConfig(database)),
    );
    const event = await store.appendEvent({
      conversationId: 'driver',
      kind: 'state/set',
      payload: {},
    });
    expect(event.seq).toBe(1);
  });
});
