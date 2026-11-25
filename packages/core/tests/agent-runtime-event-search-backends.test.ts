/**
 * One event-search suite, run on the SQLite store (FTS5) and on the Postgres
 * store (`tsvector`). The Postgres half runs in the `test:postgres-stores`
 * lane (`AGENT_STORE_DATABASE_URL`); the SQLite half runs everywhere.
 */
import { afterAll, describe, expect, test } from 'bun:test';
import { SQL } from 'bun';
import type { AgentCompanionHost } from '../src/agent-runtime/companion-host';
import { createAgentEventSearch } from '../src/agent-runtime/event-search';
import type { PostgresAgentEventSearchConfig } from '../src/agent-runtime/event-search-postgres';
import { createPostgresAgentRuntimeStore } from '../src/agent-runtime/postgres';
import { createBunSqliteAgentRuntimeStore } from '../src/agent-runtime/sqlite-bun';
import type { AgentRuntimeStore } from '../src/agent-runtime/store';

const url = Bun.env.AGENT_STORE_DATABASE_URL;
if (url && !new URL(url).pathname.startsWith('/sk_lane_')) {
  throw new Error('The Postgres event search proof refuses a non-disposable database');
}
const sql = url ? new SQL(url, { max: 8 }) : undefined;
const closers: (() => Promise<void>)[] = [];

afterAll(async () => {
  for (const close of closers) await close();
  await sql?.close();
});

interface Backend {
  store: AgentRuntimeStore;
  host: AgentCompanionHost;
  search: ReturnType<typeof createAgentEventSearch>;
  open: ReturnType<typeof createAgentEventSearch>;
}

function sqliteBackend(): Backend {
  const owner = createBunSqliteAgentRuntimeStore({ filename: ':memory:' });
  closers.push(() => owner.close());
  return {
    ...owner,
    search: createAgentEventSearch({ host: owner.host }),
    open: createAgentEventSearch({ host: owner.host, authorizeConversation: () => true }),
  };
}

function postgresStore(database: SQL) {
  return createPostgresAgentRuntimeStore<SQL>({
    transaction: (work) => database.begin((tx) => work(tx)),
    query: (tx, text, parameters) => tx.unsafe(text, [...parameters]),
    prefix: `sk_${crypto.randomUUID().replaceAll('-', '').slice(0, 12)}`,
  });
}

function postgresBackend(database: SQL, postgres?: PostgresAgentEventSearchConfig): Backend {
  const owner = postgresStore(database);
  return {
    ...owner,
    search: createAgentEventSearch({ host: owner.host, ...(postgres && { postgres }) }),
    open: createAgentEventSearch({
      host: owner.host,
      authorizeConversation: () => true,
      ...(postgres && { postgres }),
    }),
  };
}

async function say(store: AgentRuntimeStore, conversationId: string, text: string) {
  return store.appendEvent({ conversationId, kind: 'state/set', payload: { text } });
}

function suite(name: string, make: () => Backend) {
  describe(`event search on ${name}`, () => {
    test('the requester finds its own match behind eighty foreign ones', async () => {
      const backend = make();
      for (let index = 0; index < 80; index += 1) {
        await say(backend.store, 'loud', `needle needle needle ${index}`);
      }
      const own = await say(backend.store, 'quiet', 'one needle');
      const hits = await backend.open({
        requestingConversationId: 'quiet',
        query: 'needle',
        limit: 1,
      });
      expect(hits.length).toBe(1);
      const mine = await backend.search({
        requestingConversationId: 'quiet',
        query: 'needle',
      });
      expect(mine.map((hit) => [hit.conversationId, hit.seq])).toEqual([['quiet', own.seq]]);
      expect(mine[0]?.snippet).toContain('[needle]');
    }, 30_000);

    test('a multi-word query means every word, in any order', async () => {
      const backend = make();
      const both = await say(backend.store, 'c', 'the decision to deploy was made yesterday');
      await say(backend.store, 'c', 'deploy only');
      const hits = await backend.search({
        requestingConversationId: 'c',
        query: 'yesterday deploy decision',
      });
      expect(hits.map((hit) => hit.seq)).toEqual([both.seq]);
    });

    test('a query of punctuation alone, or nothing, is refused', async () => {
      const backend = make();
      await say(backend.store, 'c', 'text');
      await expect(
        backend.search({ requestingConversationId: 'c', query: '--- !!!' }),
      ).rejects.toThrow('searchable terms');
      await expect(
        backend.search({ requestingConversationId: 'c', query: '   ' }),
      ).rejects.toThrow('must not be empty');
    });

    test('a purged conversation is never found again', async () => {
      const backend = make();
      await say(backend.store, 'gone', 'secret needle');
      await say(backend.store, 'kept', 'public needle');
      expect(
        await backend.open({ requestingConversationId: 'kept', query: 'needle' }),
      ).toHaveLength(2);
      expect(
        (await backend.store.purgeConversation?.({ conversationId: 'gone' }))?.outcome,
      ).toBe('purged');
      const hits = await backend.open({ requestingConversationId: 'kept', query: 'needle' });
      expect(hits.map((hit) => hit.conversationId)).toEqual(['kept']);
    });

    test('an event over one MiB is stored and its beginning is found', async () => {
      const backend = make();
      const text = `opening ${'filler '.repeat(160_000)}`;
      expect(new TextEncoder().encode(text).byteLength).toBeGreaterThan(1_048_576);
      const big = await say(backend.store, 'big', text);
      const hits = await backend.search({ requestingConversationId: 'big', query: 'opening' });
      expect(hits.map((hit) => hit.seq)).toEqual([big.seq]);
    }, 60_000);
  });
}

suite('SQLite', sqliteBackend);

test('Postgres options are refused on the SQLite store', () => {
  const owner = createBunSqliteAgentRuntimeStore({ filename: ':memory:' });
  closers.push(() => owner.close());
  expect(() => createAgentEventSearch({ host: owner.host, postgres: {} })).toThrow(
    'Postgres store only',
  );
});

describe.skipIf(!sql)('the Postgres index', () => {
  const database = sql as SQL;
  suite('Postgres', () => postgresBackend(database));

  test('a dense document past the tsvector limit is indexed from fewer characters', async () => {
    const backend = postgresBackend(database, { maxIndexedChars: 4_000_000 });
    const words = Array.from({ length: 120_000 }, (_, index) => `w${index.toString(36)}x`);
    const event = await say(backend.store, 'dense', `first ${words.join(' ')}`);
    const hits = await backend.search({ requestingConversationId: 'dense', query: 'first' });
    expect(hits.map((hit) => hit.seq)).toEqual([event.seq]);
  }, 120_000);

  test('a search far behind indexes its budget, refuses, and the next one continues', async () => {
    const backend = postgresBackend(database, { maxSyncEvents: 5 });
    for (let index = 0; index < 12; index += 1)
      await say(backend.store, 'behind', `entry ${index}`);
    let refusals = 0;
    for (;;) {
      try {
        const hits = await backend.search({
          requestingConversationId: 'behind',
          query: 'entry',
        });
        expect(hits).toHaveLength(12);
        break;
      } catch (error) {
        expect(String(error)).toContain('events behind');
        refusals += 1;
        if (refusals > 3) throw error;
      }
    }
    expect(refusals).toBe(2);
  }, 30_000);

  test('unaccent refuses without the extension, folds with it, and the index keeps its choice', async () => {
    await database.unsafe('DROP EXTENSION IF EXISTS unaccent');
    const refused = postgresBackend(database, { diacritics: 'unaccent' });
    await say(refused.store, 'c', 'café');
    await expect(
      refused.search({ requestingConversationId: 'c', query: 'cafe' }),
    ).rejects.toThrow('unaccent extension');
    await database.unsafe('CREATE EXTENSION IF NOT EXISTS unaccent');
    const folded = postgresBackend(database, { diacritics: 'unaccent' });
    const event = await say(folded.store, 'c', 'un café noir');
    expect(
      (await folded.search({ requestingConversationId: 'c', query: 'cafe' })).map(
        (hit) => hit.seq,
      ),
    ).toEqual([event.seq]);
    const preserved = createAgentEventSearch({ host: folded.host });
    await expect(preserved({ requestingConversationId: 'c', query: 'cafe' })).rejects.toThrow(
      "built with diacritics 'unaccent'",
    );
    const exact = postgresBackend(database);
    await say(exact.store, 'c', 'un café noir');
    expect(await exact.search({ requestingConversationId: 'c', query: 'cafe' })).toEqual([]);
  }, 30_000);
});
