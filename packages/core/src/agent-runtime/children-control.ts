import {
  type AgentChildHandle,
  type AgentChildRecord,
  ChildStateEventPayloadSchema,
} from './children-contract';
import {
  activeChild,
  askChildHost,
  bounded,
  type ChildManagerState,
  type ChildStopOutcome,
  LIVE_CHILD_STATES,
  listChildren,
  type PendingSpawn,
  stopHandle,
  transitionChild,
} from './children-state';

function isReachable(handle: AgentChildHandle): Promise<boolean> {
  const probe = handle.reachable;
  if (!probe) return Promise.resolve(true);
  return bounded(
    Promise.resolve()
      .then(() => probe.call(handle))
      .then(
        (value) => Boolean(value),
        () => false,
      ),
    false,
  );
}

/** Ask every spawn of the parent still in flight to stop its child once it exists. */
function requestPendingStops(
  state: ChildManagerState,
  parentConversationId: string,
): PendingSpawn[] {
  const pending = [...state.spawning.values()].filter(
    (spawn) => spawn.parentConversationId === parentConversationId,
  );
  for (const spawn of pending) spawn.stopRequested = true;
  return pending;
}

/**
 * Stop every live child of a parent, recording `stopped` or `lost` for each.
 *
 * A child whose spawn is still running has no handle to stop yet, and may have
 * a row already: its spawn is asked to stop it, before the rows are read and
 * again after, and is awaited within the stop bound. Recording it `lost` here
 * would leave a child running that its spawn is about to register.
 */
export async function stopChildren(
  state: ChildManagerState,
  retireChildBlocking: (childConversationId: string) => void,
  parentConversationId: string,
): Promise<void> {
  requestPendingStops(state, parentConversationId);
  const records = (await listChildren(state, parentConversationId)).filter(
    (record) => record.state === 'spawned' || record.state === 'running',
  );
  const pending = requestPendingStops(state, parentConversationId);
  // A spawn that finished meanwhile has stopped its child and let go of its
  // handle, so the stop below finds none and moves no row; one still running
  // stops its own child.
  const registered = records.filter(
    (record) => !state.spawning.has(record.childConversationId),
  );
  await Promise.all([
    ...registered.map((record) => stopChild(state, retireChildBlocking, record)),
    ...pending.map((spawn) => bounded(spawn.done, undefined)),
  ]);
}

/** Stop one child of this process and record how the stop ended it. */
export async function stopChild(
  state: ChildManagerState,
  retireChildBlocking: (childConversationId: string) => void,
  record: AgentChildRecord,
): Promise<void> {
  const startedAt = performance.now();
  const handle = state.handles.get(record.childConversationId);
  // No handle in this process — after a restart, or a child spawned by
  // another manager — is not a child this process can stop. Recording
  // `stopped` would claim a stop that never happened; it is `lost`.
  const reachable = handle ? await isReachable(handle) : false;
  const outcome: ChildStopOutcome =
    handle && reachable
      ? await stopHandle(handle, 'parent-stopped')
      : { stopped: false, reason: 'unreachable' };
  await recordStop(state, retireChildBlocking, record, outcome, {
    stopDurationMs: Math.max(0, performance.now() - startedAt),
  });
}

/**
 * Record how a stop ended the child: `stopped` when its host confirmed the
 * stop, `lost` with the reason when it did not.
 *
 * A host often answers a stop by finishing the child, and its result can
 * arrive before the stop returns: that settlement is let finish first, so the
 * child keeps `finished` and its result. Either way the row moves once — the
 * transition only leaves a live row — and the child leaves this process's
 * maps, so nothing waits on a host that never reports.
 */
export async function recordStop(
  state: ChildManagerState,
  retireChildBlocking: (childConversationId: string) => void,
  record: AgentChildRecord,
  outcome: ChildStopOutcome,
  details: Record<string, string | number | boolean>,
): Promise<void> {
  const { childConversationId } = record;
  const settlement = state.settlements.get(childConversationId);
  // Its own failure reaches whoever waits on the child; here it only orders.
  if (settlement?.arrived) await Promise.allSettled([settlement.settled]);
  await transitionChild(state, record, outcome.stopped ? 'stopped' : 'lost', {
    from: LIVE_CHILD_STATES,
    absent: 'skip',
    details: { ...details, ...(!outcome.stopped && { reason: outcome.reason }) },
  });
  // The row has ended, by this stop or by whoever came first: a waiter is done.
  settlement?.endedByStop();
  if (state.settlements.get(childConversationId) === settlement)
    state.settlements.delete(childConversationId);
  state.handles.delete(childConversationId);
  retireChildBlocking(childConversationId);
}

/**
 * How many messages that outlived the bound each host still holds. Another
 * message to the same child is refused while any is, so a model that resends
 * after the timeout does not deliver it twice; counted per message, so one
 * landing does not lift the guard while another is still out. Weak: an ended
 * child's host is let go.
 */
const messagesWithHost = new WeakMap<AgentChildHandle, number>();

export async function sendMessage(
  state: ChildManagerState,
  parentConversationId: string,
  childConversationId: string,
  message: unknown,
): Promise<void> {
  const { handle } = await activeChild(state, parentConversationId, childConversationId);
  const send = handle.sendMessage;
  if (!send) throw new TypeError('Child host does not support messages');
  if ((messagesWithHost.get(handle) ?? 0) > 0)
    throw new TypeError(
      'The child host has not answered an earlier message to this child: an earlier message is still with the child host',
    );
  const journal = () =>
    state.store.appendEvent({
      conversationId: parentConversationId,
      kind: 'child/state',
      payload: ChildStateEventPayloadSchema.parse({
        childConversationId,
        action: 'message-sent',
      }),
    });
  await askChildHost(
    'the message',
    () => send.call(handle, message),
    (answer) => {
      messagesWithHost.set(handle, (messagesWithHost.get(handle) ?? 0) + 1);
      // A message the host takes late is journaled then; one it refuses is not.
      // A failed journal write is left unrecorded: the call already reported a timeout.
      void answer
        .then(journal, () => undefined)
        .catch(() => undefined)
        .finally(() => {
          const left = (messagesWithHost.get(handle) ?? 1) - 1;
          if (left > 0) messagesWithHost.set(handle, left);
          else messagesWithHost.delete(handle);
        });
    },
  );
  await journal();
}

export async function interruptChild(
  state: ChildManagerState,
  retireChildBlocking: (childConversationId: string) => void,
  parentConversationId: string,
  childConversationId: string,
): Promise<void> {
  const { child, handle } = await activeChild(
    state,
    parentConversationId,
    childConversationId,
  );
  const startedAt = performance.now();
  const outcome = await stopHandle(handle, 'parent-interrupt');
  await recordStop(state, retireChildBlocking, child, outcome, {
    policyName: 'parent-interrupt',
    stopDurationMs: Math.max(0, performance.now() - startedAt),
  });
}
