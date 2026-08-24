import { describe, expect, test } from 'bun:test';
import { ActivitySnapshotSchema, createActivityProjection } from '../src/application/activity';
import { createApplicationSnapshotSink } from '../src/application/latest-sink';

describe('createApplicationSnapshotSink', () => {
  test('delivers a blocked revision 1 followed by only the latest revision 100', async () => {
    const blocked = Promise.withResolvers<void>();
    const seen: number[] = [];
    const sink = createApplicationSnapshotSink<{ readonly revision: number }>({
      async write(snapshot) {
        seen.push(snapshot.revision);
        if (snapshot.revision === 1) await blocked.promise;
      },
    });

    expect(sink.publish({ revision: 1 })).toBe(true);
    await Promise.resolve();
    for (let revision = 2; revision <= 100; revision += 1) {
      expect(sink.publish({ revision })).toBe(true);
    }

    expect(sink.getStatus()).toMatchObject({
      accepting: true,
      received: 100,
      accepted: 100,
      coalesced: 98,
      inFlight: true,
      pending: true,
      lastAcceptedRevision: 100,
    });

    const closing = sink.close();
    expect(sink.publish({ revision: 101 })).toBe(false);
    blocked.resolve();
    const status = await closing;

    expect(seen).toEqual([1, 100]);
    expect(status).toMatchObject({
      accepting: false,
      received: 101,
      accepted: 100,
      rejected: 1,
      delivered: 2,
      coalesced: 98,
      failed: 0,
      inFlight: false,
      pending: false,
      lastDeliveredRevision: 100,
    });
    expect(await sink.close()).toEqual(status);
  });

  test('isolates a write failure and still delivers the final accepted latest value', async () => {
    const failures: number[] = [];
    const delivered: number[] = [];
    const sink = createApplicationSnapshotSink<{ readonly revision: number }>({
      write(snapshot) {
        if (snapshot.revision === 1) throw new Error('sink unavailable');
        delivered.push(snapshot.revision);
      },
      onSinkError({ snapshot }) {
        failures.push(snapshot.revision);
        throw new Error('diagnostic unavailable');
      },
    });

    sink.publish({ revision: 1 });
    sink.publish({ revision: 2 });
    const status = await sink.close();

    expect(delivered).toEqual([2]);
    expect(failures).toEqual([1]);
    expect(status).toMatchObject({ failed: 1, delivered: 1, lastDeliveredRevision: 2 });
  });

  test('rejects duplicate and backwards revisions without disturbing delivery order', async () => {
    const seen: number[] = [];
    const sink = createApplicationSnapshotSink<{ readonly revision: number }>({
      write: (snapshot) => void seen.push(snapshot.revision),
    });

    expect(sink.publish({ revision: 2 })).toBe(true);
    expect(sink.publish({ revision: 2 })).toBe(false);
    expect(sink.publish({ revision: 1 })).toBe(false);
    await sink.close();

    expect(seen).toEqual([2]);
    expect(sink.getStatus()).toMatchObject({ received: 3, accepted: 1, rejected: 2 });
  });
});

describe('createActivityProjection', () => {
  test('uses a new epoch for a replacement process projection', () => {
    const first = createActivityProjection({ id: 'restart-proof', stages: ['running'] });
    const replacement = createActivityProjection({ id: 'restart-proof', stages: ['running'] });

    expect(first.getSnapshot().epoch).not.toBe(replacement.getSnapshot().epoch);
    expect(first.getSnapshot().revision).toBe(0);
    expect(replacement.getSnapshot().revision).toBe(0);
  });

  test('tracks typed stage transitions as immutable absolute snapshots', () => {
    let milliseconds = Date.parse('2026-08-23T00:00:00.000Z');
    const projection = createActivityProjection({
      id: 'media-pipeline',
      epoch: '20de4f9a-c4fe-4ff4-94d7-d32de3b9f301',
      stages: ['ingest', 'render'],
      now: () => new Date(milliseconds),
    });

    const initial = projection.getSnapshot();
    expect(initial).toMatchObject({
      id: 'media-pipeline',
      revision: 0,
      capturedAt: '2026-08-23T00:00:00.000Z',
      changedAt: '2026-08-23T00:00:00.000Z',
      totals: { active: 0, queued: 0, completed: 0, failed: 0 },
    });

    milliseconds += 1_000;
    const token = projection.open('ingest', 'queued');
    expect(JSON.stringify(token)).toBe('{}');
    milliseconds += 1_000;
    expect(projection.transition(token, { stage: 'render', state: 'active' })).toBe(true);
    milliseconds += 1_000;
    expect(projection.complete(token)).toBe(true);
    expect(projection.complete(token)).toBe(false);
    expect(projection.fail(token)).toBe(false);

    const snapshot = projection.getSnapshot();
    expect(snapshot).toEqual({
      id: 'media-pipeline',
      epoch: '20de4f9a-c4fe-4ff4-94d7-d32de3b9f301',
      revision: 3,
      capturedAt: '2026-08-23T00:00:03.000Z',
      changedAt: '2026-08-23T00:00:03.000Z',
      stages: [
        { id: 'ingest', active: 0, queued: 0, completed: 0, failed: 0 },
        { id: 'render', active: 0, queued: 0, completed: 1, failed: 0 },
      ],
      totals: { active: 0, queued: 0, completed: 1, failed: 0 },
    });
    expect(Object.isFrozen(snapshot)).toBe(true);
    expect(Object.isFrozen(snapshot.stages)).toBe(true);
    expect(Object.isFrozen(snapshot.stages[0])).toBe(true);
    expect(Object.isFrozen(snapshot.totals)).toBe(true);
    expect(JSON.stringify(snapshot)).not.toContain('token');
  });

  test('replays current state and coalesces a slow subscriber without blocking mutations', async () => {
    const blocked = Promise.withResolvers<void>();
    const latestDelivered = Promise.withResolvers<void>();
    const subscriberFailures = Promise.withResolvers<number>();
    const slowSeen: number[] = [];
    const projection = createActivityProjection({
      id: 'updates',
      stages: ['received'],
      onSubscriberError: ({ snapshot }) => subscriberFailures.resolve(snapshot.revision),
    });

    const unsubscribeSlow = projection.subscribe(async (snapshot) => {
      slowSeen.push(snapshot.revision);
      if (snapshot.revision === 0) await blocked.promise;
      if (snapshot.revision === 2) latestDelivered.resolve();
    });
    const unsubscribeFailing = projection.subscribe(() => {
      throw new Error('subscriber failed');
    });
    await Promise.resolve();

    const token = projection.open('received', 'active');
    expect(projection.complete(token)).toBe(true);
    expect(slowSeen).toEqual([0]);
    unsubscribeSlow();
    unsubscribeFailing();
    blocked.resolve();

    expect(await subscriberFailures.promise).toBe(0);
    await latestDelivered.promise;
    expect(slowSeen).toEqual([0, 2]);
  });

  test('rejects unbounded declarations and schemas reject arbitrary operational data', () => {
    expect(() => createActivityProjection({ id: '', stages: ['ready'] })).toThrow();
    expect(() =>
      createActivityProjection({ id: 'activity', stages: ['same', 'same'] }),
    ).toThrow('stage ids must be unique');
    expect(() =>
      createActivityProjection({
        id: 'activity',
        stages: Array.from({ length: 65 }, (_, index) => `stage-${index}`),
      }),
    ).toThrow();

    const projection = createActivityProjection({ id: 'activity', stages: ['ready'] });
    const snapshot = projection.getSnapshot();
    expect(
      ActivitySnapshotSchema.safeParse({ ...snapshot, payload: { secret: 'x' } }).success,
    ).toBe(false);
    const firstStage = snapshot.stages[0];
    if (!firstStage) throw new Error('expected declared stage');
    expect(
      ActivitySnapshotSchema.safeParse({
        ...snapshot,
        stages: [{ ...firstStage, itemId: 'private-id' }],
      }).success,
    ).toBe(false);
  });
});
