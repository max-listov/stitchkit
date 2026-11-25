import { z } from 'zod';
import { assertPositiveSafeInteger } from '../internal/positive-integer';
import { type SteppedTimerClock, scheduleAt } from '../internal/timers';
import {
  type AgentSchedule,
  type AgentScheduleService,
  parseSchedule,
} from './schedule-contract';
import { dispatchSchedule, type ScheduleDispatchContext } from './schedule-dispatch';
import { insertSchedule, newSchedule, type ScheduleRequest } from './schedule-records';

/** The service's own clock and timer, as the stepper reads them: the next due schedule is waited for in steps. */
function serviceClock(
  now: () => Date,
  setTimer: NonNullable<ScheduleDispatchContext['setTimer']>,
  clearTimer: NonNullable<ScheduleDispatchContext['clearTimer']>,
): SteppedTimerClock {
  return {
    now: () => now().getTime(),
    schedule(callback, delayMs) {
      const handle = setTimer(callback, delayMs);
      return { cancel: () => clearTimer(handle) };
    },
  };
}

/** What `createAgentScheduleService` takes; both limits are required. */
export interface AgentScheduleServiceConfig {
  host: ScheduleDispatchContext['host'];
  dispatch: ScheduleDispatchContext['dispatch'];
  /** Schedules one conversation may hold in `scheduled` state at once; one more refuses. */
  maxActivePerConversation: number;
  /** The shortest `everyMs` a repeating schedule may take; a shorter one refuses. */
  minIntervalMs: number;
  now?: () => Date;
  setTimer?: ScheduleDispatchContext['setTimer'];
  clearTimer?: ScheduleDispatchContext['clearTimer'];
  /** Storage/tick failures; dispatch failures are recorded in schedule/failed. */
  onError?: (error: unknown) => void;
  /**
   * Failed dispatch attempts after which a schedule is `failed` rather than
   * retried. Default 1000 — about sixteen hours at the one-minute retry ceiling.
   */
  maxAttempts?: number;
}

/**
 * Durable deferred input over a SQL store's companion host — SQLite or
 * Postgres. The memory store and hand-written drivers have no schedules.
 */
export function createAgentScheduleService(
  input: AgentScheduleServiceConfig,
): AgentScheduleService {
  // Required by the type, checked here for a caller that is not typed: no
  // limit is not a default the model may spend.
  for (const name of ['maxActivePerConversation', 'minIntervalMs'] as const) {
    if (input[name] === undefined)
      throw new TypeError(`createAgentScheduleService requires ${name}`);
    assertPositiveSafeInteger(name, input[name]);
  }
  const limits = {
    maxActivePerConversation: input.maxActivePerConversation,
    minIntervalMs: input.minIntervalMs,
  };
  const maxAttempts = z
    .number()
    .int()
    .min(1)
    .parse(input.maxAttempts ?? 1_000);
  const now = input.now ?? (() => new Date());
  const host = input.host;
  const setTimer = input.setTimer ?? ((callback, delay) => setTimeout(callback, delay));
  const clearTimer = input.clearTimer ?? clearTimeout;
  const onError =
    input.onError ??
    ((error: unknown) => {
      console.error('[stitchkit] agent schedule tick failed', error);
    });
  const lifecycle = new AbortController();
  const clock = serviceClock(now, setTimer, clearTimer);
  let timer: { cancel(): void } | undefined;
  const cancelTimer = (): void => {
    timer?.cancel();
    timer = undefined;
  };
  let ticking: Promise<void> | undefined;
  let recoveryAt = 0;
  let storageFailures = 0;

  const reportStorageFailure = (error: unknown) => {
    storageFailures += 1;
    recoveryAt =
      now().getTime() + Math.min(60_000, 1_000 * 2 ** Math.min(storageFailures - 1, 6));
    onError(error);
  };

  const listSchedules = (conversationId: string): Promise<readonly AgentSchedule[]> =>
    host.read(async (session) =>
      (
        await session.all(
          `SELECT * FROM ${host.tables.schedules} WHERE conversation_id = ? ORDER BY created_at, id`,
          [conversationId],
        )
      ).map(parseSchedule),
    );

  // The next due time is read asynchronously, so two `arm` calls can be in
  // flight at once; only the newest may set the timer.
  let armGeneration = 0;
  const nextDueAt = (): Promise<number | undefined> =>
    host.read(async (session) => {
      const raw = await session.get(
        `SELECT eligible_at FROM ${host.tables.schedules}
         WHERE state = 'scheduled' ORDER BY eligible_at, id LIMIT 1`,
      );
      if (raw === undefined) return undefined;
      return new Date(z.object({ eligible_at: z.string() }).parse(raw).eligible_at).getTime();
    });

  const arm = async (): Promise<void> => {
    cancelTimer();
    if (lifecycle.signal.aborted || ticking) return;
    const generation = ++armGeneration;
    let dueAt: number;
    if (recoveryAt > now().getTime()) {
      dueAt = recoveryAt;
    } else {
      try {
        const next = await nextDueAt();
        if (next === undefined) return;
        dueAt = next;
      } catch (error) {
        reportStorageFailure(error);
        dueAt = recoveryAt;
      }
    }
    if (generation !== armGeneration || lifecycle.signal.aborted || ticking) return;
    cancelTimer();
    timer = scheduleAt(clock, dueAt, () => {
      timer = undefined;
      void tick();
    });
  };

  const runTick = async () => {
    if (lifecycle.signal.aborted || now().getTime() < recoveryAt) return;
    const due = await host.read(async (session) =>
      (
        await session.all(
          `SELECT * FROM ${host.tables.schedules}
           WHERE state = 'scheduled' AND eligible_at <= ? ORDER BY eligible_at, id LIMIT 32`,
          [now().toISOString()],
        )
      ).map(parseSchedule),
    );
    // Bound concurrency and isolate a slow consumer from the rest of this batch.
    const results = await Promise.allSettled(
      due.map((schedule) =>
        dispatchSchedule(
          {
            host,
            dispatch: input.dispatch,
            now,
            setTimer,
            clearTimer,
            signal: lifecycle.signal,
            maxAttempts,
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

  // A tick resolves once the next timer is armed, so a caller that awaits it
  // sees the service in its settled state.
  const tick = (): Promise<void> => {
    if (ticking) return ticking;
    cancelTimer();
    const current = (async () => {
      try {
        await runTick();
      } catch (error) {
        reportStorageFailure(error);
      } finally {
        ticking = undefined;
      }
      await arm();
    })();
    ticking = current;
    return current;
  };

  const scheduleInput = async (request: ScheduleRequest): Promise<AgentSchedule> => {
    const schedule = newSchedule(request, now());
    if (schedule.intervalMs !== undefined && schedule.intervalMs < limits.minIntervalMs)
      throw new TypeError(
        `A repeating schedule fires at most every ${limits.minIntervalMs} ms, received everyMs ${schedule.intervalMs}`,
      );
    await insertSchedule(host, schedule, limits.maxActivePerConversation);
    await arm();
    return schedule;
  };

  const cancelSchedule = async (conversationId: string, id: string): Promise<boolean> => {
    const observedAt = now().toISOString();
    const changed = await host.transaction(conversationId, async (scope) => {
      const raw = await scope.get(
        `SELECT state FROM ${host.tables.schedules} WHERE id = ? AND conversation_id = ?`,
        [id, conversationId],
      );
      if (raw === undefined) return false;
      if (z.object({ state: z.string() }).parse(raw).state !== 'scheduled') return false;
      await scope.run(
        `UPDATE ${host.tables.schedules}
         SET state = 'cancelled', updated_at = ?, claim_owner = NULL, claim_until = NULL
         WHERE id = ? AND conversation_id = ?`,
        [observedAt, id, conversationId],
      );
      await scope.appendEvent({
        conversationId,
        kind: 'schedule/cancelled',
        occurredAt: observedAt,
        payload: { id },
      });
      return true;
    });
    if (changed) await arm();
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
      cancelTimer();
    },
  };
}
