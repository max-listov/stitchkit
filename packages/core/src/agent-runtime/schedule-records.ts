/**
 * What firing and setting a schedule write: the new row, the durable failure
 * of a dispatch, and the settlement of a claimed occurrence. Each runs in one
 * store transaction with the conversation event that records it.
 */
import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import { type AgentSchedule, AgentScheduleSchema } from './schedule-contract';
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
  readonly now: () => Date;
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

/** A settlement is valid only for this unexpired attempt and unchanged occurrence. */
function holdsClaim(raw: unknown, firing: ClaimedFiring, at: string): boolean {
  if (raw === null || raw === undefined) return false;
  const row = z
    .object({
      state: z.string(),
      claim_owner: z.string().nullable(),
      claim_until: z.string().nullable(),
      occurrence: z.int(),
      next_at: z.string(),
    })
    .parse(raw);
  return (
    row.state === 'scheduled' &&
    row.claim_owner === firing.owner &&
    row.claim_until !== null &&
    row.claim_until > at &&
    row.occurrence === firing.schedule.occurrence &&
    row.next_at === firing.schedule.nextAt
  );
}

/** Retry delay is durable, capped at a minute, and never changes the occurrence's due time. */
export async function recordDispatchFailure(
  sqlite: SqliteAgentRuntimeStore,
  firing: ClaimedFiring,
  reason: string,
  terminal = false,
): Promise<void> {
  const { schedule, occurrence } = firing;
  await sqlite.transaction(async (scope) => {
    const at = firing.now().toISOString();
    const raw = scope.database
      .prepare(`
      SELECT state, claim_owner, claim_until, occurrence, next_at
      FROM stitchkit_agent_runtime_schedules WHERE id = ?
    `)
      .get(schedule.id);
    if (!holdsClaim(raw, firing, at)) return;
    const attempts = Math.min((schedule.attempts ?? 0) + 1, Number.MAX_SAFE_INTEGER);
    const retryAt = terminal
      ? null
      : new Date(
          new Date(at).getTime() + Math.min(60_000, 1_000 * 2 ** Math.min(attempts - 1, 6)),
        ).toISOString();
    scope.database
      .prepare(`
      UPDATE stitchkit_agent_runtime_schedules
      SET state = ?, retry_at = ?, attempts = ?, last_error = ?,
        claim_owner = NULL, claim_until = NULL, updated_at = ? WHERE id = ?
    `)
      .run(terminal ? 'failed' : 'scheduled', retryAt, attempts, reason, at, schedule.id);
    await scope.appendEvent({
      conversationId: schedule.conversationId,
      kind: 'schedule/failed',
      occurredAt: at,
      payload: { id: schedule.id, occurrence, message: reason, attempts, retryAt, terminal },
    });
  });
}

/** Advance only the held occurrence; stale and cancelled attempts produce no settlement events. */
export async function settleFiring(
  sqlite: SqliteAgentRuntimeStore,
  firing: ClaimedFiring,
  lateByMs: number,
): Promise<void> {
  const { schedule, occurrence } = firing;
  const state = schedule.kind === 'every' ? 'scheduled' : 'completed';
  await sqlite.transaction(async (scope) => {
    const observedAt = firing.now();
    const at = observedAt.toISOString();
    let nextAt = schedule.nextAt;
    if (schedule.kind === 'every' && schedule.intervalMs) {
      const due = new Date(schedule.nextAt).getTime();
      const slots = Math.max(
        1,
        Math.floor((observedAt.getTime() - due) / schedule.intervalMs) + 1,
      );
      nextAt = new Date(due + slots * schedule.intervalMs).toISOString();
    }

    const raw = scope.database
      .prepare(`
      SELECT state, claim_owner, claim_until, occurrence, next_at
      FROM stitchkit_agent_runtime_schedules WHERE id = ?
    `)
      .get(schedule.id);
    if (!holdsClaim(raw, firing, at)) return;
    scope.database
      .prepare(`
      UPDATE stitchkit_agent_runtime_schedules
      SET state = ?, occurrence = ?, next_at = ?, updated_at = ?,
        claim_owner = NULL, claim_until = NULL, retry_at = NULL, attempts = 0, last_error = NULL
      WHERE id = ?
    `)
      .run(state, occurrence, nextAt, at, schedule.id);
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
      payload: { id: schedule.id, occurrence, lateByMs, nextAt, state },
    });
  });
}

/** Recheck both eligibility and the selected occurrence under BEGIN IMMEDIATE. */
export function claimSchedule(
  sqlite: SqliteAgentRuntimeStore,
  owner: string,
  schedule: AgentSchedule,
  now: () => Date,
): Promise<boolean> {
  return sqlite.transaction(async (scope) => {
    const observedAt = now();
    const at = observedAt.toISOString();
    const until = new Date(observedAt.getTime() + 60_000).toISOString();
    const raw = scope.database
      .prepare(`
      SELECT occurrence, next_at, attempts FROM stitchkit_agent_runtime_schedules
      WHERE id = ? AND state = 'scheduled' AND eligible_at <= ?
    `)
      .get(schedule.id, at);
    if (raw === null || raw === undefined) return false;
    const row = z
      .object({ occurrence: z.int(), next_at: z.string(), attempts: z.int() })
      .parse(raw);
    if (row.attempts !== (schedule.attempts ?? 0)) return false;
    if (row.occurrence !== schedule.occurrence || row.next_at !== schedule.nextAt)
      return false;
    scope.database
      .prepare(`
      UPDATE stitchkit_agent_runtime_schedules
      SET claim_owner = ?, claim_until = ?, updated_at = ? WHERE id = ?
    `)
      .run(owner, until, at, schedule.id);
    return true;
  });
}
