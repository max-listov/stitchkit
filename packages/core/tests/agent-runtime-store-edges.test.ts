/**
 * Edges of the agent store and its companions: how a Postgres error is recognised
 * through a driver's wrapping, what event search refuses, a child spawn that collides
 * with a live child or outlives its conversation, a stop a concurrent step earns, spill
 * cleanup under concurrency, and spill authorization on every way in and out.
 */
import { describe, expect, test } from 'bun:test';
import { createAgentChildManager } from '../src/agent-runtime/children';
import { createAgentEventSearch } from '../src/agent-runtime/event-search';
import { postgresEventSearchBackend } from '../src/agent-runtime/event-search-postgres';
import {
  isRetryablePostgresConflict,
  postgresErrorState,
} from '../src/agent-runtime/postgres-transactions';
import { createAgentSpillStore } from '../src/agent-runtime/spill';
import { createBunSqliteAgentRuntimeStore } from '../src/agent-runtime/sqlite-bun';
import {
  type AgentCompanionHost,
  type AgentCompanionScope,
  createAgentEventSearch as publicEventSearch,
} from '../src/entrypoints/agent-runtime';

describe('agent store and companion edges', () => {
  test('postgresErrorState unwraps Prisma P2010, driverAdapterError, and ignores Prisma P-codes', () => {
    expect(
      postgresErrorState({
        code: 'P2010',
        message: 'Raw query failed. Code: `54000`. Message: string is too long for tsvector',
      }),
    ).toBe('54000');
    expect(
      postgresErrorState({
        code: 'P2010',
        meta: {
          driverAdapterError: {
            cause: { originalCode: '25001' },
          },
        },
      }),
    ).toBe('25001');
    expect(
      postgresErrorState({
        code: 'P2002',
        meta: { target: ['id'] },
      }),
    ).toBeUndefined();
    expect(
      isRetryablePostgresConflict({
        code: 'P2010',
        meta: { driverAdapterError: { cause: { originalCode: '40001' } } },
      }),
    ).toBe(true);
  });

  test('event-search rejects invalid limit and invalid diacritics', async () => {
    const owner = createBunSqliteAgentRuntimeStore({ filename: ':memory:' });
    try {
      expect(() =>
        postgresEventSearchBackend(owner.host, JSON.parse('{"diacritics":"bogus"}')),
      ).toThrow(/diacritics/);
      const search = createAgentEventSearch({ host: owner.host });
      for (const bad of [0, -1, 1.5, Number.NaN, Number.POSITIVE_INFINITY]) {
        await expect(
          search({ requestingConversationId: 'c1', query: 'hello', limit: bad }),
        ).rejects.toThrow(/positive safe integer/);
      }
    } finally {
      await owner.close();
    }
  });

  test('a Postgres index write whose savepoint rollback fails too reports both, the write first', async () => {
    const owner = createBunSqliteAgentRuntimeStore({ filename: ':memory:' });
    const indexFailure = new Error('index write failed');
    const rollbackFailure = new Error('savepoint rollback failed');
    // A Postgres host that answers just what one search over one event asks.
    const session: AgentCompanionScope = {
      get: async (sql) => {
        if (sql.includes('numnode')) return { count: 1 };
        if (sql.includes("key = 'event_search_diacritics'")) return { value: 'preserve' };
        return undefined;
      },
      all: async (sql) => {
        if (sql.includes('LEFT JOIN'))
          return [{ conversation_id: 'c1', last_seq: 1, indexed_seq: 0 }];
        if (sql.includes('SELECT seq, occurred_at, payload'))
          return [{ seq: 1, occurred_at: '2026-11-25T00:00:00.000Z', payload: 'hello' }];
        return [];
      },
      run: async (sql) => {
        if (sql.startsWith('INSERT INTO') && sql.includes('to_tsvector')) throw indexFailure;
        if (sql.startsWith('ROLLBACK TO SAVEPOINT')) throw rollbackFailure;
      },
      appendEvent: async () => {
        throw new Error('not appended');
      },
    };
    const host: AgentCompanionHost = {
      dialect: 'postgres',
      tables: owner.host.tables,
      read: (work) => work(session),
      transaction: (_conversationId, work) => work(session),
    };
    try {
      const failure = await publicEventSearch({ host })({
        requestingConversationId: 'c1',
        query: 'hello',
      }).then(
        () => undefined,
        (error: unknown) => error,
      );
      expect(failure).toBeInstanceOf(AggregateError);
      const aggregate = failure instanceof AggregateError ? failure : undefined;
      expect(aggregate?.cause).toBe(indexFailure);
      expect(aggregate?.errors).toEqual([indexFailure, rollbackFailure]);
    } finally {
      await owner.close();
    }
  });

  test('children-spawn collision preserves existing live child without marking it lost', async () => {
    const owner = createBunSqliteAgentRuntimeStore({ filename: ':memory:' });
    try {
      const manager = createAgentChildManager({
        store: owner.store,
        host: owner.host,
        maxActiveChildren: 4,
        remainingBudget: () => ({ tokens: 1_000 }),
        spawn: () => ({ result: new Promise(() => undefined), stopPolicy: () => undefined }),
      });
      await manager.spawnChild({
        parentConversationId: 'parent',
        childConversationId: 'child-1',
        childInput: {},
        budget: { tokens: 10 },
      });
      await expect(
        manager.spawnChild({
          parentConversationId: 'parent',
          childConversationId: 'child-1',
          childInput: {},
          budget: { tokens: 10 },
        }),
      ).rejects.toThrow();
      const [child] = await manager.listChildren('parent');
      expect(child?.state).toBe('running');
    } finally {
      await owner.close();
    }
  });

  test('children-state still notifies parent when child conversation was purged', async () => {
    const owner = createBunSqliteAgentRuntimeStore({ filename: ':memory:' });
    try {
      let resolveChild: ((value: { resultReference?: string }) => void) | undefined;
      const manager = createAgentChildManager({
        store: owner.store,
        host: owner.host,
        maxActiveChildren: 4,
        remainingBudget: () => ({ tokens: 1_000 }),
        spawn: () => ({
          result: new Promise<{ resultReference?: string }>((resolve) => {
            resolveChild = resolve;
          }),
          stopPolicy: () => undefined,
        }),
      });
      await manager.spawnChild({
        parentConversationId: 'parent',
        childConversationId: 'child-purged',
        childInput: {},
        budget: { tokens: 10 },
      });
      await owner.store.purgeConversation?.({ conversationId: 'child-purged' });
      resolveChild?.({});
      await Bun.sleep(20);
      const events = await owner.store.readEvents({ conversationId: 'parent', limit: 20 });
      expect(
        events.items.some(
          (event) =>
            event.kind === 'child/state' &&
            typeof event.payload === 'object' &&
            event.payload !== null &&
            'state' in event.payload &&
            event.payload.state === 'finished',
        ),
      ).toBe(true);
    } finally {
      await owner.close();
    }
  });

  test('children-usage invokes stopPolicy when concurrent steps push total over budget', async () => {
    const owner = createBunSqliteAgentRuntimeStore({ filename: ':memory:' });
    try {
      const stopped: string[] = [];
      const manager = createAgentChildManager({
        store: owner.store,
        host: owner.host,
        maxActiveChildren: 4,
        remainingBudget: () => ({ tokens: 1_000 }),
        spawn: () => ({
          result: new Promise(() => undefined),
          stopPolicy: (name) => {
            stopped.push(name);
          },
        }),
      });
      await manager.spawnChild({
        parentConversationId: 'parent',
        childConversationId: 'child-budget',
        childInput: {},
        budget: { tokens: 10 },
      });
      const step = () =>
        manager.recordStepUsage({
          childConversationId: 'child-budget',
          usage: {
            inputTokens: { value: 4, provenance: 'provider-reported' },
            outputTokens: { value: 4, provenance: 'provider-reported' },
          },
          elapsedMs: 1,
        });
      // Neither step alone exceeds 10, but together they hit 16 > 10.
      const results = await Promise.all([step(), step()]);
      expect(results.some((r) => r.stop && r.enforced)).toBe(true);
      expect(stopped).toContain('child-budget');
    } finally {
      await owner.close();
    }
  });

  test('spill cleanup does not double-delete or emit duplicate spill/deleted events under concurrency', async () => {
    const owner = createBunSqliteAgentRuntimeStore({ filename: ':memory:' });
    try {
      let clock = Date.parse('2026-11-24T00:00:00.000Z');
      const spills = createAgentSpillStore({
        host: owner.host,
        conversationId: 'spilled',
        retentionMs: 1_000,
        now: () => new Date(clock),
      });
      await spills.write({
        mediaType: 'text/plain',
        data: new TextEncoder().encode('hello'),
      });
      clock += 2_000;
      const [a, b] = await Promise.all([spills.cleanup(), spills.cleanup()]);
      expect(a.deleted + b.deleted).toBe(1);
      const events = await owner.store.readEvents({ conversationId: 'spilled', limit: 20 });
      expect(events.items.filter((e) => e.kind === 'spill/deleted')).toHaveLength(1);
    } finally {
      await owner.close();
    }
  });

  test('spill authorization rejects invalid values on write, read, export and import, and round-trips valid authorization', async () => {
    const source = createBunSqliteAgentRuntimeStore({ filename: ':memory:' });
    const target = createBunSqliteAgentRuntimeStore({ filename: ':memory:' });
    try {
      const spills = createAgentSpillStore({
        host: source.host,
        conversationId: 'auth-validation',
      });
      const invalidCases = [
        ['false', /expected object, received boolean/],
        ['{"operation":"bogus"}', /invalid_union|operation/],
      ] as const;
      for (const [bad, pattern] of invalidCases) {
        await expect(
          spills.write({
            mediaType: 'text/plain',
            data: new TextEncoder().encode('rejected'),
            authorization: JSON.parse(bad),
          }),
        ).rejects.toThrow(pattern);
      }
      expect(
        (await source.store.readEvents({ conversationId: 'auth-validation', limit: 10 }))
          .items,
      ).toEqual([]);

      const validAuth = { operation: 'read', path: 'notes.md' } as const;
      const { reference } = await spills.write({
        mediaType: 'text/plain',
        data: new TextEncoder().encode('secret'),
        authorization: validAuth,
      });
      expect(await spills.authorization?.(reference)).toEqual(validAuth);
      const read = await spills.read({ reference, offset: 0, maxBytes: 64 });
      expect(read.authorization).toEqual(validAuth);

      const exported = await source.store.exportConversation('auth-validation');
      await target.store.importConversation(exported);
      const restoredSpills = createAgentSpillStore({
        host: target.host,
        conversationId: 'auth-validation',
      });
      expect(await restoredSpills.authorization?.(reference)).toEqual(validAuth);
      expect(
        (await restoredSpills.read({ reference, offset: 0, maxBytes: 64 })).authorization,
      ).toEqual(validAuth);

      for (const [bad, pattern] of invalidCases) {
        const freshTarget = createBunSqliteAgentRuntimeStore({ filename: ':memory:' });
        try {
          const tampered = JSON.parse(new TextDecoder().decode(exported));
          tampered.spills[0].authorization = JSON.parse(bad);
          await expect(
            freshTarget.store.importConversation(
              new TextEncoder().encode(JSON.stringify(tampered)),
            ),
          ).rejects.toThrow(pattern);
        } finally {
          await freshTarget.close();
        }
      }
      const digestTarget = createBunSqliteAgentRuntimeStore({ filename: ':memory:' });
      try {
        const badDigest = JSON.parse(new TextDecoder().decode(exported));
        badDigest.spills[0].sha256 = '0'.repeat(64);
        await expect(
          digestTarget.store.importConversation(
            new TextEncoder().encode(JSON.stringify(badDigest)),
          ),
        ).rejects.toThrow(/bytes or digest are inconsistent/i);
      } finally {
        await digestTarget.close();
      }

      // Corrupt database rows must be rejected on read, authorization lookup, and export.
      for (const [corruptPayload, pattern] of invalidCases) {
        await source.host.transaction('auth-validation', async (scope) => {
          await scope.run(
            `UPDATE ${source.host.tables.spills} SET authorization_payload = ? WHERE reference_id = ?`,
            [corruptPayload, reference],
          );
        });
        await expect(spills.authorization?.(reference)).rejects.toThrow(pattern);
        await expect(spills.read({ reference, offset: 0, maxBytes: 64 })).rejects.toThrow(
          pattern,
        );
        await expect(source.store.exportConversation('auth-validation')).rejects.toThrow(
          pattern,
        );
      }
    } finally {
      await source.close();
      await target.close();
    }
  });
});
