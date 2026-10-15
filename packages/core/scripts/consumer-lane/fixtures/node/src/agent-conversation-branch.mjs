import assert from 'node:assert/strict';
import { createMemoryAgentRuntimeStore } from 'stitchkit/agent-runtime';
import { runAgentStoreConformance } from 'stitchkit/agent-runtime/testing';

for (const adapter of ['memory', 'sqlite']) {
  const sqlite =
    adapter === 'sqlite'
      ? process.versions.bun
        ? (
            await import('stitchkit/agent-runtime/sqlite/bun')
          ).createBunSqliteAgentRuntimeStore({ filename: ':memory:' })
        : (
            await import('stitchkit/agent-runtime/sqlite/node')
          ).createNodeSqliteAgentRuntimeStore({ filename: ':memory:' })
      : undefined;
  try {
    const store = sqlite?.store ?? createMemoryAgentRuntimeStore();
    // The optional conformance branch cannot silently disappear with old/wrong bytes.
    assert.equal(
      typeof store.branchConversation,
      'function',
      'Installed SDK has no branchConversation',
    );
    await runAgentStoreConformance({ createStore: () => store });
  } finally {
    await sqlite?.close();
  }
}

console.log('packed independent conversation branch: ok');
