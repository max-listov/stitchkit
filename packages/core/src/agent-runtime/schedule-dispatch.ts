import { randomUUID } from 'node:crypto';
import type { z } from 'zod';
import {
  type AgentSchedule,
  type AgentScheduleDeliveryOutcome,
  AgentScheduleDeliveryOutcomeSchema,
} from './schedule-contract';
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
  dispatch(
    request: ScheduleDispatchRequest,
    // biome-ignore lint/suspicious/noConfusingVoidType: void is the existing successful callback contract.
  ): void | AgentScheduleDeliveryOutcome | Promise<void | AgentScheduleDeliveryOutcome>;
  now: () => Date;
  setTimer: (callback: () => void, delayMs: number) => ReturnType<typeof setTimeout>;
  clearTimer: (timer: ReturnType<typeof setTimeout>) => void;
  signal: AbortSignal;
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
    if (outcome === undefined) {
      await settleFiring(context.sqlite, firing, lateByMs);
    } else {
      const failure = AgentScheduleDeliveryOutcomeSchema.parse(outcome);
      await recordDispatchFailure(
        context.sqlite,
        firing,
        failure.reason,
        failure.status === 'terminal',
      );
    }
  } catch (error) {
    // Closing leaves the durable lease for recovery without touching a closing store.
    if (!context.signal.aborted) {
      await recordDispatchFailure(
        context.sqlite,
        { schedule, occurrence, now: context.now, owner },
        error instanceof Error ? error.message : String(error),
      );
    }
  } finally {
    context.clearTimer(timer);
    context.signal.removeEventListener('abort', abort);
  }
}
