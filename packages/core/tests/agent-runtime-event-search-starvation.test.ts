import { Database } from 'bun:sqlite';
import { describe, expect, test } from 'bun:test';
import { createSqliteAgentEventSearch } from '../src/agent-runtime';
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

describe('event search under a louder neighbour', () => {
  /**
   * Candidates used to be the top `limit * 4` matches across every
   * conversation, filtered by owner afterwards. Eighty foreign hits filled the
   * window, the requester's single hit never entered it, and the answer was
   * "nothing" to a conversation that had one.
   */
  test('the requester finds its own match behind eighty foreign ones', async () => {
    const database = sqlite();
    const runtime = createSqliteAgentRuntimeStore({ database });
    for (let index = 0; index < 80; index += 1) {
      await runtime.store.appendEvent({
        conversationId: 'loud',
        kind: 'state/set',
        payload: { text: `needle needle needle ${index}` },
      });
    }
    await runtime.store.appendEvent({
      conversationId: 'quiet',
      kind: 'state/set',
      payload: { text: 'one needle' },
    });
    const search = createSqliteAgentEventSearch({ database });
    await expect(
      search({ requestingConversationId: 'quiet', query: '--- !!!' }),
    ).rejects.toThrow('searchable terms');
    expect(
      await search({ requestingConversationId: 'quiet', query: '--- needle !!!' }),
    ).toHaveLength(1);
    expect(
      await search({ requestingConversationId: 'quiet', query: 'needle', limit: 20 }),
    ).toEqual([expect.objectContaining({ conversationId: 'quiet', seq: 1 })]);
    // With an authorizer that admits everything, the requester still gets a
    // full page: foreign refusals are paged past, not counted against it.
    const open = createSqliteAgentEventSearch({ database, authorizeConversation: () => true });
    expect(
      await open({ requestingConversationId: 'quiet', query: 'needle', limit: 20 }),
    ).toHaveLength(20);
    const shut = createSqliteAgentEventSearch({
      database,
      authorizeConversation: () => false,
    });
    expect(
      await shut({ requestingConversationId: 'quiet', query: 'needle', limit: 20 }),
    ).toEqual([expect.objectContaining({ conversationId: 'quiet', seq: 1 })]);
    await runtime.close();
  });

  test('a multi-word query means every word, not one exact phrase', async () => {
    const database = sqlite();
    const runtime = createSqliteAgentRuntimeStore({ database });
    await runtime.store.appendEvent({
      conversationId: 'talk',
      kind: 'state/set',
      payload: { text: 'the deploy happened before the review' },
    });
    await runtime.store.appendEvent({
      conversationId: 'talk',
      kind: 'state/set',
      payload: { text: 'unrelated shipping note' },
    });
    const search = createSqliteAgentEventSearch({ database });
    // Both words occur in the first event, but not adjacent and not in order:
    // the phrase-only query answered `[]` here, which reads as "never said".
    expect(await search({ requestingConversationId: 'talk', query: 'deploy review' })).toEqual(
      [expect.objectContaining({ conversationId: 'talk', seq: 1 })],
    );
    // A query of only whitespace is an error, never a silent empty result.
    await expect(search({ requestingConversationId: 'talk', query: '   ' })).rejects.toThrow(
      TypeError,
    );
    await runtime.close();
  });
});
