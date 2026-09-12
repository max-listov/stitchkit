import {
  type AgentChildBlockingDecision,
  type AgentChildBlockingEvent,
  AgentChildBlockingEventSchema,
  AgentChildBlockingSourceSchema,
  type AgentChildHandle,
  type AgentChildRecord,
  ChildBlockingDecisionSchema,
} from './children-contract';
import type { AgentRuntimeStore } from './store';
export function createChildBlockingRelay(input: {
  store: AgentRuntimeStore;
  now: () => Date;
  handles: Map<string, AgentChildHandle>;
  listChildren: (id: string) => readonly AgentChildRecord[];
  activeChild: (parent: string, child: string) => { handle: AgentChildHandle };
  bounded: <V>(work: Promise<V> | V, fallback: V) => Promise<V>;
}) {
  const { store, now, handles, listChildren, activeChild, bounded } = input;
  /**
   * The parent-owned blocking relay (ADR 0179). `presentedBlocking` holds the
   * parent-scoped id -> event for every request the parent has been shown and
   * not yet answered; `retiredBlocking` remembers ids an answer already
   * retired, so a child that still reports a stale request cannot re-present
   * it. `serializeBlocking` makes the read-then-present and answer steps
   * atomic against each other in this single-threaded process.
   */
  const presentedBlocking = new Map<
    string,
    { event: AgentChildBlockingEvent; batchId: string }
  >();
  const retiredBlocking = new Set<string>();
  let blockingQueue: Promise<unknown> = Promise.resolve();
  const serializeBlocking = <VALUE>(work: () => Promise<VALUE>): Promise<VALUE> => {
    const run = blockingQueue.then(work, work);
    blockingQueue = run.then(
      () => undefined,
      () => undefined,
    );
    return run;
  };
  const childScopedBlockingId = (
    childConversationId: string,
    childApprovalId: string,
  ): string =>
    `${encodeURIComponent(childConversationId)}:${encodeURIComponent(childApprovalId)}`;
  const retireChildBlocking = (childConversationId: string): void => {
    for (const [id, entry] of presentedBlocking) {
      if (entry.event.childConversationId === childConversationId) {
        presentedBlocking.delete(id);
        retiredBlocking.add(id);
      }
    }
  };

  const listChildBlockingInner = async (
    parentConversationId: string,
  ): Promise<readonly AgentChildBlockingEvent[]> => {
    const live = listChildren(parentConversationId).filter(
      (record) => record.state === 'spawned' || record.state === 'running',
    );
    for (const record of live) {
      const handle = handles.get(record.childConversationId);
      if (!handle?.blockingEvents) continue;
      const reported = await bounded(Promise.resolve(handle.blockingEvents()), []);
      const fresh = reported
        .map((source) => AgentChildBlockingSourceSchema.parse(source))
        .filter((source) => {
          const id = childScopedBlockingId(record.childConversationId, source.approvalId);
          return !presentedBlocking.has(id) && !retiredBlocking.has(id);
        });
      if (fresh.length === 0) continue;
      const presentedAt = now().toISOString();
      for (const source of fresh) {
        const approvalId = childScopedBlockingId(
          record.childConversationId,
          source.approvalId,
        );
        const batchId = source.batchId
          ? `${record.childConversationId}:${source.batchId}`
          : approvalId;
        const event = AgentChildBlockingEventSchema.parse({
          parentConversationId,
          childConversationId: record.childConversationId,
          kind: source.kind,
          approvalId,
          childApprovalId: source.approvalId,
          callId: source.callId,
          toolName: source.toolName,
          input: source.input,
          batchId,
          presentedAt,
        });
        await store.appendEvent({
          conversationId: parentConversationId,
          kind: 'child/state',
          occurredAt: presentedAt,
          payload: {
            action: 'blocking-presented',
            childConversationId: event.childConversationId,
            approvalId: event.approvalId,
            childApprovalId: event.childApprovalId,
            kind: event.kind,
            callId: event.callId,
            toolName: event.toolName,
            input: event.input,
            batchId: event.batchId,
            presentedAt,
          },
        });
        // Polls are serialized; publish only after the durable append succeeds.
        presentedBlocking.set(approvalId, { event, batchId });
      }
    }
    return [...presentedBlocking.values()]
      .map((entry) => entry.event)
      .filter((event) => event.parentConversationId === parentConversationId);
  };

  const listChildBlocking = (
    parentConversationId: string,
  ): Promise<readonly AgentChildBlockingEvent[]> =>
    serializeBlocking(() => listChildBlockingInner(parentConversationId));

  const respondToChildBlockingInner = async (
    parentConversationId: string,
    decision: AgentChildBlockingDecision,
  ): Promise<void> => {
    const entry = presentedBlocking.get(decision.approvalId);
    if (!entry || entry.event.parentConversationId !== parentConversationId) {
      throw new TypeError('Child blocking request is missing, stale or already answered');
    }
    const { handle } = activeChild(parentConversationId, entry.event.childConversationId);
    if (!handle.respondToBlocking) {
      throw new TypeError('Child host cannot answer blocking requests');
    }
    const parsed = ChildBlockingDecisionSchema.parse(decision);
    if ((entry.event.kind === 'input') !== 'value' in parsed)
      throw new TypeError('Child response kind does not match the pending request');
    await handle.respondToBlocking({ ...parsed, approvalId: entry.event.childApprovalId });
    presentedBlocking.delete(decision.approvalId);
    retiredBlocking.add(decision.approvalId);
    await store.appendEvent({
      conversationId: parentConversationId,
      kind: 'child/state',
      payload: {
        action: 'blocking-resolved',
        childConversationId: entry.event.childConversationId,
        approvalId: entry.event.approvalId,
        batchId: entry.batchId,
        ...('approved' in parsed ? { approved: parsed.approved } : { kind: 'input' }),
      },
    });
  };

  const respondToChildBlocking = (
    parentConversationId: string,
    decision: AgentChildBlockingDecision,
  ): Promise<void> =>
    serializeBlocking(() => respondToChildBlockingInner(parentConversationId, decision));

  return { retireChildBlocking, listChildBlocking, respondToChildBlocking };
}
