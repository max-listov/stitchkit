import { randomUUID } from 'node:crypto';
import { z } from 'zod';
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
    input.sqlite.transaction(
      async (scope) =>
        scope.database
          .prepare(`
            UPDATE stitchkit_agent_runtime_schedules
            SET claim_owner = ?, claim_until = ?, updated_at = ?
            WHERE id = ? AND state = 'scheduled' AND (claim_until IS NULL OR claim_until < ?)
          `)
          .run(owner, until, at, id, at).changes === 1,
    );

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
        // The row stays due and unclaimed; the failure is a durable fact of
        // the conversation, not a silent skip and not a dead timer.
        await input.sqlite.transaction(async (scope) => {
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
        continue;
      }
      // `every` after an idle stretch fires once and lands on the next slot
      // that is still ahead — not once per interval it slept through.
      let nextAt = schedule.nextAt;
      if (schedule.kind === 'every' && schedule.intervalMs) {
        let next = new Date(schedule.nextAt).getTime() + schedule.intervalMs;
        while (next <= observedAt.getTime()) next += schedule.intervalMs;
        nextAt = new Date(next).toISOString();
      }
      const state = schedule.kind === 'every' ? 'scheduled' : 'completed';
      await input.sqlite.transaction(async (scope) => {
        // Only the row this process still holds, and only while it is still
        // scheduled: a `cancelSchedule` that landed during `dispatch` stays a
        // cancellation, it is not written back to `scheduled`.
        const settled =
          scope.database
            .prepare(`
              UPDATE stitchkit_agent_runtime_schedules
              SET state = ?, occurrence = ?, next_at = ?, updated_at = ?,
                claim_owner = NULL, claim_until = NULL
              WHERE id = ? AND state = 'scheduled' AND claim_owner = ?
            `)
            .run(state, occurrence, nextAt, at, schedule.id, owner).changes === 1;
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

  const scheduleInput = async (request: {
    conversationId: string;
    input: z.infer<typeof z.json>;
    at?: string;
    afterMs?: number;
    everyMs?: number;
    timeZone?: string;
  }): Promise<AgentSchedule> => {
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
    const observedAt = now();
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
    await input.sqlite.transaction(async (scope) => {
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
    arm();
    return schedule;
  };

  const cancelSchedule = async (conversationId: string, id: string): Promise<boolean> => {
    const observedAt = now().toISOString();
    const changed = await input.sqlite.transaction(async (scope) => {
      const count = scope.database
        .prepare(`
          UPDATE stitchkit_agent_runtime_schedules SET state = 'cancelled', updated_at = ?
          WHERE id = ? AND conversation_id = ? AND state = 'scheduled'
        `)
        .run(observedAt, id, conversationId).changes;
      if (count > 0) {
        await scope.appendEvent({
          conversationId,
          kind: 'schedule/cancelled',
          occurredAt: observedAt,
          payload: { id },
        });
      }
      return count;
    });
    if (changed > 0) arm();
    return changed > 0;
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
