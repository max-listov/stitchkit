/**
 * The outbox over both adapters. Every property is asserted through the same
 * suite for memory and for IndexedDB (via fake-indexeddb): the adapter a
 * consumer runs is the one a test exercises, not a stand-in for it.
 */
import { describe, expect, test } from 'bun:test';
import { IDBFactory } from 'fake-indexeddb';
import { createTrackingOutbox, type TrackingOutboxStorage } from '../src/tracking/outbox';
import { indexedDbOutboxStorage } from '../src/tracking/outbox-storage-indexeddb';
import { memoryOutboxStorage } from '../src/tracking/outbox-storage-memory';

interface Event {
  eventId: string;
  browserSequence: number;
}

const event = (n: number): Event => ({ eventId: `e${n}`, browserSequence: n });

let databases = 0;
const adapters: Array<[string, () => TrackingOutboxStorage<Event>]> = [
  ['memory', () => memoryOutboxStorage<Event>()],
  [
    'indexeddb',
    () => {
      const factory = new IDBFactory();
      databases += 1;
      return indexedDbOutboxStorage<Event>(`outbox-${databases}`, () => factory);
    },
  ],
];

describe.each(adapters)('outbox over %s', (_name, storage) => {
  test('reserved sequences are consecutive, monotonic and never handed out twice', async () => {
    const outbox = createTrackingOutbox(storage());
    const [a, b] = await Promise.all([outbox.reserveSequences(3), outbox.reserveSequences(2)]);
    const all = [...(a ?? []), ...(b ?? [])].sort((x, y) => x - y);
    expect(all).toEqual([1, 2, 3, 4, 5]);
    expect(await outbox.reserveSequences(1)).toEqual([6]);
  });

  test('the stream id is minted once and then reread', async () => {
    const shared = storage();
    const outbox = createTrackingOutbox(shared, { randomUUID: () => 'lineage-1' });
    expect(await outbox.streamId()).toBe('lineage-1');
    // Same storage, a second handle (another tab): the first id wins.
    const again = createTrackingOutbox(shared, { randomUUID: () => 'lineage-2' });
    expect(await again.streamId()).toBe('lineage-1');
  });

  test('the lease is exclusive, renewable by its owner and expires after leaseMs', async () => {
    let now = 1_000;
    const outbox = createTrackingOutbox(storage(), { leaseMs: 3_000, now: () => now });
    expect(await outbox.acquireLease('tab-a')).toBe(true);
    expect(await outbox.acquireLease('tab-b')).toBe(false);
    expect(await outbox.acquireLease('tab-a')).toBe(true);
    now += 2_999;
    expect(await outbox.acquireLease('tab-b')).toBe(false);
    now += 1;
    expect(await outbox.acquireLease('tab-b')).toBe(true);
  });

  test('release lets the next owner acquire immediately', async () => {
    const outbox = createTrackingOutbox(storage(), { leaseMs: 10_000, now: () => 5_000 });
    expect(await outbox.acquireLease('dying-document')).toBe(true);
    await outbox.releaseLease('dying-document');
    expect(await outbox.acquireLease('next-document')).toBe(true);
  });

  test('release by a non-owner is a no-op', async () => {
    const outbox = createTrackingOutbox(storage(), { leaseMs: 10_000, now: () => 5_000 });
    await outbox.acquireLease('tab-a');
    await outbox.releaseLease('tab-b');
    expect(await outbox.acquireLease('tab-b')).toBe(false);
  });

  test('a batch is read in sequence order and acknowledged by id', async () => {
    const outbox = createTrackingOutbox(storage());
    await outbox.enqueue(event(3));
    await outbox.enqueue(event(1));
    await outbox.enqueue(event(2));
    expect((await outbox.readBatch(2)).map((e) => e.browserSequence)).toEqual([1, 2]);
    await outbox.acknowledge(['e1', 'e3']);
    expect((await outbox.readBatch()).map((e) => e.browserSequence)).toEqual([2]);
    await outbox.acknowledge([]);
    expect((await outbox.readBatch()).length).toBe(1);
  });

  test('trim drops the oldest beyond maxEvents and anything older than maxAgeMs, and counts both', async () => {
    let now = 0;
    const outbox = createTrackingOutbox(storage(), {
      maxEvents: 3,
      maxAgeMs: 100,
      now: () => now,
    });
    for (let i = 1; i <= 4; i += 1) {
      now = i * 10;
      await outbox.enqueue(event(i));
    }
    expect((await outbox.readBatch()).map((e) => e.browserSequence)).toEqual([2, 3, 4]);
    now = 200;
    await outbox.enqueue(event(5));
    expect((await outbox.readBatch()).map((e) => e.browserSequence)).toEqual([5]);
    expect(await outbox.health()).toEqual({ state: 'available', queued: 1, dropped: 4 });
  });

  test('a transaction that throws leaves nothing behind', async () => {
    const shared = storage();
    const outbox = createTrackingOutbox(shared);
    await expect(
      shared.transact(async ({ events }) => {
        events.put({ event: event(9), enqueuedAt: 1 });
        throw new Error('half-way');
      }),
    ).rejects.toThrow('half-way');
    expect(await outbox.readBatch()).toEqual([]);
  });

  test('health reports unavailable when storage throws', async () => {
    const broken: TrackingOutboxStorage<Event> = {
      transact: () => Promise.reject(new Error('no storage')),
    };
    expect(await createTrackingOutbox(broken).health()).toEqual({
      state: 'unavailable',
      queued: 0,
      dropped: 0,
    });
  });
});

describe('outbox over indexeddb, request-level failures', () => {
  test('a request-level failure rejects with an error, not null', async () => {
    const factory = new IDBFactory();
    const shared = indexedDbOutboxStorage<Event>('outbox-request-failure', () => factory);
    await shared.transact(async ({ events }) => {
      events.put({ event: event(1), enqueuedAt: 1 });
    });
    // The unique `sequence` index refuses the second put; the failure lives on
    // the request and reaches the transaction before `transaction.error` is set.
    const failed = shared.transact(async ({ events }) => {
      events.put({ event: { eventId: 'dup', browserSequence: 1 }, enqueuedAt: 2 });
    });
    const error: unknown = await failed.then(
      () => null,
      (reason: unknown) => reason,
    );
    const name =
      typeof error === 'object' && error !== null && 'name' in error ? error.name : error;
    expect(name).toBe('ConstraintError');
  });
});
