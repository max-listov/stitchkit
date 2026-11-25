import {
  type AgentChildBlockingDecision,
  type AgentChildBlockingEvent,
  AgentChildBlockingEventSchema,
  type AgentChildBlockingSource,
  AgentChildBlockingSourceSchema,
  type AgentChildHandle,
  type AgentChildManager,
  type AgentChildRecord,
  ChildBlockingDecisionSchema,
  ChildStateEventPayloadSchema,
} from './children-contract';
import { askChildHost } from './children-state';
import type { AgentRuntimeStore } from './store';

type AgentChildBlockingList = Awaited<ReturnType<AgentChildManager['listChildBlocking']>>;

/** One live child's answer to `blockingEvents`, or why there was none. */
type ChildBlockingReport =
  | { answered: true; sources: readonly AgentChildBlockingSource[] }
  | { answered: false; reason: 'timeout' }
  | { answered: false; reason: 'failed'; cause: unknown };

type Bounded = <VALUE>(work: Promise<VALUE> | VALUE, fallback: VALUE) => Promise<VALUE>;

/**
 * What one live child reports, asked within the stop bound. A child that
 * does not answer in time, or whose answer fails or is malformed, is named
 * as unavailable — never read as a child with nothing pending.
 */
function askChild(
  bounded: Bounded,
  handle: AgentChildHandle,
  blockingEvents: NonNullable<AgentChildHandle['blockingEvents']>,
): Promise<ChildBlockingReport> {
  return bounded<ChildBlockingReport>(
    Promise.resolve()
      .then(() => blockingEvents.call(handle))
      .then(
        (reported): ChildBlockingReport => ({
          answered: true,
          sources: reported.map((source) => AgentChildBlockingSourceSchema.parse(source)),
        }),
      )
      .catch(
        (cause: unknown): ChildBlockingReport => ({
          answered: false,
          reason: 'failed',
          cause,
        }),
      ),
    { answered: false, reason: 'timeout' },
  );
}

function childScopedBlockingId(childConversationId: string, childApprovalId: string): string {
  return `${encodeURIComponent(childConversationId)}:${encodeURIComponent(childApprovalId)}`;
}

/**
 * One queue per parent: each queued step runs after the previous one of the same
 * parent settles. An entry leaves the map once its parent's queue drains.
 */
function createParentQueues() {
  const queues = new Map<string, Promise<void>>();
  return <VALUE>(parentConversationId: string, work: () => Promise<VALUE>): Promise<VALUE> => {
    const run = (queues.get(parentConversationId) ?? Promise.resolve()).then(work);
    const tail = run.then(
      () => undefined,
      () => undefined,
    );
    queues.set(parentConversationId, tail);
    void tail.then(() => {
      if (queues.get(parentConversationId) === tail) queues.delete(parentConversationId);
    });
    return run;
  };
}

/** Journal one request a child reported as presented to its parent; its relay entry. */
async function presentBlocking(
  store: AgentRuntimeStore,
  parentConversationId: string,
  record: AgentChildRecord,
  source: AgentChildBlockingSource,
  presentedAt: string,
): Promise<{ event: AgentChildBlockingEvent; batchId: string }> {
  const approvalId = childScopedBlockingId(record.childConversationId, source.approvalId);
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
    payload: ChildStateEventPayloadSchema.parse({
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
    }),
  });
  return { event, batchId };
}

export function createChildBlockingRelay(input: {
  store: AgentRuntimeStore;
  now: () => Date;
  handles: Map<string, AgentChildHandle>;
  listChildren: (id: string) => Promise<readonly AgentChildRecord[]>;
  activeChild: (parent: string, child: string) => Promise<{ handle: AgentChildHandle }>;
  bounded: Bounded;
}) {
  const { store, now, handles, listChildren, activeChild, bounded } = input;
  /**
   * The parent-owned blocking relay (ADR 0179). `presentedBlocking` holds the
   * parent-scoped id -> event for every request the parent has been shown and
   * not yet answered; `retiredBlocking` remembers, per child, the ids an answer
   * already retired, so a child that still reports a stale request cannot
   * re-present it. Both forget a child when it ends: an ended child is never
   * asked again, so what it reported has nothing left to guard.
   * `serializeBlocking` makes one parent's read-then-present and answer steps
   * atomic against each other in this single-threaded process. Every entry
   * belongs to one parent, so each parent has its own queue: a child host that
   * is slow to answer holds its own parent's requests, never another's, and
   * only within the host bound.
   */
  const presentedBlocking = new Map<
    string,
    { event: AgentChildBlockingEvent; batchId: string }
  >();
  const retiredBlocking = new Map<string, Set<string>>();
  /**
   * Requests whose answer outlived the host bound and has not settled yet, with
   * their child: forgotten when the answer settles or the child ends.
   */
  const answersWithHost = new Map<string, string>();
  const serializeBlocking = createParentQueues();
  const retireChildBlocking = (childConversationId: string): void => {
    for (const [id, entry] of presentedBlocking) {
      if (entry.event.childConversationId === childConversationId)
        presentedBlocking.delete(id);
    }
    retiredBlocking.delete(childConversationId);
    for (const [id, child] of answersWithHost) {
      if (child === childConversationId) answersWithHost.delete(id);
    }
  };
  const isRetired = (childConversationId: string, id: string): boolean =>
    retiredBlocking.get(childConversationId)?.has(id) ?? false;

  const listChildBlockingInner = async (
    parentConversationId: string,
  ): Promise<AgentChildBlockingList> => {
    const live = (await listChildren(parentConversationId)).filter(
      (record) => record.state === 'spawned' || record.state === 'running',
    );
    const unavailable: AgentChildBlockingList['unavailable'][number][] = [];
    for (const record of live) {
      const handle = handles.get(record.childConversationId);
      if (!handle?.blockingEvents) continue;
      const report = await askChild(bounded, handle, handle.blockingEvents);
      if (!report.answered) {
        const { childConversationId } = record;
        unavailable.push(
          report.reason === 'timeout'
            ? { childConversationId, reason: 'timeout' }
            : { childConversationId, reason: 'failed', cause: report.cause },
        );
        continue;
      }
      const fresh = report.sources.filter((source) => {
        const id = childScopedBlockingId(record.childConversationId, source.approvalId);
        return !presentedBlocking.has(id) && !isRetired(record.childConversationId, id);
      });
      if (fresh.length === 0) continue;
      const presentedAt = now().toISOString();
      for (const source of fresh) {
        const entry = await presentBlocking(
          store,
          parentConversationId,
          record,
          source,
          presentedAt,
        );
        // Polls are serialized; publish only after the durable append succeeds.
        presentedBlocking.set(entry.event.approvalId, entry);
      }
    }
    const pending = [...presentedBlocking.values()]
      .map((entry) => entry.event)
      .filter((event) => event.parentConversationId === parentConversationId);
    return { pending, unavailable };
  };

  const listChildBlocking = (parentConversationId: string): Promise<AgentChildBlockingList> =>
    serializeBlocking(parentConversationId, () =>
      listChildBlockingInner(parentConversationId),
    );

  const respondToChildBlockingInner = async (
    parentConversationId: string,
    decision: AgentChildBlockingDecision,
  ): Promise<void> => {
    const entry = presentedBlocking.get(decision.approvalId);
    if (!entry || entry.event.parentConversationId !== parentConversationId) {
      throw new TypeError('Child blocking request is missing, stale or already answered');
    }
    const { handle } = await activeChild(
      parentConversationId,
      entry.event.childConversationId,
    );
    const respond = handle.respondToBlocking;
    if (!respond) {
      throw new TypeError('Child host cannot answer blocking requests');
    }
    const parsed = ChildBlockingDecisionSchema.parse(decision);
    if ((entry.event.kind === 'input') !== 'value' in parsed)
      throw new TypeError('Child response kind does not match the pending request');
    if (answersWithHost.has(decision.approvalId))
      throw new TypeError(
        'The child host has not answered the first response to this request: an earlier answer is still with the child host',
      );
    // Unanswered within the bound, the request stays presented, and the host may
    // still take that answer: until it settles a second answer is refused, and
    // an answer it takes late retires the request then.
    await askChildHost(
      'the blocking response',
      () => respond.call(handle, { ...parsed, approvalId: entry.event.childApprovalId }),
      (answer) => {
        answersWithHost.set(decision.approvalId, entry.event.childConversationId);
        void answer
          .then(
            () =>
              serializeBlocking(parentConversationId, async () => {
                if (presentedBlocking.get(decision.approvalId) === entry)
                  await recordAnswered(
                    parentConversationId,
                    decision.approvalId,
                    entry,
                    parsed,
                  );
              }),
            () => undefined,
          )
          // A failed record leaves the request presented, the state that was reported.
          .catch(() => undefined)
          .finally(() => answersWithHost.delete(decision.approvalId));
      },
    );
    await recordAnswered(parentConversationId, decision.approvalId, entry, parsed);
  };

  /** Retire an answered request and journal it. */
  const recordAnswered = async (
    parentConversationId: string,
    approvalId: string,
    entry: { event: AgentChildBlockingEvent; batchId: string },
    parsed: ReturnType<typeof ChildBlockingDecisionSchema.parse>,
  ): Promise<void> => {
    presentedBlocking.delete(approvalId);
    const childConversationId = entry.event.childConversationId;
    const retired = retiredBlocking.get(childConversationId) ?? new Set<string>();
    retired.add(approvalId);
    retiredBlocking.set(childConversationId, retired);
    await store.appendEvent({
      conversationId: parentConversationId,
      kind: 'child/state',
      payload: ChildStateEventPayloadSchema.parse({
        action: 'blocking-resolved',
        childConversationId: entry.event.childConversationId,
        approvalId: entry.event.approvalId,
        batchId: entry.batchId,
        ...('approved' in parsed ? { approved: parsed.approved } : { kind: 'input' }),
      }),
    });
  };

  const respondToChildBlocking = (
    parentConversationId: string,
    decision: AgentChildBlockingDecision,
  ): Promise<void> =>
    serializeBlocking(parentConversationId, () =>
      respondToChildBlockingInner(parentConversationId, decision),
    );

  return {
    retireChildBlocking,
    listChildBlocking,
    respondToChildBlocking,
    /** What the relay still holds, by child: read by the tests that bound it. */
    retained: { presented: presentedBlocking, retired: retiredBlocking },
  };
}
