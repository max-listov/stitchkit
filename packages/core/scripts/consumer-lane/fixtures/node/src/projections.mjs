/** A projection read from the packed store is honest about how far it got. */
import {
  agentConversationCardProjection,
  createSqliteAgentProjectionStore,
} from 'stitchkit/agent-runtime';
import { packedSqlite, proof } from './packed-sqlite.mjs';

const { handle } = packedSqlite();
try {
  await handle.store.appendEvent({
    conversationId: 'p',
    kind: 'state/set',
    payload: { first: true },
  });
  const projections = createSqliteAgentProjectionStore({ sqlite: handle });
  const first = await projections.advance('p', agentConversationCardProjection);
  await handle.store.appendEvent({
    conversationId: 'p',
    kind: 'state/set',
    payload: { second: true },
  });
  const second = await projections.advance('p', agentConversationCardProjection);
  proof(
    'projections',
    first.uptoSeq === 1 && second.uptoSeq === 2 && second.value.eventCount === 2,
    `uptoSeq ${first.uptoSeq}→${second.uptoSeq}, eventCount ${second.value.eventCount}`,
  );
} finally {
  await handle.close();
}
