import { type AgentChildManager, parseChild, usageNumbers } from './children-contract';
import { bounded, type ChildManagerState } from './children-state';

/**
 * Add one step's usage to the child's total and decide whether its budget
 * now stops it.
 */
export async function recordStepUsage(
  state: ChildManagerState,
  request: Parameters<AgentChildManager['recordStepUsage']>[0],
): ReturnType<AgentChildManager['recordStepUsage']> {
  const { database, handles, now } = state;
  const raw = database
    .prepare(`
      SELECT parent_conversation_id, child_conversation_id, seed_upto_seq, state,
        budget_payload, usage_payload, result_reference, created_at, updated_at
      FROM stitchkit_agent_runtime_children WHERE child_conversation_id = ?
    `)
    .get(request.childConversationId);
  if (raw === null || raw === undefined) throw new TypeError('Unknown child conversation');
  const record = parseChild(raw);
  const measured = usageNumbers(request.usage);
  if (record.budget.tokens !== undefined && measured.tokens === undefined) {
    throw new TypeError('Cannot enforce child token budget without measured token usage');
  }
  if (record.budget.usd !== undefined && measured.usd === undefined) {
    throw new TypeError('Cannot enforce child USD budget without USD usage');
  }
  const usage = {
    tokens: record.usage.tokens + (measured.tokens ?? 0),
    usd: record.usage.usd + (measured.usd ?? 0),
    milliseconds: record.usage.milliseconds + request.elapsedMs,
  };
  const updatedAt = now().toISOString();
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
  // Whether this process could actually deliver the stop: without a handle
  // (another process, a restart) the decision is recorded and returned, and
  // the caller — the host running the child — enforces it. A host whose
  // `stopPolicy` throws or hangs must not lose the usage record.
  const handle = handles.get(request.childConversationId);
  let enforced = false;
  if (stop && handle) {
    enforced = await bounded(
      Promise.resolve()
        .then(() => handle.stopPolicy('child-budget'))
        .then(
          () => true,
          () => false,
        ),
      false,
    );
  }
  const payload = {
    childConversationId: record.childConversationId,
    state: 'running',
    usage,
    overrun,
    ...(stop && { policyName: 'child-budget', enforced }),
  };
  await state.config.sqlite.transaction(async (scope) => {
    scope.database
      .prepare(
        'UPDATE stitchkit_agent_runtime_children SET usage_payload = ?, updated_at = ? WHERE child_conversation_id = ?',
      )
      .run(JSON.stringify(usage), updatedAt, request.childConversationId);
    await scope.appendEvent({
      conversationId: record.parentConversationId,
      kind: 'child/state',
      occurredAt: updatedAt,
      payload,
    });
    await scope.appendEvent({
      conversationId: record.childConversationId,
      kind: 'child/state',
      occurredAt: updatedAt,
      payload: { parentConversationId: record.parentConversationId, ...payload },
    });
  });
  return { stop, enforced, ...(stop && { policyName: 'child-budget' }), overrun };
}
