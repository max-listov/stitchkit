/**
 * The exact invocation the upgrading guide shows, compiled and run as a
 * consumer sees it.
 *
 * The guide used to show `{ store, conversationId }`, a shape the released
 * package has never accepted — so the one check it tells an adapter author to
 * run could not typecheck against the package documenting it. This fixture is
 * the reason that cannot happen again quietly.
 */
import {
  type AgentRuntimeStore,
  createMemoryAgentRuntimeStore,
} from 'stitchkit/agent-runtime';
import {
  type AgentStoreConformanceContext,
  runAgentStoreConformance,
} from 'stitchkit/testing';

/** Stands in for an application-owned parent table. */
const parents = new Set<string>();

function yourStore(context: AgentStoreConformanceContext): AgentRuntimeStore {
  for (const conversationId of context.conversationIds) parents.add(conversationId);
  return createMemoryAgentRuntimeStore();
}

await runAgentStoreConformance({
  createStore: (context) => yourStore(context),
  cleanup: (context) => {
    for (const conversationId of context.conversationIds) parents.delete(conversationId);
  },
});

if (parents.size !== 0) throw new Error('conformance fixture leaked a parent row');

// A factory that owns no fixture state keeps working unchanged.
await runAgentStoreConformance({ createStore: () => createMemoryAgentRuntimeStore() });

console.log('agent store conformance: ok');
