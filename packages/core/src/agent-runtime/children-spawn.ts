import { randomUUID } from 'node:crypto';
import type { AgentStoreEventEnvelope } from '../durability/events';
import {
  type AgentChildBudget,
  AgentChildBudgetSchema,
  type AgentChildHandle,
  type AgentChildManager,
  type AgentChildRecord,
  AgentChildRecordSchema,
} from './children-contract';
import { type ChildManagerState, isLive, settleable, updateState } from './children-state';
import { encodeAgentConversationArchive } from './store-events';

type SpawnRequest = Parameters<AgentChildManager['spawnChild']>[0];

/** The requested budget, clamped by what the parent still has left. */
async function grantedBudget(
  state: ChildManagerState,
  request: SpawnRequest,
): Promise<AgentChildBudget> {
  const requestedBudget = AgentChildBudgetSchema.parse(request.budget);
  const remaining = state.config.remainingBudget
    ? AgentChildBudgetSchema.parse(
        await state.config.remainingBudget(request.parentConversationId),
      )
    : undefined;
  const bounded = (requested: number | undefined, available: number | undefined) => {
    if (requested === undefined) return available;
    if (available === undefined) return requested;
    return Math.min(requested, available);
  };
  const usd = bounded(requestedBudget.usd, remaining?.usd);
  const tokens = bounded(requestedBudget.tokens, remaining?.tokens);
  const milliseconds = bounded(requestedBudget.milliseconds, remaining?.milliseconds);
  return AgentChildBudgetSchema.parse({
    ...(usd !== undefined && { usd }),
    ...(tokens !== undefined && { tokens }),
    ...(milliseconds !== undefined && { milliseconds }),
  });
}

/** The parent's event log up to the seed point, which the child starts from. */
async function readSeedEvents(
  state: ChildManagerState,
  request: SpawnRequest,
): Promise<AgentStoreEventEnvelope[]> {
  const events: AgentStoreEventEnvelope[] = [];
  let cursor = 1;
  for (;;) {
    const page = await state.store.readEvents({
      conversationId: request.parentConversationId,
      fromSeq: cursor,
      ...(request.seedUptoSeq !== undefined && { toSeq: request.seedUptoSeq }),
      limit: 1_000,
    });
    events.push(...page.items);
    if (page.nextSeq === undefined) break;
    cursor = page.nextSeq;
  }
  return events;
}

/** Record the spawned child, or stop it again when the record cannot be written. */
async function persistSpawn(
  state: ChildManagerState,
  record: AgentChildRecord,
  handle: AgentChildHandle,
): Promise<void> {
  const { childConversationId, createdAt } = record;
  try {
    await state.config.sqlite.transaction(async (scope) => {
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
        payload: {
          childConversationId,
          seedUptoSeq: record.seedUptoSeq,
          budget: record.budget,
        },
      });
    });
    await updateState(state, record, 'running');
  } catch (cause) {
    try {
      await handle.stopPolicy('spawn-persistence-failed');
    } catch (cleanup) {
      throw new AggregateError([cause, cleanup], 'Child persistence and stop both failed');
    }
    try {
      if (isLive(state, childConversationId))
        await updateState(state, record, 'lost', undefined, {
          reason: 'spawn-persistence-failed',
        });
    } catch (cleanup) {
      throw new AggregateError(
        [cause, cleanup],
        'Child stopped but persistence reconciliation failed',
      );
    }
    throw cause;
  }
}

/** Record how the child ended once its host reports it. */
function watchSettlement(
  state: ChildManagerState,
  record: AgentChildRecord,
  handle: AgentChildHandle,
  retireChildBlocking: (childConversationId: string) => void,
): void {
  const { childConversationId } = record;
  state.handles.set(childConversationId, handle);
  // A late `result` after the cascade has already recorded `stopped` or
  // `lost` must not rewrite that: only a live child settles.
  const settlement = handle.result.then(
    async (result) => {
      state.handles.delete(childConversationId);
      retireChildBlocking(childConversationId);
      if (settleable(state, childConversationId)) {
        await updateState(state, record, 'finished', result.resultReference);
      }
    },
    async () => {
      state.handles.delete(childConversationId);
      retireChildBlocking(childConversationId);
      if (settleable(state, childConversationId)) await updateState(state, record, 'stopped');
    },
  );
  state.settlements.set(childConversationId, settlement);
  void settlement.catch(() => undefined);
}

export async function spawnChild(
  state: ChildManagerState,
  retireChildBlocking: (childConversationId: string) => void,
  request: SpawnRequest,
): Promise<AgentChildRecord> {
  const budget = await grantedBudget(state, request);
  const events = await readSeedEvents(state, request);
  const seedUptoSeq = events.at(-1)?.seq ?? 0;
  const childConversationId = request.childConversationId ?? randomUUID();
  const createdAt = state.now().toISOString();
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
  const handle = await state.config.spawn({
    parentConversationId: record.parentConversationId,
    childConversationId,
    seedArchive,
    childInput: request.childInput,
    budget,
  });
  void handle.result.catch(() => undefined);
  await persistSpawn(state, record, handle);
  watchSettlement(state, record, handle, retireChildBlocking);
  return { ...record, state: 'running', updatedAt: state.now().toISOString() };
}
