import type { AgentChildRecord } from './children-contract';
import {
  activeChild,
  bounded,
  type ChildManagerState,
  isLive,
  listChildren,
  updateState,
} from './children-state';

/** Stop every live child of a parent, recording `stopped` or `lost` for each. */
export async function stopChildren(
  state: ChildManagerState,
  retireChildBlocking: (childConversationId: string) => void,
  parentConversationId: string,
): Promise<void> {
  const records = listChildren(state, parentConversationId).filter(
    (record) => record.state === 'spawned' || record.state === 'running',
  );
  await Promise.all(records.map((record) => stopChild(state, retireChildBlocking, record)));
}

async function stopChild(
  state: ChildManagerState,
  retireChildBlocking: (childConversationId: string) => void,
  record: AgentChildRecord,
): Promise<void> {
  const startedAt = performance.now();
  const handle = state.handles.get(record.childConversationId);
  // No handle in this process — after a restart, or a child spawned by
  // another manager — is not a child this process can stop. Recording
  // `stopped` would claim a stop that never happened; it is `lost`.
  const reachable = handle
    ? handle.reachable
      ? await bounded(handle.reachable(), false)
      : true
    : false;
  // Re-checked after every wait: a child that finished while its host
  // was being asked keeps `finished` and its result — the cascade does
  // not write over a settlement that beat it.
  if (!reachable) {
    if (isLive(state, record.childConversationId)) {
      await updateState(state, record, 'lost', undefined, {
        stopDurationMs: Math.max(0, performance.now() - startedAt),
      });
    }
    retireChildBlocking(record.childConversationId);
    return;
  }
  await bounded(
    Promise.resolve(handle?.stopPolicy('parent-stopped')).then(() => true),
    false,
  );
  if (!isLive(state, record.childConversationId)) return;
  await updateState(state, record, 'stopped', undefined, {
    stopDurationMs: Math.max(0, performance.now() - startedAt),
  });
  retireChildBlocking(record.childConversationId);
}

export async function sendMessage(
  state: ChildManagerState,
  parentConversationId: string,
  childConversationId: string,
  message: unknown,
): Promise<void> {
  const { handle } = activeChild(state, parentConversationId, childConversationId);
  if (!handle.sendMessage) throw new TypeError('Child host does not support messages');
  await handle.sendMessage(message);
  await state.store.appendEvent({
    conversationId: parentConversationId,
    kind: 'child/state',
    payload: { childConversationId, action: 'message-sent' },
  });
}

export async function interruptChild(
  state: ChildManagerState,
  retireChildBlocking: (childConversationId: string) => void,
  parentConversationId: string,
  childConversationId: string,
): Promise<void> {
  const { child, handle } = activeChild(state, parentConversationId, childConversationId);
  const startedAt = performance.now();
  await handle.stopPolicy('parent-interrupt');
  await updateState(state, child, 'stopped', undefined, {
    policyName: 'parent-interrupt',
    stopDurationMs: Math.max(0, performance.now() - startedAt),
  });
  retireChildBlocking(childConversationId);
}
