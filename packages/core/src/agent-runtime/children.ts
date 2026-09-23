import { createChildBlockingRelay } from './child-blocking';
import type { AgentChildManager } from './children-contract';
import { interruptChild, sendMessage, stopChildren } from './children-control';
import { spawnChild } from './children-spawn';
import {
  activeChild,
  bounded,
  createChildManagerState,
  listChildren,
  type SqliteAgentChildManagerConfig,
} from './children-state';
import { recordStepUsage } from './children-usage';

export type {
  AgentChildBlockingDecision,
  AgentChildBlockingEvent,
  AgentChildBlockingKind,
  AgentChildBlockingSource,
  AgentChildBudget,
  AgentChildHandle,
  AgentChildManager,
  AgentChildRecord,
  AgentChildState,
} from './children-contract';
export {
  AgentChildBlockingEventSchema,
  AgentChildBlockingKindSchema,
  AgentChildBlockingSourceSchema,
  AgentChildBudgetSchema,
  AgentChildRecordSchema,
  AgentChildStateSchema,
} from './children-contract';

/**
 * Child conversations over the SQLite store.
 *
 * Only the assembly lives here: the shared state and row access in
 * `children-state`, spawning in `children-spawn`, usage accounting in
 * `children-usage`, stop, interrupt and messages in `children-control`, and
 * the parent-owned blocking relay in `child-blocking`.
 */
export function createSqliteAgentChildManager(
  input: SqliteAgentChildManagerConfig,
): AgentChildManager {
  const state = createChildManagerState(input);
  const list = (parentConversationId: string) => listChildren(state, parentConversationId);
  const { retireChildBlocking, listChildBlocking, respondToChildBlocking } =
    createChildBlockingRelay({
      store: state.store,
      now: state.now,
      handles: state.handles,
      listChildren: list,
      activeChild: (parentConversationId, childConversationId) =>
        activeChild(state, parentConversationId, childConversationId),
      bounded,
    });

  return {
    spawnChild: (request) => spawnChild(state, retireChildBlocking, request),
    listChildren: list,
    recordStepUsage: (request) => recordStepUsage(state, request),
    stopChildren: (parentConversationId) =>
      stopChildren(state, retireChildBlocking, parentConversationId),
    sendMessage: (parentConversationId, childConversationId, message) =>
      sendMessage(state, parentConversationId, childConversationId, message),
    interruptChild: (parentConversationId, childConversationId) =>
      interruptChild(state, retireChildBlocking, parentConversationId, childConversationId),
    waitChild: async (childConversationId) => {
      await state.settlements.get(childConversationId);
    },
    listChildBlocking,
    respondToChildBlocking,
  };
}

export { agentChildBudgetStopPolicy } from './child-budget-policy';
