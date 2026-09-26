import { z } from 'zod';
import {
  type AgentSchedule,
  type AgentScheduleService,
  parseSchedule,
} from './schedule-contract';
import { dispatchSchedule, type ScheduleDispatchContext } from './schedule-dispatch';
import { insertSchedule, newSchedule, type ScheduleRequest } from './schedule-records';

export function createAgentScheduleService(input: {
  sqlite: ScheduleDispatchContext['sqlite'];
  dispatch: ScheduleDispatchContext['dispatch'];
  now?: () => Date;
  setTimer?: ScheduleDispatchContext['setTimer'];
  clearTimer?: ScheduleDispatchContext['clearTimer'];
  /** Storage/tick failures; dispatch failures are recorded in schedule/failed. */
  onError?: (error: unknown) => void;
}): AgentScheduleService {
  const now = input.now ?? (() => new Date());
  const database = input.sqlite.database;
  const setTimer = input.setTimer ?? ((callback, delay) => setTimeout(callback, delay));
  const clearTimer = input.clearTimer ?? clearTimeout;
  const onError =
    input.onError ??
    ((error: unknown) => {
      console.error('[stitchkit] agent schedule tick failed', error);
    });
  const lifecycle = new AbortController();
  let timer: ReturnType<typeof setTimeout> | undefined;
  let ticking: Promise<void> | undefined;
  let recoveryAt = 0;
  let storageFailures = 0;

  const reportStorageFailure = (error: unknown) => {
    storageFailures += 1;
    recoveryAt =
      now().getTime() + Math.min(60_000, 1_000 * 2 ** Math.min(storageFailures - 1, 6));
    onError(error);
  };

  const listSchedules = (conversationId: string): readonly AgentSchedule[] =>
    database
      .prepare(`
    SELECT * FROM stitchkit_agent_runtime_schedules
    WHERE conversation_id = ? ORDER BY created_at, id
  `)
      .all(conversationId)
      .map(parseSchedule);

  const arm = () => {
    if (timer !== undefined) clearTimer(timer);
    timer = undefined;
    if (lifecycle.signal.aborted || ticking) return;
    let dueAt: number;
    if (recoveryAt > now().getTime()) {
      dueAt = recoveryAt;
    } else {
      try {
        const raw = database
          .prepare(`
          SELECT eligible_at FROM stitchkit_agent_runtime_schedules
          WHERE state = 'scheduled' ORDER BY eligible_at, id LIMIT 1
        `)
          .get();
        if (raw === null || raw === undefined) return;
        dueAt = new Date(
          z.object({ eligible_at: z.string() }).parse(raw).eligible_at,
        ).getTime();
      } catch (error) {
        reportStorageFailure(error);
        dueAt = recoveryAt;
      }
    }
    timer = setTimer(
      () => {
        timer = undefined;
        void tick();
      },
      Math.min(Math.max(0, dueAt - now().getTime()), 2_147_483_647),
    );
  };

  const runTick = async () => {
    if (lifecycle.signal.aborted || now().getTime() < recoveryAt) return;
    const due = database
      .prepare(`
      SELECT * FROM stitchkit_agent_runtime_schedules
      WHERE state = 'scheduled' AND eligible_at <= ? ORDER BY eligible_at, id LIMIT 32
    `)
      .all(now().toISOString())
      .map(parseSchedule);
    // Bound concurrency and isolate a slow consumer from the rest of this batch.
    const results = await Promise.allSettled(
      due.map((schedule) =>
        dispatchSchedule(
          {
            sqlite: input.sqlite,
            dispatch: input.dispatch,
            now,
            setTimer,
            clearTimer,
            signal: lifecycle.signal,
          },
          schedule,
        ),
      ),
    );
    const failed = results.find((result) => result.status === 'rejected');
    if (failed?.status === 'rejected') throw failed.reason;
    recoveryAt = 0;
    storageFailures = 0;
  };

  const tick = (): Promise<void> => {
    if (ticking) return ticking;
    if (timer !== undefined) clearTimer(timer);
    timer = undefined;
    ticking = runTick()
      .catch(reportStorageFailure)
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
        SELECT state FROM stitchkit_agent_runtime_schedules WHERE id = ? AND conversation_id = ?
      `)
        .get(id, conversationId);
      if (raw === null || raw === undefined) return false;
      if (z.object({ state: z.string() }).parse(raw).state !== 'scheduled') return false;
      scope.database
        .prepare(`
        UPDATE stitchkit_agent_runtime_schedules
        SET state = 'cancelled', updated_at = ?, claim_owner = NULL, claim_until = NULL
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
      lifecycle.abort();
      if (timer !== undefined) clearTimer(timer);
      timer = undefined;
    },
  };
}
