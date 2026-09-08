/** A child gets only the parent's history up to the seed, and its budget stops it. */
import { createSqliteAgentChildManager } from 'stitchkit/agent-runtime';
import { packedSqlite, proof } from './packed-sqlite.mjs';

const { handle } = packedSqlite();
try {
  await handle.store.appendEvent({
    conversationId: 'parent',
    kind: 'state/set',
    payload: { fact: 1 },
  });
  await handle.store.appendEvent({
    conversationId: 'parent',
    kind: 'state/set',
    payload: { fact: 2 },
  });
  let seedText = '';
  let policy;
  const children = createSqliteAgentChildManager({
    sqlite: handle,
    spawn: ({ seedArchive }) => {
      seedText = new TextDecoder().decode(seedArchive);
      return {
        result: new Promise(() => undefined),
        stopPolicy: (name) => {
          policy = name;
        },
      };
    },
  });
  const child = await children.spawnChild({
    parentConversationId: 'parent',
    childConversationId: 'child',
    seedUptoSeq: 1,
    childInput: { task: 'answer' },
    budget: { usd: 0.01 },
  });
  const boundary = await children.recordStepUsage({
    childConversationId: child.childConversationId,
    usage: {
      inputTokens: { value: 1, provenance: 'provider-reported' },
      outputTokens: { value: 1, provenance: 'provider-reported' },
      cost: { value: 0.012, currency: 'USD', provenance: 'provider-reported' },
    },
    elapsedMs: 1,
  });
  proof(
    'children',
    seedText.includes('"seq":1') &&
      !seedText.includes('"seq":2') &&
      boundary.stop === true &&
      policy === 'child-budget' &&
      Math.abs(boundary.overrun.usd - 0.002) < 1e-9,
    `seed has seq2: ${seedText.includes('"seq":2')}, boundary ${JSON.stringify(boundary)}, policy ${policy}`,
  );
} finally {
  await handle.close();
}
