import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import {
  claimSchedule,
  insertSchedule,
  newSchedule,
  recordDispatchFailure,
  type ScheduleRequest,
  settleFiring,
} from './schedule-records';
import type { SqliteAgentRuntimeStore } from './sqlite';

export const AgentScheduleSchema = z
  .object({
    id: z.string().min(1),
    conversationId: z.string().min(1),
    kind: z.enum(['at', 'after', 'every']),
    nextAt: z.iso.datetime({ offset: true }),
    intervalMs: z.int().positive().optional(),
    timeZone: z.string().min(1).optional(),
    input: z.json(),
    state: z.enum(['scheduled', 'cancelled', 'completed']),
    occurrence: z.int().nonnegative(),
    createdAt: z.iso.datetime({ offset: true }),
    updatedAt: z.iso.datetime({ offset: true }),
  })
  .strict();
export type AgentSchedule = z.infer<typeof AgentScheduleSchema>;

export interface AgentScheduleService {
  scheduleInput(request: {
    conversationId: string;
    input: z.infer<typeof z.json>;
    at?: string;
    afterMs?: number;
    everyMs?: number;
    timeZone?: string;
  }): Promise<AgentSchedule>;
  cancelSchedule(conversationId: string, id: string): Promise<boolean>;
  listSchedules(conversationId: string): readonly AgentSchedule[];
  tick(): Promise<void>;
  start(): void;
  close(): void;
}

const ScheduleRowSchema = z.object({
  id: z.string(),
  conversation_id: z.string(),
  kind: z.enum(['at', 'after', 'every']),
  next_at: z.string(),
  interval_ms: z.number().int().positive().nullable(),
  time_zone: z.string().nullable(),
  input_payload: z.string(),
  state: z.enum(['scheduled', 'cancelled', 'completed']),
  occurrence: z.int().nonnegative(),
  created_at: z.string(),
  updated_at: z.string(),
});

/**
 * Row reads that decide a conditional write, because `changes` cannot.
 *
 * The claim, the finalize and the cancellation each used to be one guarded
 * UPDATE whose outcome was `changes === 1`. That number is the driver's, and
 * `bun:sqlite` counts what the event table's AFTER INSERT trigger and FTS5's
 * deferred index flush wrote during the same statement — which is how
 * `importConversation` came to refuse a target it had just found empty.
 *
 * No input reaches these three that way today: each writes before it appends
 * its event, so no indexed write precedes it inside its own transaction. They
 * are written the safe way regardless, because the assumption is unsound on
 * the default driver and one reordering away from mattering — an inflated
 * count reads a claim as lost and a firing as cancelled, and an inflated count
 * over a no-op UPDATE publishes `schedule/cancelled` for a row nothing
 * cancelled. Each reads its row first and writes unconditionally, inside the
 * store's `BEGIN IMMEDIATE` transaction.
 */
export const ClaimRowSchema = z.object({
  state: z.enum(['scheduled', 'cancelled', 'completed']),
  claim_until: z.string().nullable(),
});
export const FinalizeRowSchema = z.object({
  state: z.enum(['scheduled', 'cancelled', 'completed']),
  claim_owner: z.string().nullable(),
});
const StateRowSchema = z.object({
  state: z.enum(['scheduled', 'cancelled', 'completed']),
});

function parseSchedule(raw: unknown): AgentSchedule {
  const row = ScheduleRowSchema.parse(raw);
  return AgentScheduleSchema.parse({
    id: row.id,
    conversationId: row.conversation_id,
    kind: row.kind,
    nextAt: row.next_at,
    ...(row.interval_ms !== null && { intervalMs: row.interval_ms }),
    ...(row.time_zone !== null && { timeZone: row.time_zone }),
    input: JSON.parse(row.input_payload),
    state: row.state,
    occurrence: row.occurrence,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  });
}

export function createAgentScheduleService(input: {
  sqlite: SqliteAgentRuntimeStore;
  dispatch(request: {
    conversationId: string;
    idempotencyKey: string;
    input: z.infer<typeof z.json>;
    schedule: { id: string; occurrence: number; lateByMs: number };
  }): void | Promise<void>;
  now?: () => Date;
  setTimer?: (callback: () => void, delayMs: number) => ReturnType<typeof setTimeout>;
  clearTimer?: (timer: ReturnType<typeof setTimeout>) => void;
  /**
   * Where a tick's own failure goes — a claim on a closing store, an event on
   * a purged conversation. Not a dispatch failure: that is recorded durably as
   * `schedule/failed`. Without a handler the failure is printed, because a
   * timer-driven loop has no caller to reject to and silence would be worse.
   */
  onError?: (error: unknown) => void;
}): AgentScheduleService {
  const onError =
    input.onError ??
    ((error: unknown) => {
      console.error('[stitchkit] agent schedule tick failed', error);
    });
  const now = input.now ?? (() => new Date());
  const database = input.sqlite.database;
  const setTimer = input.setTimer ?? ((callback, delay) => setTimeout(callback, delay));
  const clearTimer = input.clearTimer ?? clearTimeout;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let closed = false;

  const listSchedules = (conversationId: string): readonly AgentSchedule[] =>
    database
      .prepare(`
        SELECT id, conversation_id, kind, next_at, interval_ms, time_zone,
          input_payload, state, occurrence, created_at, updated_at
        FROM stitchkit_agent_runtime_schedules
        WHERE conversation_id = ? ORDER BY created_at, id
      `)
      .all(conversationId)
      .map(parseSchedule);

  const arm = () => {
    if (timer) clearTimer(timer);
    if (closed) return;
    try {
      armNext();
    } catch (error) {
      onError(error);
    }
  };

  const armNext = () => {
    // The next moment anything can fire: a row's `next_at`, or — for a row
    // another process holds — the end of its claim. Arming on `next_at` alone
    // spun: a claimed row in the past armed a zero delay, the tick found the
    // claim, re-armed, and so on, one write transaction every ~1.5 ms.
    const raw = database
      .prepare(`
        SELECT MAX(next_at, COALESCE(claim_until, next_at)) AS due_at
        FROM stitchkit_agent_runtime_schedules
        WHERE state = 'scheduled' ORDER BY due_at, id LIMIT 1
      `)
      .get() as { due_at?: string } | null | undefined;
    if (raw === null || raw === undefined || typeof raw.due_at !== 'string') return;
    const delay = Math.max(0, new Date(raw.due_at).getTime() - now().getTime());
    timer = setTimer(() => void tick(), Math.min(delay, 2_147_483_647));
  };

  const owner = randomUUID();
  /** How long one claimed firing may run before another process may take it over. */
  const CLAIM_MS = 60_000;
  let ticking: Promise<void> | undefined;

  /**
   * One firing per occurrence, whoever runs.
   *
   * A row is claimed — `claim_owner`/`claim_until` written under a
   * compare-and-set on its state and any stale claim — BEFORE `dispatch`, so a
   * second `tick` (this process re-arming, or another process on the same
   * file) sees the claim and passes. The claim expires, so a process that dies
   * mid-dispatch does not park the schedule forever.
   */
  const claim = (id: string, until: string, at: string): Promise<boolean> =>
    claimSchedule(input.sqlite, owner, id, until, at);

  const runTick = async () => {
    if (closed) return;
    const observedAt = now();
    const due = database
      .prepare(`
        SELECT id, conversation_id, kind, next_at, interval_ms, time_zone,
          input_payload, state, occurrence, created_at, updated_at
        FROM stitchkit_agent_runtime_schedules
        WHERE state = 'scheduled' AND next_at <= ? ORDER BY next_at, id
      `)
      .all(observedAt.toISOString())
      .map(parseSchedule);
    for (const schedule of due) {
      const at = observedAt.toISOString();
      if (
        !(await claim(
          schedule.id,
          new Date(observedAt.getTime() + CLAIM_MS).toISOString(),
          at,
        ))
      ) {
        continue;
      }
      const occurrence = schedule.occurrence + 1;
      const lateByMs = Math.max(0, observedAt.getTime() - new Date(schedule.nextAt).getTime());
      try {
        await input.dispatch({
          conversationId: schedule.conversationId,
          idempotencyKey: `schedule:${schedule.id}:${occurrence}`,
          input: schedule.input,
          schedule: { id: schedule.id, occurrence, lateByMs },
        });
      } catch (error) {
        await recordDispatchFailure(input.sqlite, { schedule, occurrence, at, owner }, error);
        continue;
      }
      await settleFiring(
        input.sqlite,
        { schedule, occurrence, at, owner },
        observedAt,
        lateByMs,
      );
    }
  };

  /** One tick in flight; a tick requested during one runs after it. */
  const tick = (): Promise<void> => {
    if (ticking) return ticking;
    ticking = runTick()
      .catch(onError)
      .finally(() => {
        ticking = undefined;
        arm();
      });
    return ticking;
  };

  const scheduleInput = async (request: ScheduleRequest): Promise<AgentSchedule> => {
    const schedule = newSchedule(request, now());
    await insertSchedule(input.sqlite, schedule);
    arm();
    return schedule;
  };

  const cancelSchedule = async (conversationId: string, id: string): Promise<boolean> => {
    const observedAt = now().toISOString();
    const changed = await input.sqlite.transaction(async (scope) => {
      const raw = scope.database
        .prepare(`
          SELECT state FROM stitchkit_agent_runtime_schedules
          WHERE id = ? AND conversation_id = ?
        `)
        .get(id, conversationId);
      if (raw === null || raw === undefined) return false;
      if (StateRowSchema.parse(raw).state !== 'scheduled') return false;
      scope.database
        .prepare(`
          UPDATE stitchkit_agent_runtime_schedules SET state = 'cancelled', updated_at = ?
          WHERE id = ? AND conversation_id = ?
        `)
        .run(observedAt, id, conversationId);
      await scope.appendEvent({
        conversationId,
        kind: 'schedule/cancelled',
        occurredAt: observedAt,
        payload: { id },
      });
      return true;
    });
    if (changed) arm();
    return changed;
  };

  return {
    scheduleInput,
    cancelSchedule,
    listSchedules,
    tick,
    start: arm,
    close() {
      closed = true;
      if (timer) clearTimer(timer);
    },
  };
}
