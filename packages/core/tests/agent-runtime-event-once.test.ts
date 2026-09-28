import { Database } from 'bun:sqlite';
import { expect, test } from 'bun:test';
import { randomBytes } from 'node:crypto';
import { createInvocationPayloads } from '../src/agent-runtime/invocation-payload';
import { readInvocationPayload } from '../src/agent-runtime/invocation-read';
import {
  createSqliteAgentRuntimeStore,
  type SqliteDatabase,
} from '../src/agent-runtime/sqlite';
import type { AppendAgentStoreEvent } from '../src/durability/events';
import {
  type AgentRuntimeStore,
  createMemoryAgentRuntimeStore,
} from '../src/entrypoints/agent-runtime';

/** A bun:sqlite boundary that counts how many rows event reads hand back. */
function countingDatabase() {
  const database = new Database(':memory:');
  const reads = { eventRows: 0 };
  const boundary: SqliteDatabase = {
    exec: (sql) => database.exec(sql),
    prepare(sql) {
      const statement = database.query(sql);
      const readsEvents = /FROM stitchkit_agent_runtime_events/.test(sql);
      return {
        get: (...parameters) => {
          const row = statement.get(...parameters);
          if (readsEvents && row) reads.eventRows += 1;
          return row;
        },
        all: (...parameters) => {
          const rows = statement.all(...parameters);
          if (readsEvents) reads.eventRows += rows.length;
          return rows;
        },
        run: (...parameters) => ({ changes: statement.run(...parameters).changes }),
      };
    },
    close: () => database.close(),
  };
  return { boundary, reads };
}

test('once-only admission reads one event, not the conversation log', async () => {
  const { boundary, reads } = countingDatabase();
  const sqlite = createSqliteAgentRuntimeStore({ database: boundary });
  const { store } = sqlite;
  const body = 'x'.repeat(10_000);
  for (let index = 0; index < 2_000; index++) {
    await store.appendEvent({
      conversationId: 'long',
      kind: 'provider/payload',
      payload: { body },
    });
  }
  reads.eventRows = 0;
  const input: AppendAgentStoreEvent = {
    conversationId: 'long',
    kind: 'invocation/started',
    payload: { n: 1 },
  };
  const first = await store.appendEventOnce?.(input, 'key-1');
  const second = await store.appendEventOnce?.(input, 'key-1');
  expect(first?.outcome).toBe('applied');
  expect(second?.outcome).toBe('duplicate');
  expect(second?.event.seq).toBe(first?.event.seq);
  expect(reads.eventRows).toBeLessThanOrEqual(3);

  reads.eventRows = 0;
  const found = await store.findEventOnce?.({
    conversationId: 'long',
    kind: 'invocation/started',
    key: 'key-1',
  });
  expect(found?.seq).toBe(first?.event.seq);
  expect(reads.eventRows).toBe(1);
  expect(
    await store.findEventOnce?.({
      conversationId: 'long',
      kind: 'invocation/started',
      key: 'other',
    }),
  ).toBeUndefined();
  await sqlite.close();
});

test('the memory store answers once-only admission by identity too', async () => {
  const store = createMemoryAgentRuntimeStore();
  const input: AppendAgentStoreEvent = {
    conversationId: 'c',
    kind: 'invocation/started',
    payload: {},
  };
  expect((await store.appendEventOnce?.(input, 'k'))?.outcome).toBe('applied');
  expect((await store.appendEventOnce?.(input, 'k'))?.outcome).toBe('duplicate');
  expect(
    (
      await store.findEventOnce?.({
        conversationId: 'c',
        kind: 'invocation/started',
        key: 'k',
      })
    )?.kind,
  ).toBe('invocation/started');
});

test('an invocation artifact written by 0.100.0, under a random event id, is still found', async () => {
  const store = createMemoryAgentRuntimeStore();
  // 0.100.0 appended payload events without a key: model that by routing the
  // keyed write through a plain append.
  const legacy: AgentRuntimeStore = {
    ...store,
    appendEventOnce: async (event) => ({
      outcome: 'applied',
      event: await store.appendEvent(event),
    }),
  };
  const payloads = createInvocationPayloads(legacy, randomBytes(32), 4_096);
  const identity = { conversationId: 'c', invocationId: 'i', operationId: 'o' };
  const { artifactId } = await payloads.write(identity, { prompt: 'kept' });
  expect(
    await store.findEventOnce?.({
      conversationId: 'c',
      kind: 'provider/payload',
      key: artifactId,
    }),
  ).toBeUndefined();
  expect(
    await readInvocationPayload(store, payloads, { conversationId: 'c', artifactId }),
  ).toEqual({ prompt: 'kept' });
});
