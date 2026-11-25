import { expect } from 'bun:test';
import { createAgentChildManager } from '../../src/agent-runtime/children';
import type { AgentCompanionHost } from '../../src/agent-runtime/companion-host';
import type { AgentRuntimeStore } from '../../src/agent-runtime/store';

/**
 * A child whose host answers a stop by finishing it with its result, and the
 * manager stopping it by `stopChildren` or by `interruptChild`.
 *
 * The stop does not wait for the settlement to be written: the settlement and
 * the stop's own record race for the row, which is what a real host does — a
 * stopped run resolves its result, and the manager learns of it while it is
 * still deciding what the stop ended as. Whichever records first, the child
 * ends exactly once: a finished child keeps `finished` and its result, and
 * each conversation holds one terminal state for it.
 */
export async function expectStopKeepsFinishedResult(
  owner: { store: AgentRuntimeStore; host: AgentCompanionHost },
  mode: 'stopChildren' | 'interruptChild',
): Promise<void> {
  const parentConversationId = `parent-${mode}-${crypto.randomUUID()}`;
  const childConversationId = `child-${mode}-${crypto.randomUUID()}`;
  const result = Promise.withResolvers<{ resultReference?: string }>();
  const manager = createAgentChildManager({
    remainingBudget: () => ({}),
    maxActiveChildren: 8,
    store: owner.store,
    host: owner.host,
    spawn: () => ({
      result: result.promise,
      stopPolicy: async () => {
        result.resolve({ resultReference: 'final-answer' });
      },
    }),
  });
  await manager.spawnChild({
    parentConversationId,
    childConversationId,
    childInput: {},
    budget: { tokens: 10 },
  });
  if (mode === 'stopChildren') await manager.stopChildren(parentConversationId);
  else await manager.interruptChild(parentConversationId, childConversationId);
  await manager.waitChild(childConversationId);

  const rows = await manager.listChildren(parentConversationId);
  expect(rows.map((row) => [row.state, row.resultReference])).toEqual([
    ['finished', 'final-answer'],
  ]);
  for (const conversationId of [parentConversationId, childConversationId]) {
    const states = (await owner.store.readEvents({ conversationId, limit: 50 })).items
      .filter((event) => event.kind === 'child/state')
      .map((event) => Reflect.get(Object(event.payload), 'state'));
    expect({ conversationId, states }).toEqual({
      conversationId,
      states: ['running', 'finished'],
    });
  }
}
