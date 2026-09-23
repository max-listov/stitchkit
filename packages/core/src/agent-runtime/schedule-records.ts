/**
 * What firing and setting a schedule write: the new row, the durable failure
 * of a dispatch, and the settlement of a claimed occurrence. Each runs in one
 * store transaction with the conversation event that records it.
 */
import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import {
  type AgentSchedule,
  AgentScheduleSchema,
  ClaimRowSchema,
  FinalizeRowSchema,
} from './schedules';
import type { SqliteAgentRuntimeStore } from './sqlite';

export interface ScheduleRequest {
  conversationId: string;
  input: z.infer<typeof z.json>;
  at?: string;
  afterMs?: number;
  everyMs?: number;
  timeZone?: string;
}

/** One claimed occurrence of a schedule, as the process that claimed it sees it. */
export interface ClaimedFiring {
  readonly schedule: AgentSchedule;
  readonly occurrence: number;
  readonly at: string;
  readonly owner: string;
}

/** Validate a request and build the schedule it describes; nothing is written. */
export function newSchedule(request: ScheduleRequest, observedAt: Date): AgentSchedule {
  const modes = [
    request.at !== undefined,
    request.afterMs !== undefined,
    request.everyMs !== undefined,
  ];
  if (modes.filter(Boolean).length !== 1)
    throw new TypeError('Declare exactly one schedule mode');
  if (request.everyMs !== undefined && !request.timeZone) {
    throw new TypeError('Repeating schedules require an explicit timeZone');
  }
  if (request.timeZone) {
    try {
      new Intl.DateTimeFormat('en', { timeZone: request.timeZone }).format(new Date(0));
    } catch {
      throw new TypeError(`Unknown schedule timeZone: ${request.timeZone}`);
    }
  }
  const kind =
    request.at !== undefined ? 'at' : request.afterMs !== undefined ? 'after' : 'every';
  const intervalMs = request.everyMs;
  const delay = request.afterMs ?? request.everyMs;
  if (delay !== undefined && (!Number.isSafeInteger(delay) || delay < 1)) {
    throw new TypeError('Schedule delay must be a positive safe integer');
  }
  const nextAt = request.at
    ? new Date(z.iso.datetime({ offset: true }).parse(request.at)).toISOString()
    : new Date(observedAt.getTime() + (delay ?? 0)).toISOString();
  const schedule = AgentScheduleSchema.parse({
    id: randomUUID(),
    conversationId: request.conversationId,
    kind,
    nextAt,
    ...(intervalMs !== undefined && { intervalMs }),
    ...(request.timeZone && { timeZone: request.timeZone }),
    input: z.json().parse(request.input),
    state: 'scheduled',
    occurrence: 0,
    createdAt: observedAt.toISOString(),
    updatedAt: observedAt.toISOString(),
  });
  return schedule;
}

export async function insertSchedule(
  sqlite: SqliteAgentRuntimeStore,
  schedule: AgentSchedule,
): Promise<void> {
  await sqlite.transaction(async (scope) => {
    scope.database
      .prepare(`
        INSERT INTO stitchkit_agent_runtime_schedules (
          id, conversation_id, kind, next_at, interval_ms, time_zone,
          input_payload, state, occurrence, created_at, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, 'scheduled', 0, ?, ?)
      `)
      .run(
        schedule.id,
        schedule.conversationId,
        schedule.kind,
        schedule.nextAt,
        schedule.intervalMs ?? null,
        schedule.timeZone ?? null,
        JSON.stringify(schedule.input),
        schedule.createdAt,
        schedule.updatedAt,
      );
    await scope.appendEvent({
      conversationId: schedule.conversationId,
      kind: 'schedule/set',
      occurredAt: schedule.createdAt,
      payload: { id: schedule.id, kind: schedule.kind, nextAt: schedule.nextAt },
    });
  });
}

/**
 * The row stays due and unclaimed; the failure is a durable fact of the
 * conversation, not a silent skip and not a dead timer.
 */
export async function recordDispatchFailure(
  sqlite: SqliteAgentRuntimeStore,
  { schedule, occurrence, at, owner }: ClaimedFiring,
  error: unknown,
): Promise<void> {
  await sqlite.transaction(async (scope) => {
    scope.database
      .prepare(`
        UPDATE stitchkit_agent_runtime_schedules
        SET claim_owner = NULL, claim_until = NULL, updated_at = ?
        WHERE id = ? AND claim_owner = ?
      `)
      .run(at, schedule.id, owner);
    await scope.appendEvent({
      conversationId: schedule.conversationId,
      kind: 'schedule/failed',
      occurredAt: at,
      payload: {
        id: schedule.id,
        occurrence,
        message: error instanceof Error ? error.message : String(error),
      },
    });
  });
}

/** Advance a dispatched occurrence and record it fired — or that it was cancelled meanwhile. */
export async function settleFiring(
  sqlite: SqliteAgentRuntimeStore,
  { schedule, occurrence, at, owner }: ClaimedFiring,
  observedAt: Date,
  lateByMs: number,
): Promise<void> {
  // `every` after an idle stretch fires once and lands on the next slot
  // that is still ahead — not once per interval it slept through.
  let nextAt = schedule.nextAt;
  if (schedule.kind === 'every' && schedule.intervalMs) {
    let next = new Date(schedule.nextAt).getTime() + schedule.intervalMs;
    while (next <= observedAt.getTime()) next += schedule.intervalMs;
    nextAt = new Date(next).toISOString();
  }
  const state = schedule.kind === 'every' ? 'scheduled' : 'completed';
  await sqlite.transaction(async (scope) => {
    // Only the row this process still holds, and only while it is still
    // scheduled: a `cancelSchedule` that landed during `dispatch` stays a
    // cancellation, it is not written back to `scheduled`.
    const held = scope.database
      .prepare(`
        SELECT state, claim_owner FROM stitchkit_agent_runtime_schedules WHERE id = ?
      `)
      .get(schedule.id);
    const settled =
      held !== null &&
      held !== undefined &&
      (() => {
        const row = FinalizeRowSchema.parse(held);
        return row.state === 'scheduled' && row.claim_owner === owner;
      })();
    if (settled) {
      scope.database
        .prepare(`
          UPDATE stitchkit_agent_runtime_schedules
          SET state = ?, occurrence = ?, next_at = ?, updated_at = ?,
            claim_owner = NULL, claim_until = NULL
          WHERE id = ?
        `)
        .run(state, occurrence, nextAt, at, schedule.id);
    }
    if (lateByMs > 0) {
      await scope.appendEvent({
        conversationId: schedule.conversationId,
        kind: 'schedule/late',
        occurredAt: at,
        payload: { id: schedule.id, occurrence, lateByMs },
      });
    }
    await scope.appendEvent({
      conversationId: schedule.conversationId,
      kind: 'schedule/fired',
      occurredAt: at,
      payload: {
        id: schedule.id,
        occurrence,
        lateByMs,
        nextAt,
        state: settled ? state : 'cancelled',
      },
    });
  });
}

/**
 * Claim one due row for `owner` under a compare-and-set on its state and any
 * stale claim; `false` when another process holds it or it is no longer due.
 */
export function claimSchedule(
  sqlite: SqliteAgentRuntimeStore,
  owner: string,
  id: string,
  until: string,
  at: string,
): Promise<boolean> {
  return sqlite.transaction(async (scope) => {
    const raw = scope.database
      .prepare(`
        SELECT state, claim_until FROM stitchkit_agent_runtime_schedules WHERE id = ?
      `)
      .get(id);
    if (raw === null || raw === undefined) return false;
    const row = ClaimRowSchema.parse(raw);
    if (row.state !== 'scheduled') return false;
    if (row.claim_until !== null && row.claim_until >= at) return false;
    scope.database
      .prepare(`
        UPDATE stitchkit_agent_runtime_schedules
        SET claim_owner = ?, claim_until = ?, updated_at = ?
        WHERE id = ?
      `)
      .run(owner, until, at, id);
    return true;
  });
}
