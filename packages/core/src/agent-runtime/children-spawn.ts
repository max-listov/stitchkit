import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import type { AgentStoreEventEnvelope } from '../durability/events';
import {
  type AgentChildBudget,
  AgentChildBudgetSchema,
  type AgentChildHandle,
  type AgentChildManager,
  type AgentChildRecord,
  AgentChildRecordSchema,
  ChildSpawnedEventPayloadSchema,
} from './children-contract';
import { stopChild } from './children-control';
import {
  type ChildManagerState,
  type ChildSettlement,
  LIVE_CHILD_STATES,
  listChildren,
  type PendingSpawn,
  stopHandle,
  transitionChild,
} from './children-state';
import type { AgentCompanionScope } from './companion-host';
import { SqlIntegerSchema } from './sql-rows';
import type { AgentSqlSession } from './sql-session';
import { encodeAgentConversationArchive } from './store-events';

type SpawnRequest = Parameters<AgentChildManager['spawnChild']>[0];

const RemainingBudgetSchema = z
  .object({
    usd: z.number().nonnegative().optional(),
    tokens: z.int().nonnegative().optional(),
    milliseconds: z.int().nonnegative().optional(),
  })
  .strict();

/**
 * The requested budget, clamped by what the parent still has left. A
 * dimension the model leaves out takes the parent's remainder; a granted
 * budget with no limit at all, or with a spent dimension, refuses.
 */
async function grantedBudget(
  state: ChildManagerState,
  request: SpawnRequest,
): Promise<AgentChildBudget> {
  const requestedBudget = AgentChildBudgetSchema.parse(request.budget);
  const remaining = RemainingBudgetSchema.parse(
    await state.config.remainingBudget(request.parentConversationId),
  );
  const bounded = (requested: number | undefined, available: number | undefined) => {
    if (requested === undefined) return available;
    if (available === undefined) return requested;
    return Math.min(requested, available);
  };
  const usd = bounded(requestedBudget.usd, remaining.usd);
  const tokens = bounded(requestedBudget.tokens, remaining.tokens);
  const milliseconds = bounded(requestedBudget.milliseconds, remaining.milliseconds);
  const granted = { usd, tokens, milliseconds };
  const spent = Object.entries(granted).filter(([, value]) => value === 0);
  if (spent.length > 0)
    throw new TypeError(
      `The parent has no child budget left in ${spent.map(([name]) => name).join(', ')}`,
    );
  if (usd === undefined && tokens === undefined && milliseconds === undefined)
    throw new TypeError(
      'A child budget names at least one limit; the parent remainder and the request name none',
    );
  return AgentChildBudgetSchema.parse({
    ...(usd !== undefined && { usd }),
    ...(tokens !== undefined && { tokens }),
    ...(milliseconds !== undefined && { milliseconds }),
  });
}

const ActiveRowSchema = z.object({ active: SqlIntegerSchema });

/**
 * Refuse past `maxActiveChildren`, counting the rows.
 *
 * Counted twice: once before the spawn, so a parent at its limit does not
 * start a child only to stop it, and again in the transaction that records
 * the child, which is what holds the limit — two managers, in this process
 * or another, cannot both take the last place.
 */
async function refuseOverLimit(
  state: ChildManagerState,
  session: AgentSqlSession,
  parentConversationId: string,
): Promise<void> {
  const { active } = ActiveRowSchema.parse(
    await session.get(
      `SELECT COUNT(*) AS active FROM ${state.host.tables.children}
       WHERE parent_conversation_id = ? AND state IN ('spawned', 'running')`,
      [parentConversationId],
    ),
  );
  if (active >= state.config.maxActiveChildren)
    throw new TypeError(
      `The parent already has ${active} active children, the limit is ${state.config.maxActiveChildren}`,
    );
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
  let inserted = false;
  try {
    await state.host.transaction(
      record.parentConversationId,
      async (scope: AgentCompanionScope) => {
        await refuseOverLimit(state, scope, record.parentConversationId);
        await scope.run(
          `INSERT INTO ${state.host.tables.children} (
           parent_conversation_id, child_conversation_id, seed_upto_seq, state,
           budget_payload, usage_payload, result_reference, created_at, updated_at
         ) VALUES (?, ?, ?, ?, ?, ?, NULL, ?, ?)`,
          [
            record.parentConversationId,
            record.childConversationId,
            record.seedUptoSeq,
            record.state,
            JSON.stringify(record.budget),
            JSON.stringify(record.usage),
            createdAt,
            createdAt,
          ],
        );
        await scope.appendEvent({
          conversationId: record.parentConversationId,
          kind: 'child/spawned',
          occurredAt: createdAt,
          payload: ChildSpawnedEventPayloadSchema.parse({
            childConversationId,
            seedUptoSeq: record.seedUptoSeq,
            budget: record.budget,
          }),
        });
      },
    );
    inserted = true;
    await transitionChild(state, record, 'running', { from: ['spawned'], absent: 'skip' });
  } catch (cause) {
    // The child runs and its record failed: stop it again, within the stop
    // bound, and record it `lost` when its row exists. A cleanup that fails
    // too is reported beside the cause, never instead of it.
    const failures: unknown[] = [];
    const stop = await stopHandle(handle, 'spawn-persistence-failed');
    if (!stop.stopped) failures.push(stop.cause);
    if (inserted) {
      try {
        await transitionChild(state, record, 'lost', {
          from: LIVE_CHILD_STATES,
          absent: 'skip',
          details: { reason: 'spawn-persistence-failed' },
        });
      } catch (cleanup) {
        failures.push(cleanup);
      }
    }
    if (failures.length > 0)
      throw new AggregateError(
        [cause, ...failures],
        `Child ${childConversationId} could not be recorded, and its cleanup failed too`,
        { cause },
      );
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
  // A late `result` after a stop has already recorded `stopped` or `lost`
  // does not rewrite that: the transition only leaves a live row.
  const settle = async (next: 'finished' | 'stopped', resultReference?: string) => {
    entry.arrived = true;
    state.handles.delete(childConversationId);
    retireChildBlocking(childConversationId);
    await transitionChild(state, record, next, {
      from: LIVE_CHILD_STATES,
      absent: 'record',
      ...(resultReference !== undefined && { resultReference }),
    });
  };
  const settled = handle.result
    .then(
      (result) => settle('finished', result.resultReference),
      () => settle('stopped'),
    )
    .finally(() => {
      if (state.settlements.get(childConversationId) === entry) {
        state.settlements.delete(childConversationId);
      }
    });
  const stopped = Promise.withResolvers<void>();
  const entry: ChildSettlement = {
    settled,
    ended: Promise.race([settled, stopped.promise]),
    endedByStop: () => stopped.resolve(),
    arrived: false,
  };
  state.settlements.set(childConversationId, entry);
  void settled.catch(() => undefined);
}

/**
 * Spawn a child, visible to a stop of its parent from the first line.
 *
 * The spawn is registered in `spawning` before its first `await` — the limit
 * check, the parent's remaining budget, the seed history — so a stop that
 * comes at any point of it reaches the child: before the host is asked to
 * start one, the spawn refuses and no child exists; after, the child is
 * stopped the moment its handle is held.
 */
export async function spawnChild(
  state: ChildManagerState,
  retireChildBlocking: (childConversationId: string) => void,
  request: SpawnRequest,
): Promise<AgentChildRecord> {
  const childConversationId = request.childConversationId ?? randomUUID();
  if (state.spawning.has(childConversationId))
    throw new TypeError(`Child ${childConversationId} is already being spawned`);
  const done = Promise.withResolvers<void>();
  const pending: PendingSpawn = {
    parentConversationId: request.parentConversationId,
    stopRequested: false,
    done: done.promise,
  };
  state.spawning.set(childConversationId, pending);
  try {
    await state.host.read((session) =>
      refuseOverLimit(state, session, request.parentConversationId),
    );
    return await spawnAdmitted(
      state,
      retireChildBlocking,
      request,
      childConversationId,
      pending,
    );
  } finally {
    state.spawning.delete(childConversationId);
    done.resolve();
  }
}

async function spawnAdmitted(
  state: ChildManagerState,
  retireChildBlocking: (childConversationId: string) => void,
  request: SpawnRequest,
  childConversationId: string,
  pending: PendingSpawn,
): Promise<AgentChildRecord> {
  const budget = await grantedBudget(state, request);
  const events = await readSeedEvents(state, request);
  const seedUptoSeq = events.at(-1)?.seq ?? 0;
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
  // The last moment no child exists: a parent stopped by now gets none.
  if (pending.stopRequested)
    throw new Error(
      `The parent ${record.parentConversationId} was stopped before child ${childConversationId} started; no child was spawned`,
    );
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
  const running: AgentChildRecord = {
    ...record,
    state: 'running',
    updatedAt: state.now().toISOString(),
  };
  if (!pending.stopRequested) return running;
  // The parent was stopped while the child was being spawned: it is stopped
  // now that its handle exists, and the caller learns how that ended.
  await stopChild(state, retireChildBlocking, running);
  const stopped = (await listChildren(state, record.parentConversationId)).find(
    (child) => child.childConversationId === childConversationId,
  );
  if (!stopped)
    throw new TypeError(`Child ${childConversationId} was stopped and its record is gone`);
  return stopped;
}
