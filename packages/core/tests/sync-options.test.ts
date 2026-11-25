/**
 * The numbers a sync app passes are refused where they are taken, before a timer, a request or
 * a batch: the session deadline by the one timer rule, the outbox limits by the integer rule. A
 * `Number(env.X)` that came back `NaN` would otherwise expire every page at once, or leave a push
 * batch bounded by nothing.
 */
import { describe, expect, test } from 'bun:test';
import {
  createSyncSession,
  decideOutboxBatch,
  type OutboxPolicy,
  type OutboxRow,
  type SyncPageRequest,
} from '../src/entrypoints/sync';
import { expectTimerRefusal } from './support/timer-refusal';

const ports = (deadlineMs: number, sent: SyncPageRequest[]) => ({
  isConnected: () => true,
  readCursor: () => 5,
  beginFullSync: () => undefined,
  send: (request: SyncPageRequest) => sent.push(request),
  apply: () => undefined,
  saveCursor: () => undefined,
  log: { info: () => undefined, warn: () => undefined, error: () => undefined },
  schedule: () => () => undefined,
  deadlineMs,
});

describe('createSyncSession', () => {
  test('a deadline outside the timer range is refused at creation, before a page is asked for', () => {
    for (const deadlineMs of [Number.NaN, 0, -5, 1.5, 3_000_000_000]) {
      const sent: SyncPageRequest[] = [];
      expectTimerRefusal(
        () => createSyncSession(ports(deadlineMs, sent)).requestSync(),
        'deadlineMs',
        deadlineMs,
      );
      expect(sent).toEqual([]);
    }
  });

  test('a deadline in the timer range is the one each page waits for (positive control)', () => {
    const sent: SyncPageRequest[] = [];
    const delays: number[] = [];
    const session = createSyncSession({
      ...ports(1_234, sent),
      schedule: (_run, delay) => {
        delays.push(delay);
        return () => undefined;
      },
    });
    session.requestSync();
    expect(sent).toHaveLength(1);
    expect(delays).toEqual([1_234]);
  });
});

describe('decideOutboxBatch', () => {
  const rows: OutboxRow[] = Array.from({ length: 20 }, (_, index) => ({
    id: `r${index}`,
    entity: 'task',
    entityId: `e${index}`,
    payloadJson: '{"x":1}',
    status: 'pending',
    sentAt: null,
    attempts: 0,
  }));
  const policy = (patch: Partial<OutboxPolicy<OutboxRow, unknown>> = {}) => ({
    toChange: (_row: OutboxRow, payload: unknown) => payload,
    emptyEnvelopeBytes: 10,
    maxBytes: 100,
    maxChanges: 5,
    retryAfterMs: 1_000,
    ...patch,
  });

  test('a limit that is not a positive safe integer is refused before any row is decided', () => {
    for (const [name, value] of [
      ['maxChanges', Number.NaN],
      ['maxChanges', 0],
      ['maxBytes', Number.NaN],
      ['maxBytes', 2.5],
      ['emptyEnvelopeBytes', -1],
    ] as const) {
      expect(() =>
        decideOutboxBatch(rows, { now: 0, policy: policy({ [name]: value }) }),
      ).toThrow(
        new RangeError(
          `[stitchkit] sync: ${name} must be a positive safe integer, received ${value}`,
        ),
      );
    }
  });

  test('a retry pause outside the timer range is refused, not handed back as a wake-up', () => {
    for (const retryAfterMs of [Number.NaN, 0, 2 ** 31])
      expectTimerRefusal(
        () => decideOutboxBatch(rows, { now: 0, policy: policy({ retryAfterMs }) }),
        'retryAfterMs',
        retryAfterMs,
      );
  });

  test('limits in range bound the batch (positive control)', () => {
    const decision = decideOutboxBatch(rows, { now: 0, policy: policy() });
    expect(decision.send).toHaveLength(5);
    expect(decision.full).toBe(true);
  });
});
