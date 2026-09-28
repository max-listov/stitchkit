import { randomUUID } from 'node:crypto';
import type { z } from 'zod';
import { type AgentSchedule, AgentScheduleDeliveryOutcomeSchema } from './schedule-contract';
import { claimSchedule, recordDispatchFailure, settleFiring } from './schedule-records';
import type { SqliteAgentRuntimeStore } from './sqlite';

export interface ScheduleDispatchRequest {
  conversationId: string;
  idempotencyKey: string;
  input: z.infer<typeof z.json>;
  schedule: { id: string; occurrence: number; lateByMs: number };
  /** Aborted after 30 seconds or service close; consumers must deduplicate even after abort. */
  signal: AbortSignal;
}
export interface ScheduleDispatchContext {
  sqlite: SqliteAgentRuntimeStore;
  /**
   * Admit the firing. Return an `AgentScheduleDeliveryOutcome` (or throw) to
   * fail it; returning anything else — nothing, a queue length, a receipt —
   * means it was delivered.
   */
  dispatch(request: ScheduleDispatchRequest): unknown;
  now: () => Date;
  setTimer: (callback: () => void, delayMs: number) => ReturnType<typeof setTimeout>;
  clearTimer: (timer: ReturnType<typeof setTimeout>) => void;
  signal: AbortSignal;
  /** Failed attempts after which a schedule becomes `failed` instead of retrying. */
  maxAttempts: number;
}

/** One fenced, bounded attempt. Consumer admission and settlement are at-least-once. */
export async function dispatchSchedule(
  context: ScheduleDispatchContext,
  schedule: AgentSchedule,
) {
  if (context.signal.aborted) return;
  const owner = randomUUID();
  if (!(await claimSchedule(context.sqlite, owner, schedule, context.now))) return;
  const observedAt = context.now();
  const occurrence = schedule.occurrence + 1;
  const lateByMs = Math.max(0, observedAt.getTime() - new Date(schedule.nextAt).getTime());
  const controller = new AbortController();
  const aborted = Promise.withResolvers<never>();
  const abort = () => {
    const error = new Error('Schedule dispatch aborted');
    controller.abort(error);
    aborted.reject(error);
  };
  context.signal.addEventListener('abort', abort, { once: true });
  const timer = context.setTimer(abort, 30_000);
  try {
    if (context.signal.aborted) abort();
    const outcome = await Promise.race([
      aborted.promise,
      Promise.resolve().then(() => {
        controller.signal.throwIfAborted();
        return context.dispatch({
          conversationId: schedule.conversationId,
          idempotencyKey: `schedule:${schedule.id}:${occurrence}`,
          input: schedule.input,
          schedule: { id: schedule.id, occurrence, lateByMs },
          signal: controller.signal,
        });
      }),
    ]);
    const firing = { schedule, occurrence, now: context.now, owner };
    // Only an explicit outcome is a failure. Whatever else the callback returns
    // — `jobs.push(...)`'s length, a receipt — it returned, so it delivered.
    const failure = AgentScheduleDeliveryOutcomeSchema.safeParse(outcome);
    if (!failure.success) {
      await settleFiring(context.sqlite, firing, lateByMs);
    } else {
      await recordDispatchFailure(
        context.sqlite,
        firing,
        failure.data.reason,
        context.maxAttempts,
        failure.data.status === 'terminal',
      );
    }
  } catch (error) {
    // Closing leaves the durable lease for recovery without touching a closing store.
    if (!context.signal.aborted) {
      await recordDispatchFailure(
        context.sqlite,
        { schedule, occurrence, now: context.now, owner },
        error instanceof Error ? error.message : String(error),
        context.maxAttempts,
      );
    }
  } finally {
    context.clearTimer(timer);
    context.signal.removeEventListener('abort', abort);
  }
}
