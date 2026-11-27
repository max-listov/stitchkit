import { randomUUID } from 'node:crypto';
import type { StepDurabilityLedger } from '../../durability/contract';
import type { AgentStoreEventEnvelope } from '../../durability/events';
import type { AgentEngineSession, AgentEngineTurn } from '../engine';
import type { ExecutorDelta } from '../vocabulary';

/** How long a conformance check waits for something a conforming driver settles at once. */
export const CONFORMANCE_WAIT_MS = 10_000;

/** Fail the conformance run, naming the check that failed. */
export function conformanceFailure(name: string, message: string): never {
  throw new Error(`Agent engine conformance: ${name}: ${message}`);
}

/** Whether `error` is a failure a conformance check raised itself, rather than one a driver threw. */
export function isConformanceFailure(error: unknown): error is Error {
  return error instanceof Error && error.message.startsWith('Agent engine conformance');
}

/** Read a turn's deltas to the end of its stream, running `act` after each. */
export async function collectTurn(
  turn: AgentEngineTurn,
  act?: (delta: ExecutorDelta) => Promise<void>,
): Promise<ExecutorDelta[]> {
  const deltas: ExecutorDelta[] = [];
  for await (const delta of turn.deltas) {
    deltas.push(delta);
    await act?.(delta);
  }
  return deltas;
}

/** Whether the promise rejects. */
export async function rejects(promise: Promise<unknown>): Promise<boolean> {
  return promise.then(
    () => false,
    () => true,
  );
}

/** Start a one-line text turn under a fresh turn id. */
export function startTextTurn(session: AgentEngineSession, clientId: string = randomUUID()) {
  return session.startTurn({
    turnId: randomUUID(),
    clientId,
    input: [{ type: 'text', text: 'hello' }],
  });
}

/**
 * Wait for `promise` at most {@link CONFORMANCE_WAIT_MS}: a driver that never settles it fails the
 * check by name instead of hanging the run.
 */
export async function settlesInTime<T>(
  name: string,
  what: string,
  promise: Promise<T>,
): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const late = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(
      () =>
        reject(
          new Error(
            `Agent engine conformance: ${name}: ${what} did not settle within ${CONFORMANCE_WAIT_MS} ms`,
          ),
        ),
      CONFORMANCE_WAIT_MS,
    );
  });
  try {
    return await Promise.race([promise, late]);
  } finally {
    clearTimeout(timer);
  }
}

/** A step-durability ledger kept in memory for one conformance check. */
export function memoryLedger(): StepDurabilityLedger {
  const rows: AgentStoreEventEnvelope[] = [];
  return {
    appendEvent: async (event) => {
      const row: AgentStoreEventEnvelope = {
        schemaVersion: 1,
        eventId: randomUUID(),
        conversationId: event.conversationId,
        seq: rows.length + 1,
        kind: event.kind,
        occurredAt: new Date().toISOString(),
        payload: event.payload,
      };
      rows.push(row);
      return row;
    },
    readEvents: async (input) => ({
      items: rows.filter(
        (row) =>
          row.conversationId === input.conversationId && row.seq >= (input.fromSeq ?? 1),
      ),
    }),
  };
}
