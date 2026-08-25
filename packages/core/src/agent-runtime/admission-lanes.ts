import type { AgentRuntimeResult } from './runtime-result';

/**
 * Process-local admission for one conversation key.
 *
 * At most two submissions are live per key: the one executing (`head`) and one
 * successor (`pending`). A third submission coalesces onto the successor
 * instead of queueing, so a key cannot accumulate work faster than it retires
 * it. `acceptanceTail` serialises acceptance so a caller never observes its
 * ticket before the durable record it refers to exists.
 */
export interface RuntimeAdmission {
  runId: string;
  completion: {
    promise: Promise<AgentRuntimeResult>;
    resolve(value: AgentRuntimeResult | PromiseLike<AgentRuntimeResult>): void;
    reject(reason?: unknown): void;
  };
}

export interface RuntimeAdmissionLane {
  head?: RuntimeAdmission;
  pending?: RuntimeAdmission;
  acceptanceTail: Promise<void>;
}

export interface RuntimeAdmissionReservation {
  lane: RuntimeAdmissionLane;
  admission: RuntimeAdmission;
  shouldSchedule: boolean;
}

export interface RuntimeAdmissionLanes {
  reserve(key: string, runId: string): RuntimeAdmissionReservation;
  settle(key: string, admission: RuntimeAdmission): void;
  waitForAcceptances(lane: RuntimeAdmissionLane): Promise<void>;
}

export function createRuntimeAdmissionLanes(): RuntimeAdmissionLanes {
  const lanes = new Map<string, RuntimeAdmissionLane>();

  const admit = (runId: string): RuntimeAdmission => {
    const admission = { runId, completion: Promise.withResolvers<AgentRuntimeResult>() };
    // Observed here so a caller that only awaits `accepted` never turns a
    // rejected completion into an unhandled rejection.
    void admission.completion.promise.catch(() => undefined);
    return admission;
  };

  return {
    reserve(key, runId) {
      const existing = lanes.get(key);
      const lane: RuntimeAdmissionLane = existing ?? { acceptanceTail: Promise.resolve() };
      if (!existing) lanes.set(key, lane);
      if (!lane.head) {
        lane.head = admit(runId);
        return { lane, admission: lane.head, shouldSchedule: true };
      }
      if (!lane.pending) {
        lane.pending = admit(runId);
        return { lane, admission: lane.pending, shouldSchedule: true };
      }
      return { lane, admission: lane.pending, shouldSchedule: false };
    },

    settle(key, admission) {
      const lane = lanes.get(key);
      if (!lane) return;
      if (lane.head?.runId === admission.runId) {
        lane.head = lane.pending;
        lane.pending = undefined;
      } else if (lane.pending?.runId === admission.runId) {
        lane.pending = undefined;
      }
      if (!lane.head && !lane.pending) lanes.delete(key);
    },

    async waitForAcceptances(lane) {
      // The tail is replaced by each acceptance, so settling on a stale tail
      // would return before a submission accepted in the meantime.
      while (true) {
        const tail = lane.acceptanceTail;
        await tail.catch(() => undefined);
        if (tail === lane.acceptanceTail) return;
      }
    },
  };
}
