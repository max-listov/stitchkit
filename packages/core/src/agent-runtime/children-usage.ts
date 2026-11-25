import {
  type AgentChildManager,
  type AgentChildRecord,
  ChildStateEventPayloadSchema,
  parseChild,
  usageNumbers,
} from './children-contract';
import { recordStop } from './children-control';
import {
  CHILD_COLUMNS,
  type ChildManagerState,
  stopHandle,
  writeWithPurgeFallback,
} from './children-state';

type Measured = ReturnType<typeof usageNumbers>;

/** The child's total after one more step, what it overran, and whether its budget stops it. */
function accumulate(record: AgentChildRecord, measured: Measured, elapsedMs: number) {
  const usage = {
    tokens: record.usage.tokens + (measured.tokens ?? 0),
    usd: record.usage.usd + (measured.usd ?? 0),
    milliseconds: record.usage.milliseconds + elapsedMs,
  };
  const overrun = {
    tokens: Math.max(0, usage.tokens - (record.budget.tokens ?? Number.POSITIVE_INFINITY)),
    usd: Math.max(0, usage.usd - (record.budget.usd ?? Number.POSITIVE_INFINITY)),
    milliseconds: Math.max(
      0,
      usage.milliseconds - (record.budget.milliseconds ?? Number.POSITIVE_INFINITY),
    ),
  };
  const stop =
    (record.budget.tokens !== undefined && usage.tokens >= record.budget.tokens) ||
    (record.budget.usd !== undefined && usage.usd >= record.budget.usd) ||
    (record.budget.milliseconds !== undefined &&
      usage.milliseconds >= record.budget.milliseconds);
  return { usage, overrun, stop };
}

/**
 * Add one step's usage to the child's total and decide whether its budget
 * now stops it.
 *
 * The total is read and written in one transaction: two steps reported at
 * once by two processes each add to what the other wrote, instead of the
 * second overwriting the first. The stop is asked of the child's host before
 * that transaction — a host may take seconds to answer, and a transaction
 * held open that long would hold every other write of the store — so it is
 * decided on the total read beforehand, and the transaction records whether
 * it was delivered. A stop the host confirmed ends the row as `stopped`, the
 * way an interrupt's does, so the child no longer holds a place.
 */
export async function recordStepUsage(
  state: ChildManagerState,
  retireChildBlocking: (childConversationId: string) => void,
  request: Parameters<AgentChildManager['recordStepUsage']>[0],
): ReturnType<AgentChildManager['recordStepUsage']> {
  const { host, handles, now } = state;
  const select = `SELECT ${CHILD_COLUMNS} FROM ${host.tables.children} WHERE child_conversation_id = ?`;
  const raw = await host.read((session) => session.get(select, [request.childConversationId]));
  if (raw === undefined) throw new TypeError('Unknown child conversation');
  const before = parseChild(raw);
  const measured = usageNumbers(request.usage);
  if (before.budget.tokens !== undefined && measured.tokens === undefined) {
    throw new TypeError('Cannot enforce child token budget without measured token usage');
  }
  if (before.budget.usd !== undefined && measured.usd === undefined) {
    throw new TypeError('Cannot enforce child USD budget without USD usage');
  }
  const planned = accumulate(before, measured, request.elapsedMs);
  // Whether this process could actually deliver the stop: without a handle
  // (another process, a restart) the decision is recorded and returned, and
  // the caller — the host running the child — enforces it. A host whose
  // `stopPolicy` throws or hangs must not lose the usage record.
  const handle = handles.get(request.childConversationId);
  let enforced = false;
  let attemptedStop = false;
  let stopDurationMs = 0;
  const deliverStop = async (target: NonNullable<typeof handle>) => {
    attemptedStop = true;
    const startedAt = performance.now();
    const delivered = (await stopHandle(target, 'child-budget')).stopped;
    stopDurationMs = Math.max(0, performance.now() - startedAt);
    return delivered;
  };
  if (planned.stop && handle) enforced = await deliverStop(handle);
  const updatedAt = now().toISOString();
  const result = await host.transaction(before.parentConversationId, async (scope) => {
    const current = await scope.get(select, [request.childConversationId]);
    if (current === undefined) throw new TypeError('Unknown child conversation');
    const row = parseChild(current);
    const { usage, overrun, stop } = accumulate(row, measured, request.elapsedMs);
    const delivered = stop && enforced;
    await scope.run(
      `UPDATE ${host.tables.children} SET usage_payload = ?, updated_at = ? WHERE child_conversation_id = ?`,
      [JSON.stringify(usage), updatedAt, request.childConversationId],
    );
    // The last step of a child may be reported after it ended: it is counted,
    // and the event names the state the row is in, never a live one it left.
    const payload = ChildStateEventPayloadSchema.parse({
      childConversationId: before.childConversationId,
      state: row.state,
      usage,
      overrun,
      ...(stop && { policyName: 'child-budget', enforced: delivered }),
    });
    const childPayload = ChildStateEventPayloadSchema.parse({
      parentConversationId: before.parentConversationId,
      ...payload,
    });
    await scope.appendEvent({
      conversationId: before.parentConversationId,
      kind: 'child/state',
      occurredAt: updatedAt,
      payload,
    });
    await scope.appendEvent({
      conversationId: before.childConversationId,
      kind: 'child/state',
      occurredAt: updatedAt,
      payload: childPayload,
    });
    return { stop, enforced: delivered, usage, overrun, state: row.state };
  });
  let finalEnforced = result.enforced;
  // A concurrent step may push the total over the budget inside the transaction
  // even though the pre-transaction read was still under it; deliver the stop
  // at most once and reconcile `enforced: true` into both journals if it lands.
  const postHandle = handles.get(request.childConversationId);
  if (result.stop && !attemptedStop && postHandle) {
    finalEnforced = await deliverStop(postHandle);
    if (finalEnforced) {
      await recordBudgetEnforced(state, before, result);
    }
  }
  if (finalEnforced) {
    await recordStop(
      state,
      retireChildBlocking,
      before,
      { stopped: true },
      { policyName: 'child-budget', stopDurationMs },
    );
  }
  return {
    stop: result.stop,
    enforced: finalEnforced,
    ...(result.stop && { policyName: 'child-budget' }),
    overrun: result.overrun,
  };
}

async function recordBudgetEnforced(
  state: ChildManagerState,
  record: AgentChildRecord,
  recorded: {
    usage: AgentChildRecord['usage'];
    overrun: AgentChildRecord['usage'];
    state: AgentChildRecord['state'];
  },
): Promise<void> {
  const occurredAt = state.now().toISOString();
  const payload = ChildStateEventPayloadSchema.parse({
    childConversationId: record.childConversationId,
    state: recorded.state,
    usage: recorded.usage,
    overrun: recorded.overrun,
    policyName: 'child-budget',
    enforced: true,
  });
  const childPayload = ChildStateEventPayloadSchema.parse({
    parentConversationId: record.parentConversationId,
    ...payload,
  });
  await writeWithPurgeFallback((audience) =>
    state.host.transaction(
      audience === 'child' ? record.childConversationId : record.parentConversationId,
      async (scope) => {
        if (audience === 'both' || audience === 'parent') {
          await scope.appendEvent({
            conversationId: record.parentConversationId,
            kind: 'child/state',
            occurredAt,
            payload,
          });
        }
        if (audience === 'both' || audience === 'child') {
          await scope.appendEvent({
            conversationId: record.childConversationId,
            kind: 'child/state',
            occurredAt,
            payload: childPayload,
          });
        }
        return true;
      },
    ),
  );
}
