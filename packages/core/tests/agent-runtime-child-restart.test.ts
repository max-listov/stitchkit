import { Database } from 'bun:sqlite';
import { describe, expect, test } from 'bun:test';
import { createSqliteAgentChildManager } from '../src/agent-runtime';
import {
  createSqliteAgentRuntimeStore,
  type SqliteDatabase,
  type SqliteValue,
} from '../src/agent-runtime-sqlite-bun';

function sqlite(): SqliteDatabase {
  const raw = new Database(':memory:');
  return {
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
}

describe('child records across a restart', () => {
  test('a child without a handle in this process is lost, not stopped, and a late result does not revive it', async () => {
    const database = sqlite();
    const runtime = createSqliteAgentRuntimeStore({ database });
    const result = Promise.withResolvers<{ resultReference?: string }>();
    const stops: string[] = [];
    const before = createSqliteAgentChildManager({
      sqlite: runtime,
      spawn: () => ({
        result: result.promise,
        stopPolicy: (name) => {
          stops.push(name);
        },
      }),
    });
    await before.spawnChild({
      parentConversationId: 'parent',
      childConversationId: 'child',
      childInput: {},
      budget: { tokens: 10 },
    });
    // The process restarts: a new manager over the same rows, no handles.
    const after = createSqliteAgentChildManager({
      sqlite: runtime,
      spawn: () => {
        throw new Error('not spawned here');
      },
    });
    await after.stopChildren('parent');
    expect(after.listChildren('parent').map((record) => record.state)).toEqual(['lost']);
    expect(stops).toEqual([]);
    // The old process's child settles later; `lost` stands.
    result.resolve({ resultReference: 'late' });
    await before.waitChild('child');
    expect(
      after.listChildren('parent').map((record) => [record.state, record.resultReference]),
    ).toEqual([['lost', undefined]]);
    await runtime.close();
  });

  test('a spawn that throws leaves no record and no event', async () => {
    const database = sqlite();
    const runtime = createSqliteAgentRuntimeStore({ database });
    const children = createSqliteAgentChildManager({
      sqlite: runtime,
      spawn: () => {
        throw new Error('host refused');
      },
    });
    await expect(
      children.spawnChild({
        parentConversationId: 'parent',
        childInput: {},
        budget: { tokens: 1 },
      }),
    ).rejects.toThrow('host refused');
    expect(children.listChildren('parent')).toEqual([]);
    expect(
      (await runtime.store.readEvents({ conversationId: 'parent', limit: 10 })).items.map(
        (event) => event.kind,
      ),
    ).not.toContain('child/spawned');
    await runtime.close();
  });

  test('a child that finishes while its host is being asked keeps finished and its result', async () => {
    const database = sqlite();
    const runtime = createSqliteAgentRuntimeStore({ database });
    const result = Promise.withResolvers<{ resultReference?: string }>();
    const children = createSqliteAgentChildManager({
      sqlite: runtime,
      spawn: () => ({
        result: result.promise,
        stopPolicy: () => undefined,
        reachable: async () => {
          // The child settles while the parent is asking whether it is there.
          result.resolve({ resultReference: 'answer' });
          await new Promise((resolve) => setTimeout(resolve, 30));
          return true;
        },
      }),
    });
    await children.spawnChild({
      parentConversationId: 'parent',
      childConversationId: 'child',
      childInput: {},
      budget: { tokens: 10 },
    });
    await children.stopChildren('parent');
    await children.waitChild('child');
    expect(
      children.listChildren('parent').map((record) => [record.state, record.resultReference]),
    ).toEqual([['finished', 'answer']]);
    await runtime.close();
  });

  test('a budget decision without a handle is recorded as not enforced', async () => {
    const database = sqlite();
    const runtime = createSqliteAgentRuntimeStore({ database });
    const before = createSqliteAgentChildManager({
      sqlite: runtime,
      spawn: () => ({ result: new Promise(() => undefined), stopPolicy: () => undefined }),
    });
    await before.spawnChild({
      parentConversationId: 'parent',
      childConversationId: 'child',
      childInput: {},
      budget: { tokens: 1 },
    });
    const after = createSqliteAgentChildManager({
      sqlite: runtime,
      spawn: () => {
        throw new Error('not here');
      },
    });
    const boundary = await after.recordStepUsage({
      childConversationId: 'child',
      usage: {
        inputTokens: { value: 1, provenance: 'provider-reported' },
        outputTokens: { value: 1, provenance: 'provider-reported' },
      },
      elapsedMs: 1,
    });
    expect(boundary).toMatchObject({
      stop: true,
      enforced: false,
      policyName: 'child-budget',
    });
    await runtime.close();
  });

  test('a child settling after its parent was purged records itself without an unhandled rejection', async () => {
    const database = sqlite();
    const runtime = createSqliteAgentRuntimeStore({ database });
    const result = Promise.withResolvers<{ resultReference?: string }>();
    const children = createSqliteAgentChildManager({
      sqlite: runtime,
      spawn: () => ({ result: result.promise, stopPolicy: () => undefined }),
    });
    await children.spawnChild({
      parentConversationId: 'parent',
      childConversationId: 'child',
      childInput: {},
      budget: { tokens: 10 },
    });
    const purge = runtime.store.purgeConversation;
    if (!purge) throw new Error('SQLite store is expected to purge');
    await purge.call(runtime.store, { conversationId: 'parent' });
    const unhandled: unknown[] = [];
    const onUnhandled = (error: unknown) => {
      unhandled.push(error);
    };
    process.on('unhandledRejection', onUnhandled);
    try {
      result.resolve({ resultReference: 'late answer' });
      await children.waitChild('child');
      await new Promise((resolve) => setTimeout(resolve, 20));
    } finally {
      process.off('unhandledRejection', onUnhandled);
    }
    expect(unhandled).toEqual([]);
    const states = (
      await runtime.store.readEvents({ conversationId: 'child', limit: 20 })
    ).items
      .filter((event) => event.kind === 'child/state')
      .map((event) => (event.payload as { state: string }).state);
    expect(states.at(-1)).toBe('finished');
    await runtime.close();
  });
});
