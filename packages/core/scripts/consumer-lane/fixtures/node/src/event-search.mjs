/** Packed FTS search returns the exact seq and never a neighbour's conversation. */
import { createSqliteAgentEventSearch } from 'stitchkit/agent-runtime';
import { packedSqlite, proof } from './packed-sqlite.mjs';

const { database, handle } = packedSqlite();
try {
  await handle.store.appendEvent({
    conversationId: 'a',
    kind: 'state/set',
    payload: { text: 'needle own' },
  });
  await handle.store.appendEvent({
    conversationId: 'a',
    kind: 'state/set',
    payload: { text: 'hay' },
  });
  await handle.store.appendEvent({
    conversationId: 'b',
    kind: 'state/set',
    payload: { text: 'needle private' },
  });
  // A louder neighbour: eighty matches that must not push a's single hit out.
  for (let index = 0; index < 80; index += 1) {
    await handle.store.appendEvent({
      conversationId: 'b',
      kind: 'state/set',
      payload: { text: `needle needle ${index}` },
    });
  }
  const search = createSqliteAgentEventSearch({ database });
  const hits = await search({ requestingConversationId: 'a', query: 'needle', limit: 20 });
  proof(
    'event search',
    hits.length === 1 && hits[0].conversationId === 'a' && hits[0].seq === 1,
    JSON.stringify(hits),
  );
} finally {
  await handle.close();
}
