import { Database } from 'bun:sqlite';
import { describe, expect, test } from 'bun:test';
import { sqlArchive, sqlEvents } from '../src/agent-runtime/sql-events';
import { sqlHistory } from '../src/agent-runtime/sql-history';
import { sqlLedger } from '../src/agent-runtime/sql-ledger';
import { sqlConversationPurge } from '../src/agent-runtime/sql-purge';
import { scanSqlRecoverable } from '../src/agent-runtime/sql-reads';
import type { SqlStoreDriver } from '../src/agent-runtime/sql-rows';
import { initializeAgentRuntimeSqlite } from '../src/agent-runtime/sqlite-schema';
import {
  closeSqliteStore,
  createSqliteStoreState,
  runSqliteTransaction,
  sqliteDialect,
} from '../src/agent-runtime/sqlite-transactions';
import {
  type AgentRuntimeStore,
  type AgentRuntimeStoreDriver,
  createAgentRuntimeStore,
  createMemoryAgentRuntimeStore,
} from '../src/entrypoints/agent-runtime';
import { runAgentStoreConformance } from '../src/entrypoints/agent-runtime/testing';
import type { SqliteDatabase, SqliteValue } from '../src/internal/sqlite';

function createMemorySqliteDriver(overrides?: {
  history?: Partial<SqlStoreDriver['history']>;
  events?: Partial<SqlStoreDriver['events']>;
}) {
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
  initializeAgentRuntimeSqlite(database);
  const state = createSqliteStoreState(database);
  const driver: SqlStoreDriver = {
    conversations: sqlConversationPurge(sqliteDialect),
    transaction: (work, options) =>
      runSqliteTransaction(state, options?.access ?? 'write', work),
    ...sqlLedger(sqliteDialect),
    history: {
      ...sqlHistory(sqliteDialect),
      ...overrides?.history,
    },
    events: {
      ...sqlEvents(sqliteDialect),
      ...overrides?.events,
    },
    archive: sqlArchive(sqliteDialect),
    scanRecoverable: (input) =>
      scanSqlRecoverable(
        sqliteDialect,
        (work) => runSqliteTransaction(state, 'read', work),
        input,
      ),
  };
  return {
    driver,
    store: createAgentRuntimeStore(driver),
    close: () => closeSqliteStore(state),
  };
}

// Compile-time contract proofs: checked by `tsc --noEmit`.
export function driverContractTypeChecks(valid: AgentRuntimeStoreDriver<unknown>): void {
  const missingHasMessage: AgentRuntimeStoreDriver<unknown> = {
    ...valid,
    // @ts-expect-error history.hasMessage is required on every driver
    history: {
      load: valid.history.load,
      apply: valid.history.apply,
    },
  };
  const missingEventsFind: AgentRuntimeStoreDriver<unknown> = {
    ...valid,
    // @ts-expect-error events.find is required on every driver
    events: {
      append: valid.events.append,
      list: valid.events.list,
    },
  };
  void [missingHasMessage, missingEventsFind];

  void (() =>
    // @ts-expect-error capabilities and commitConflict are required
    runAgentStoreConformance({
      createStore: () => createMemoryAgentRuntimeStore(),
    }));

  void (() =>
    runAgentStoreConformance({
      createStore: () => createMemoryAgentRuntimeStore(),
      capabilities: { branch: true, planBranch: true, archive: true, historyRestore: true },
      // @ts-expect-error armCommitConflict was replaced by commitConflict
      armCommitConflict: () => undefined,
    }));
}

describe('store driver contract and conformance capabilities', () => {
  test('refuses capability mismatches in both directions (claimed vs implemented)', async () => {
    const base = createMemoryAgentRuntimeStore();
    const { branchConversation: _branch, ...withoutBranch } = base;
    const { planConversationBranch: _plan, ...withoutPlan } = base;
    const { branchConversation: _b, planConversationBranch: _p, ...withoutBoth } = base;

    await expect(
      runAgentStoreConformance({
        createStore: () => withoutBranch,
        capabilities: { branch: true, planBranch: true, archive: true, historyRestore: true },
        commitConflict: { impossible: 'single-writer' },
      }),
    ).rejects.toThrow(/capabilities\.branch/);

    await expect(
      runAgentStoreConformance({
        createStore: () => base,
        capabilities: {
          branch: false,
          planBranch: false,
          archive: true,
          historyRestore: true,
        },
        commitConflict: { impossible: 'single-writer' },
      }),
    ).rejects.toThrow(/capabilities\.branch/);

    await expect(
      runAgentStoreConformance({
        createStore: () => withoutPlan,
        capabilities: { branch: true, planBranch: true, archive: true, historyRestore: true },
        commitConflict: { impossible: 'single-writer' },
      }),
    ).rejects.toThrow(/capabilities\.planBranch/);

    await expect(
      runAgentStoreConformance({
        createStore: () => base,
        capabilities: { branch: true, planBranch: false, archive: true, historyRestore: true },
        commitConflict: { impossible: 'single-writer' },
      }),
    ).rejects.toThrow(/capabilities\.planBranch/);

    await expect(
      runAgentStoreConformance({
        createStore: () => withoutBoth,
        capabilities: { branch: false, planBranch: true, archive: true, historyRestore: true },
        commitConflict: { impossible: 'single-writer' },
      }),
    ).rejects.toThrow(/capabilities\.planBranch/);
  });

  test('passes conformance when optional branch capabilities are honestly declared false', async () => {
    const base = createMemoryAgentRuntimeStore();
    const {
      branchConversation: _branch,
      planConversationBranch: _plan,
      ...withoutBoth
    } = base;
    await runAgentStoreConformance({
      createStore: () => withoutBoth,
      capabilities: { branch: false, planBranch: false, archive: true, historyRestore: true },
      commitConflict: { impossible: 'single-writer' },
    });

    const withBranchOnly: AgentRuntimeStore = {
      ...withoutBoth,
      branchConversation: base.branchConversation,
    };
    await runAgentStoreConformance({
      createStore: () => withBranchOnly,
      capabilities: { branch: true, planBranch: false, archive: true, historyRestore: true },
      commitConflict: { impossible: 'single-writer' },
    });
  });

  test('a driver whose events.find always returns undefined fails conformance', async () => {
    const broken = createMemorySqliteDriver({
      events: {
        find: async () => undefined,
      },
    });
    await expect(
      runAgentStoreConformance({
        createStore: () => broken.store,
        capabilities: { branch: true, planBranch: true, archive: true, historyRestore: true },
        commitConflict: { impossible: 'single-writer' },
        cleanup: () => broken.close(),
      }),
    ).rejects.toThrow();
  });

  test('a driver whose events.find returns undefined and append allows duplicates still fails conformance', async () => {
    let suffix = 0;
    const broken = createMemorySqliteDriver({
      events: {
        find: async () => undefined,
        append: (transaction, event) =>
          sqlEvents(sqliteDialect).append(transaction, {
            ...event,
            eventId: `${event.eventId}-dup-${++suffix}`,
          }),
      },
    });
    await expect(
      runAgentStoreConformance({
        createStore: () => broken.store,
        capabilities: { branch: true, planBranch: true, archive: true, historyRestore: true },
        commitConflict: { impossible: 'single-writer' },
        cleanup: () => broken.close(),
      }),
    ).rejects.toThrow(/Event-once conformance/);
  });

  test('a driver whose history.hasMessage always returns false fails conformance after compaction', async () => {
    const broken = createMemorySqliteDriver({
      history: {
        hasMessage: async () => false,
      },
    });
    await expect(
      runAgentStoreConformance({
        createStore: () => broken.store,
        capabilities: { branch: true, planBranch: true, archive: true, historyRestore: true },
        commitConflict: { impossible: 'single-writer' },
        cleanup: () => broken.close(),
      }),
    ).rejects.toThrow(/Seed conformance: compacted instructions resurrected/);
  });

  test('appendEventOnce and findEventOnce call driver.events.find directly without scanning list()', async () => {
    let listCalls = 0;
    const probe = createMemorySqliteDriver({
      events: {
        list: async (transaction, input) => {
          listCalls += 1;
          return sqlEvents(sqliteDialect).list(transaction, input);
        },
      },
    });
    try {
      const first = await probe.store.appendEventOnce?.(
        { conversationId: 'conv-a', kind: 'state/set', payload: { n: 1 } },
        'k1',
      );
      const duplicate = await probe.store.appendEventOnce?.(
        { conversationId: 'conv-a', kind: 'state/set', payload: { n: 2 } },
        'k1',
      );
      const found = await probe.store.findEventOnce?.({
        conversationId: 'conv-a',
        kind: 'state/set',
        key: 'k1',
      });
      const other = await probe.store.findEventOnce?.({
        conversationId: 'conv-b',
        kind: 'state/set',
        key: 'k1',
      });
      expect(first?.outcome).toBe('applied');
      expect(duplicate?.outcome).toBe('duplicate');
      expect(duplicate?.event.seq).toBe(first?.event.seq);
      expect(found?.seq).toBe(first?.event.seq);
      expect(other).toBeUndefined();
      expect(listCalls).toBe(0);
    } finally {
      await probe.close();
    }
  });
});
