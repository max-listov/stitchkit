import { randomUUID } from 'node:crypto';
import { createChildBlockingRelay } from './child-blocking';
import {
  type AgentChildBudget,
  AgentChildBudgetSchema,
  type AgentChildHandle,
  type AgentChildManager,
  type AgentChildRecord,
  AgentChildRecordSchema,
  type AgentChildState,
  AgentChildStateSchema,
  parseChild,
  usageNumbers,
} from './children-contract';
import { AgentConversationPurgedError } from './purge';
import type { AgentUsage } from './schemas';
import type { SqliteAgentRuntimeStore } from './sqlite';
import { type AgentStoreEventEnvelope, encodeAgentConversationArchive } from './store-events';

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

export function createSqliteAgentChildManager(input: {
  sqlite: SqliteAgentRuntimeStore;
  spawn(request: {
    parentConversationId: string;
    childConversationId: string;
    seedArchive: Uint8Array;
    childInput: unknown;
    budget: AgentChildBudget;
  }): AgentChildHandle | Promise<AgentChildHandle>;
  remainingBudget?(parentConversationId: string): AgentChildBudget | Promise<AgentChildBudget>;
  now?: () => Date;
}): AgentChildManager {
  const now = input.now ?? (() => new Date());
  const database = input.sqlite.database;
  const store = input.sqlite.store;
  const handles = new Map<string, AgentChildHandle>();
  const settlements = new Map<string, Promise<void>>();
  const currentState = (childConversationId: string): AgentChildState | undefined => {
    const raw = database
      .prepare(
        'SELECT state FROM stitchkit_agent_runtime_children WHERE child_conversation_id = ?',
      )
      .get(childConversationId);
    return raw === null || raw === undefined
      ? undefined
      : AgentChildStateSchema.parse((raw as { state: unknown }).state);
  };
  const isLive = (childConversationId: string): boolean => {
    const state = currentState(childConversationId);
    return state === 'spawned' || state === 'running';
  };
  /**
   * Whether a settlement may still be recorded: a live row, or no row at all —
   * the parent's purge takes the child rows with it, and the child's own
   * conversation still deserves to learn how it ended.
   */
  const settleable = (childConversationId: string): boolean => {
    const state = currentState(childConversationId);
    return state === undefined || state === 'spawned' || state === 'running';
  };
  /** How long a child's host may take to answer a stop or a reachability probe. */
  const STOP_BOUND_MS = 10_000;
  const bounded = async <VALUE>(
    work: Promise<VALUE> | VALUE,
    fallback: VALUE,
  ): Promise<VALUE> => {
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      return await Promise.race([
        Promise.resolve(work),
        new Promise<VALUE>((resolve) => {
          timer = setTimeout(() => resolve(fallback), STOP_BOUND_MS);
        }),
      ]);
    } finally {
      if (timer) clearTimeout(timer);
    }
  };

  const listChildren = (parentConversationId: string): readonly AgentChildRecord[] =>
    database
      .prepare(`
        SELECT parent_conversation_id, child_conversation_id, seed_upto_seq, state,
          budget_payload, usage_payload, result_reference, created_at, updated_at
        FROM stitchkit_agent_runtime_children
        WHERE parent_conversation_id = ? ORDER BY created_at, child_conversation_id
      `)
      .all(parentConversationId)
      .map(parseChild);

  const updateState = async (
    record: AgentChildRecord,
    state: AgentChildState,
    resultReference?: string,
    details: Record<string, string | number | boolean> = {},
  ) => {
    const updatedAt = now().toISOString();
    const payload = {
      childConversationId: record.childConversationId,
      state,
      ...(resultReference && { resultReference }),
      ...details,
    };
    const childPayload = {
      parentConversationId: record.parentConversationId,
      state,
      ...(resultReference && { resultReference }),
      ...details,
    };
    const write = (audience: 'both' | 'child' | 'row') =>
      input.sqlite.transaction(async (scope) => {
        scope.database
          .prepare(`
            UPDATE stitchkit_agent_runtime_children
            SET state = ?, result_reference = ?, updated_at = ? WHERE child_conversation_id = ?
          `)
          .run(state, resultReference ?? null, updatedAt, record.childConversationId);
        if (audience === 'both') {
          await scope.appendEvent({
            conversationId: record.parentConversationId,
            kind: 'child/state',
            occurredAt: updatedAt,
            payload,
          });
        }
        if (audience !== 'row') {
          await scope.appendEvent({
            conversationId: record.childConversationId,
            kind: 'child/state',
            occurredAt: updatedAt,
            payload: childPayload,
          });
        }
      });
    // A purged conversation takes no events. The parent may be gone by the
    // time a child settles, or the child itself; the row still records the
    // state, and whichever side still exists gets its event. A settlement
    // nobody awaits must not surface as an unhandled rejection.
    try {
      await write('both');
    } catch (error) {
      if (!(error instanceof AgentConversationPurgedError)) throw error;
      try {
        await write('child');
      } catch (inner) {
        if (!(inner instanceof AgentConversationPurgedError)) throw inner;
        await write('row');
      }
    }
  };

  const spawnChild = async (request: {
    parentConversationId: string;
    childConversationId?: string;
    seedUptoSeq?: number;
    childInput: unknown;
    budget: AgentChildBudget;
  }): Promise<AgentChildRecord> => {
    const requestedBudget = AgentChildBudgetSchema.parse(request.budget);
    const remaining = input.remainingBudget
      ? AgentChildBudgetSchema.parse(await input.remainingBudget(request.parentConversationId))
      : undefined;
    const bounded = (requested: number | undefined, available: number | undefined) => {
      if (requested === undefined) return available;
      if (available === undefined) return requested;
      return Math.min(requested, available);
    };
    const usd = bounded(requestedBudget.usd, remaining?.usd);
    const tokens = bounded(requestedBudget.tokens, remaining?.tokens);
    const milliseconds = bounded(requestedBudget.milliseconds, remaining?.milliseconds);
    const budget = AgentChildBudgetSchema.parse({
      ...(usd !== undefined && { usd }),
      ...(tokens !== undefined && { tokens }),
      ...(milliseconds !== undefined && { milliseconds }),
    });
    const events: AgentStoreEventEnvelope[] = [];
    let cursor = 1;
    for (;;) {
      const page = await store.readEvents({
        conversationId: request.parentConversationId,
        fromSeq: cursor,
        ...(request.seedUptoSeq !== undefined && { toSeq: request.seedUptoSeq }),
        limit: 1_000,
      });
      events.push(...page.items);
      if (page.nextSeq === undefined) break;
      cursor = page.nextSeq;
    }
    const seedUptoSeq = events.at(-1)?.seq ?? 0;
    const childConversationId = request.childConversationId ?? randomUUID();
    const createdAt = now().toISOString();
    const record = AgentChildRecordSchema.parse({
      parentConversationId: request.parentConversationId,
      childConversationId,
      seedUptoSeq,
      state: 'spawned',
      budget,
      usage: { tokens: 0, usd: 0, milliseconds: 0 },
      createdAt,
      updatedAt: createdAt,
    });
    const seedArchive = encodeAgentConversationArchive({
      format: 'stitchkit.agent-conversation',
      formatVersion: 1,
      conversationId: request.parentConversationId,
      events,
      projections: [],
      spills: [],
    });
    // Spawn first, record second: a spawn that throws leaves no row and no
    // `child/spawned` behind — the old order left an eternal `spawned` that
    // `waitChild` resolved through as if it had settled.
    const handle = await input.spawn({
      parentConversationId: record.parentConversationId,
      childConversationId,
      seedArchive,
      childInput: request.childInput,
      budget,
    });
    void handle.result.catch(() => undefined);
    try {
      await input.sqlite.transaction(async (scope) => {
        scope.database
          .prepare(`
          INSERT INTO stitchkit_agent_runtime_children (
            parent_conversation_id, child_conversation_id, seed_upto_seq, state,
            budget_payload, usage_payload, result_reference, created_at, updated_at
          ) VALUES (?, ?, ?, ?, ?, ?, NULL, ?, ?)
        `)
          .run(
            record.parentConversationId,
            record.childConversationId,
            record.seedUptoSeq,
            record.state,
            JSON.stringify(record.budget),
            JSON.stringify(record.usage),
            createdAt,
            createdAt,
          );
        await scope.appendEvent({
          conversationId: record.parentConversationId,
          kind: 'child/spawned',
          occurredAt: createdAt,
          payload: { childConversationId, seedUptoSeq, budget },
        });
      });
      await updateState(record, 'running');
    } catch (cause) {
      try {
        await handle.stopPolicy('spawn-persistence-failed');
      } catch (cleanup) {
        throw new AggregateError([cause, cleanup], 'Child persistence and stop both failed');
      }
      try {
        if (isLive(childConversationId))
          await updateState(record, 'lost', undefined, { reason: 'spawn-persistence-failed' });
      } catch (cleanup) {
        throw new AggregateError(
          [cause, cleanup],
          'Child stopped but persistence reconciliation failed',
        );
      }
      throw cause;
    }
    handles.set(childConversationId, handle);
    // A late `result` after the cascade has already recorded `stopped` or
    // `lost` must not rewrite that: only a live child settles.
    const settlement = handle.result.then(
      async (result) => {
        handles.delete(childConversationId);
        retireChildBlocking(childConversationId);
        if (settleable(childConversationId)) {
          await updateState(record, 'finished', result.resultReference);
        }
      },
      async () => {
        handles.delete(childConversationId);
        retireChildBlocking(childConversationId);
        if (settleable(childConversationId)) await updateState(record, 'stopped');
      },
    );
    settlements.set(childConversationId, settlement);
    void settlement.catch(() => undefined);
    return { ...record, state: 'running', updatedAt: now().toISOString() };
  };

  const recordStepUsage = async (request: {
    childConversationId: string;
    usage: AgentUsage;
    elapsedMs: number;
  }): Promise<{
    stop: boolean;
    enforced: boolean;
    policyName?: string;
    overrun: { tokens: number; usd: number; milliseconds: number };
  }> => {
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
    await input.sqlite.transaction(async (scope) => {
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
  };

  const stopChildren = async (parentConversationId: string) => {
    const records = listChildren(parentConversationId).filter(
      (record) => record.state === 'spawned' || record.state === 'running',
    );
    await Promise.all(
      records.map(async (record) => {
        const startedAt = performance.now();
        const handle = handles.get(record.childConversationId);
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
          if (isLive(record.childConversationId)) {
            await updateState(record, 'lost', undefined, {
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
        if (!isLive(record.childConversationId)) return;
        await updateState(record, 'stopped', undefined, {
          stopDurationMs: Math.max(0, performance.now() - startedAt),
        });
        retireChildBlocking(record.childConversationId);
      }),
    );
  };

  const activeChild = (parentConversationId: string, childConversationId: string) => {
    const child = listChildren(parentConversationId).find(
      (record) => record.childConversationId === childConversationId,
    );
    if (!child) throw new TypeError('Unknown child conversation for this parent');
    if (child.state !== 'running' && child.state !== 'spawned') {
      throw new TypeError('Child conversation is not active');
    }
    const handle = handles.get(childConversationId);
    if (!handle) throw new TypeError('Child host handle is unavailable');
    return { child, handle };
  };

  const { retireChildBlocking, listChildBlocking, respondToChildBlocking } =
    createChildBlockingRelay({ store, now, handles, listChildren, activeChild, bounded });

  const sendMessage = async (
    parentConversationId: string,
    childConversationId: string,
    message: unknown,
  ) => {
    const { handle } = activeChild(parentConversationId, childConversationId);
    if (!handle.sendMessage) throw new TypeError('Child host does not support messages');
    await handle.sendMessage(message);
    await store.appendEvent({
      conversationId: parentConversationId,
      kind: 'child/state',
      payload: { childConversationId, action: 'message-sent' },
    });
  };

  const interruptChild = async (parentConversationId: string, childConversationId: string) => {
    const { child, handle } = activeChild(parentConversationId, childConversationId);
    const startedAt = performance.now();
    await handle.stopPolicy('parent-interrupt');
    await updateState(child, 'stopped', undefined, {
      policyName: 'parent-interrupt',
      stopDurationMs: Math.max(0, performance.now() - startedAt),
    });
    retireChildBlocking(childConversationId);
  };

  const waitChild = async (childConversationId: string): Promise<void> => {
    await settlements.get(childConversationId);
  };

  return {
    spawnChild,
    listChildren,
    recordStepUsage,
    stopChildren,
    sendMessage,
    interruptChild,
    waitChild,
    listChildBlocking,
    respondToChildBlocking,
  };
}

export { agentChildBudgetStopPolicy } from './child-budget-policy';
