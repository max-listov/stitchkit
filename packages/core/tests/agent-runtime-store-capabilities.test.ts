import { Database } from 'bun:sqlite';
import { describe, expect, test } from 'bun:test';
import { createHash } from 'node:crypto';
import { z } from 'zod';
import { createAgentSpillStore } from '../src/agent-runtime/spill';
import { sqlArchive, sqlEvents } from '../src/agent-runtime/sql-events';
import { sqlHistory } from '../src/agent-runtime/sql-history';
import { sqlLedger } from '../src/agent-runtime/sql-ledger';
import { sqlConversationPurge } from '../src/agent-runtime/sql-purge';
import { scanSqlRecoverable } from '../src/agent-runtime/sql-reads';
import type { SqlStoreDriver } from '../src/agent-runtime/sql-rows';
import { createBunSqliteAgentRuntimeStore } from '../src/agent-runtime/sqlite-bun';
import { initializeAgentRuntimeSqlite } from '../src/agent-runtime/sqlite-schema';
import {
  closeSqliteStore,
  createSqliteStoreState,
  runSqliteTransaction,
  sqliteDialect,
} from '../src/agent-runtime/sqlite-transactions';
import { eventOnceId } from '../src/agent-runtime/store-event-once';
import {
  type AgentConversationArchive,
  AgentMessageSchema,
  type AgentRuntimeStore,
  AgentStoreUnsupportedCapabilityError,
  createAgentRuntimeStore,
  createMemoryAgentRuntimeStore,
  decodeAgentConversationArchive,
  encodeAgentConversationArchive,
} from '../src/entrypoints/agent-runtime';
import { runAgentStoreConformance } from '../src/entrypoints/agent-runtime/testing';
import type { SqliteDatabase, SqliteValue } from '../src/internal/sqlite';
import { branchTurn } from './support/agent-branch-fixture';

const at = '2026-08-22T00:00:00.000Z';

function sqliteStore(
  members: { archive: boolean; restore: boolean },
  override: (driver: SqlStoreDriver) => SqlStoreDriver = (driver) => driver,
) {
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
  const { restore, ...history } = sqlHistory(sqliteDialect);
  const driver: SqlStoreDriver = {
    conversations: sqlConversationPurge(sqliteDialect),
    transaction: (work, options) =>
      runSqliteTransaction(state, options?.access ?? 'write', work),
    ...sqlLedger(sqliteDialect),
    history: { ...history, ...(members.restore && { restore }) },
    events: sqlEvents(sqliteDialect),
    ...(members.archive && { archive: sqlArchive(sqliteDialect) }),
    scanRecoverable: (input) =>
      scanSqlRecoverable(
        sqliteDialect,
        (work) => runSqliteTransaction(state, 'read', work),
        input,
      ),
  };
  return {
    driver,
    store: createAgentRuntimeStore(override(driver)),
    close: () => closeSqliteStore(state),
  };
}

function text(conversationId: string, id: string, role: 'user' | 'summary' = 'user') {
  return AgentMessageSchema.parse({
    schemaVersion: 1,
    id,
    conversationId,
    role,
    status: 'committed',
    parts: [{ type: 'text', text: id }],
    createdAt: at,
    updatedAt: at,
  });
}

/** A migrated conversation whose first message survives only as a compacted row. */
function compactedBaseline(conversationId: string): Uint8Array {
  const input = text(conversationId, 'input');
  const summary = text(conversationId, 'summary', 'summary');
  const head = { schemaVersion: 1, conversationId, version: 2 };
  const archive: AgentConversationArchive = {
    format: 'stitchkit.agent-conversation',
    formatVersion: 1,
    conversationId,
    events: [
      {
        schemaVersion: 1,
        eventId: `${conversationId}-baseline`,
        conversationId,
        seq: 1,
        kind: 'runtime/baseline',
        occurredAt: at,
        payload: z.json().parse({
          migratedAt: at,
          head,
          messages: [input, summary],
          compacted: [input.id],
          runs: [],
          admissions: [],
        }),
      },
    ],
    projections: [
      {
        archiveType: 'runtime-snapshot',
        snapshot: z.json().parse({ ...head, messages: [summary], runs: [] }),
      },
    ],
    spills: [],
  };
  return encodeAgentConversationArchive(archive);
}

/** One plain turn exported from memory, with a spill and a companion projection added. */
async function withCompanions(conversationId: string): Promise<Uint8Array> {
  const origin = createMemoryAgentRuntimeStore();
  await origin.appendEvent({ conversationId, kind: 'state/set', payload: { name: 'n' } });
  const archive = decodeAgentConversationArchive(
    await origin.exportConversation(conversationId),
  );
  archive.spills = [
    {
      reference: `${conversationId}-spill`,
      bytes: 3,
      sha256: createHash('sha256').update('abc').digest('hex'),
      base64: 'YWJj',
      mediaType: 'text/plain',
      createdAt: at,
    },
  ];
  archive.projections = [
    ...archive.projections,
    { name: 'companion', version: 1, uptoSeq: 1, value: { kept: true }, updatedAt: at },
  ];
  return encodeAgentConversationArchive(archive);
}

async function expectRefusedEmpty(
  store: AgentRuntimeStore,
  conversationId: string,
  run: () => Promise<unknown>,
  capability: 'archive' | 'historyRestore',
): Promise<void> {
  const refusal = await run().then(
    () => undefined,
    (error: unknown) => error,
  );
  expect(refusal).toBeInstanceOf(AgentStoreUnsupportedCapabilityError);
  expect(refusal).toBeInstanceOf(TypeError);
  expect(refusal).toMatchObject({ capability });
  expect((await store.readEvents({ conversationId, limit: 5 })).items).toEqual([]);
  expect((await store.loadSnapshot(conversationId)).version).toBe(0);
}

describe('agent store optional capabilities', () => {
  test('a store reports what its driver implements, frozen', () => {
    const full = sqliteStore({ archive: true, restore: true });
    const bare = sqliteStore({ archive: false, restore: false });
    try {
      expect(full.store.capabilities).toEqual({
        archive: true,
        historyRestore: true,
        purge: true,
      });
      expect(bare.store.capabilities).toEqual({
        archive: false,
        historyRestore: false,
        purge: true,
      });
      expect(Object.isFrozen(full.store.capabilities)).toBe(true);
      expect(createMemoryAgentRuntimeStore().capabilities).toEqual({
        archive: true,
        historyRestore: true,
        purge: true,
      });
    } finally {
      full.close();
      bare.close();
    }
  });

  test('a half-implemented archive is refused when the store is built', () => {
    const { driver, close } = sqliteStore({ archive: true, restore: true });
    try {
      const archive = sqlArchive(sqliteDialect);
      Reflect.deleteProperty(archive, 'import');
      expect(() => createAgentRuntimeStore({ ...driver, archive })).toThrow(
        'An agent store driver archive needs both export and import',
      );
    } finally {
      close();
    }
  });

  test('without archive, an import carrying spills or companions is refused before any write', async () => {
    const bare = sqliteStore({ archive: false, restore: true });
    try {
      const bytes = await withCompanions('with-companions');
      await expectRefusedEmpty(
        bare.store,
        'with-companions',
        () => bare.store.importConversation(bytes),
        'archive',
      );
    } finally {
      bare.close();
    }
  });

  test('without history.restore, a compacted baseline is refused instead of resurrected', async () => {
    const bare = sqliteStore({ archive: true, restore: false });
    try {
      await expectRefusedEmpty(
        bare.store,
        'migrated',
        () => bare.store.importConversation(compactedBaseline('migrated')),
        'historyRestore',
      );
    } finally {
      bare.close();
    }
  });

  test('plan and branch refuse a source the driver cannot carry, the same way', async () => {
    const bare = sqliteStore({ archive: true, restore: false });
    try {
      const input = {
        requestKey: 'copy',
        destinationConversationId: 'copy',
        source: { kind: 'archive' as const, bytes: compactedBaseline('migrated') },
      };
      for (const run of [
        () => bare.store.planConversationBranch(input),
        () => bare.store.branchConversation(input),
      ])
        await expectRefusedEmpty(bare.store, 'copy', run, 'historyRestore');
    } finally {
      bare.close();
    }
  });

  test('the memory store keeps companion projections through import and export', async () => {
    const store = createMemoryAgentRuntimeStore();
    await store.importConversation(await withCompanions('kept'));
    const exported = decodeAgentConversationArchive(await store.exportConversation('kept'));
    expect(exported.projections).toContainEqual({
      name: 'companion',
      version: 1,
      uptoSeq: 1,
      value: { kept: true },
      updatedAt: at,
    });
    expect(exported.spills).toHaveLength(1);
  });

  describe('the conformance kit', () => {
    const conformance = (
      store: () => AgentRuntimeStore,
      capabilities: { archive: boolean; historyRestore: boolean },
    ) =>
      runAgentStoreConformance({
        createStore: store,
        capabilities: { branch: true, planBranch: true, ...capabilities },
        commitConflict: { impossible: 'single-writer' },
      });

    test('a driver without both members passes when it declares them false', async () => {
      const bare = sqliteStore({ archive: false, restore: false });
      try {
        await conformance(() => bare.store, { archive: false, historyRestore: false });
      } finally {
        bare.close();
      }
    });

    test('a declaration that disagrees with the store fails', async () => {
      const bare = sqliteStore({ archive: false, restore: true });
      try {
        await expect(
          conformance(() => bare.store, { archive: true, historyRestore: true }),
        ).rejects.toThrow(
          'capabilities.archive is true, but store.capabilities.archive is false',
        );
      } finally {
        bare.close();
      }
    });

    test('a refusal that is not AgentStoreUnsupportedCapabilityError fails', async () => {
      const bare = sqliteStore({ archive: false, restore: false });
      try {
        const plain: AgentRuntimeStore = {
          ...bare.store,
          importConversation: async (bytes) => {
            const archive = decodeAgentConversationArchive(bytes);
            if (archive.spills.length > 0) throw new TypeError('no archive here');
            return bare.store.importConversation(bytes);
          },
        };
        await expect(
          conformance(() => plain, { archive: false, historyRestore: false }),
        ).rejects.toThrow(
          "a store without archive must refuse with AgentStoreUnsupportedCapabilityError('archive'), received TypeError: no archive here",
        );
      } finally {
        bare.close();
      }
    });

    test('a capabilities declaration without the driver members is refused', async () => {
      await expect(
        runAgentStoreConformance({
          createStore: createMemoryAgentRuntimeStore,
          // @ts-expect-error the declaration names every optional member
          capabilities: { branch: true, planBranch: true },
          commitConflict: { impossible: 'single-writer' },
        }),
      ).rejects.toThrow('archive: boolean, historyRestore: boolean');
    });
  });
});

test('a once-only event id names its conversation, so ids never collide across conversations', () => {
  expect(eventOnceId('a', 'state/set', 'k')).not.toBe(eventOnceId('b', 'state/set', 'k'));
  expect(eventOnceId('a', 'state/set', 'k')).toBe(eventOnceId('a', 'state/set', 'k'));
});

test('the memory store refuses two companion projections with one name, as a durable store does', async () => {
  const store = createMemoryAgentRuntimeStore();
  const archive = decodeAgentConversationArchive(await withCompanions('twice'));
  archive.projections = [
    ...archive.projections,
    { name: 'companion', version: 2, uptoSeq: 1, value: { kept: false }, updatedAt: at },
  ];
  await expect(
    store.importConversation(encodeAgentConversationArchive(archive)),
  ).rejects.toThrow('Conversation archive projection name is repeated');
  expect((await store.readEvents({ conversationId: 'twice', limit: 1 })).items).toEqual([]);
});

describe('refusals and the kit, one check at a time', () => {
  test('without archive, a branch source with spills is refused by plan and branch', async () => {
    const source = createBunSqliteAgentRuntimeStore({ filename: ':memory:' });
    const bare = sqliteStore({ archive: false, restore: true });
    try {
      const spills = createAgentSpillStore({
        host: source.host,
        conversationId: 'source',
        runId: 'first',
      });
      const { reference } = await spills.write({
        data: new TextEncoder().encode('full artifact payload'),
        mediaType: 'text/plain',
        authorization: { operation: 'read', path: 'source-only' },
        toolCallId: 'call',
      });
      await branchTurn(source.store, 'source', 'first', [
        { type: 'tool-call', callId: 'call', toolName: 'run_command', input: {} },
        {
          type: 'tool-result',
          callId: 'call',
          toolName: 'run_command',
          outcome: 'success',
          output: {
            executable: 'fixture',
            exitCode: 0,
            signal: null,
            stdout: 'preview',
            stderr: '',
            outcome: 'exited',
            artifact: {
              reference,
              bytes: 21,
              truncated: true,
              headBytes: 0,
              tailBytes: 0,
              omittedBytes: 21,
            },
          },
        },
        { type: 'file', reference, mediaType: 'text/plain' },
      ]);
      const input = {
        requestKey: 'copy',
        destinationConversationId: 'copy',
        artifactAuthorization: { operation: 'read' as const, path: 'destination' },
        source: {
          kind: 'archive' as const,
          bytes: await source.store.exportConversation('source'),
        },
      };
      for (const run of [
        () => bare.store.planConversationBranch(input),
        () => bare.store.branchConversation(input),
      ])
        await expectRefusedEmpty(bare.store, 'copy', run, 'archive');
    } finally {
      bare.close();
      await source.close();
    }
  });

  test('without archive, an import carrying only a companion projection is refused', async () => {
    const bare = sqliteStore({ archive: false, restore: true });
    try {
      const archive = decodeAgentConversationArchive(await withCompanions('companion-only'));
      archive.spills = [];
      await expectRefusedEmpty(
        bare.store,
        'companion-only',
        () => bare.store.importConversation(encodeAgentConversationArchive(archive)),
        'archive',
      );
    } finally {
      bare.close();
    }
  });

  const kit = (store: AgentRuntimeStore, archive: boolean, historyRestore: boolean) =>
    runAgentStoreConformance({
      createStore: () => store,
      capabilities: { branch: true, planBranch: true, archive, historyRestore },
      commitConflict: { impossible: 'single-writer' },
    });

  test('the kit is red on a refusal that wrote before it refused', async () => {
    const bare = sqliteStore({ archive: false, restore: true });
    try {
      const leaky: AgentRuntimeStore = {
        ...bare.store,
        importConversation: async (bytes) => {
          const archive = decodeAgentConversationArchive(bytes);
          if (archive.spills.length === 0) return bare.store.importConversation(bytes);
          await bare.store.importConversation(
            encodeAgentConversationArchive({
              ...archive,
              spills: [],
              projections: archive.projections.slice(0, 1),
            }),
          );
          throw new AgentStoreUnsupportedCapabilityError(
            'archive',
            'the source carries spills',
          );
        },
      };
      await expect(kit(leaky, false, true)).rejects.toThrow(
        'must leave the conversation empty',
      );
    } finally {
      bare.close();
    }
  });

  test('the kit is red on an archive that loses its spill, and on a restore that revives a compacted row', async () => {
    const dropsSpills = sqliteStore({ archive: true, restore: true }, (driver) => ({
      ...driver,
      archive: {
        export: sqlArchive(sqliteDialect).export,
        import: (transaction, archive) =>
          sqlArchive(sqliteDialect).import(transaction, { ...archive, spills: [] }),
      },
    }));
    const revives = sqliteStore({ archive: true, restore: true }, (driver) => ({
      ...driver,
      history: {
        ...driver.history,
        restore: (transaction, input) =>
          sqlHistory(sqliteDialect).restore?.(transaction, {
            ...input,
            compactedMessageIds: [],
          }) ?? Promise.resolve(),
      },
    }));
    try {
      await expect(kit(dropsSpills.store, true, true)).rejects.toThrow('changed its spill');
      await expect(kit(revives.store, true, true)).rejects.toThrow(
        'a compacted baseline row came back active',
      );
    } finally {
      dropsSpills.close();
      revives.close();
    }
  });

  test('the kit is red on a restore whose compacted row a fresh seed key revives', async () => {
    const forgets = sqliteStore({ archive: true, restore: true }, (driver) => ({
      ...driver,
      history: {
        ...driver.history,
        hasMessage: async (transaction, input) =>
          input.messageId === 'restored-input'
            ? false
            : driver.history.hasMessage(transaction, input),
      },
    }));
    try {
      await expect(kit(forgets.store, true, true)).rejects.toThrow(
        'a seed resurrected a compacted row restored from a baseline',
      );
    } finally {
      forgets.close();
    }
  });

  test('the kit refuses a declaration with an unknown member and a store without capabilities', async () => {
    const store = createMemoryAgentRuntimeStore();
    await expect(
      runAgentStoreConformance({
        createStore: () => store,
        capabilities: {
          branch: true,
          planBranch: true,
          archive: true,
          historyRestore: true,
          // @ts-expect-error an undeclared member is refused, not ignored
          purge: true,
        },
        commitConflict: { impossible: 'single-writer' },
      }),
    ).rejects.toThrow(TypeError);
    const { capabilities: _dropped, ...withoutCapabilities } = store;
    await expect(kit(withoutCapabilities, true, true)).rejects.toThrow(
      'store.capabilities is missing',
    );
  });

  test('a history.restore that is not a function is refused when the store is built', () => {
    const { driver, close } = sqliteStore({ archive: true, restore: true });
    try {
      expect(() =>
        createAgentRuntimeStore({
          ...driver,
          history: { ...driver.history, restore: Object.freeze({}) as never },
        }),
      ).toThrow('history.restore must be a function');
    } finally {
      close();
    }
  });
});
