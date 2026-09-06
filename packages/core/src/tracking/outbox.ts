/**
 * A bounded, tab-shared outbox for browser events.
 *
 * Every event is written here before it is sent, so a batch the network drops
 * is sent again on the next flush and a page the user leaves does not lose the
 * facts it recorded. The server's dispositions are all terminal, so an
 * acknowledged event is simply deleted — the outbox never re-sends what the
 * server has already answered.
 *
 * Two things here are the difference between an outbox that works and one
 * that quietly loses the page-leave event, and both are consumer scars:
 *
 * - **Sequences are reserved, not assigned at write time.** On `pagehide`
 *   there is no time to wait for a storage transaction, so the event's number
 *   has to exist before the event is written anywhere. `reserveSequences`
 *   hands out a block atomically; a tab spends it synchronously.
 * - **The flush lease is short and is released on `pagehide`.** A ten-second
 *   lease that a dying document did not release delayed the next document's
 *   first flush by the whole ten seconds — the time it takes a person to leave
 *   again. The lease guards against two tabs flushing at once, not against
 *   retries, which the server answers with `duplicate` anyway.
 *
 * Storage is an interface: IndexedDB in a browser, memory in a test or as the
 * degraded mode when IndexedDB is unavailable. → ADR 0166.
 */

/** The least an event needs for the outbox to order and acknowledge it. */
export interface TrackingQueuedEvent {
  eventId: string;
  browserSequence: number;
}

export interface TrackingOutboxRecord<
  TEvent extends TrackingQueuedEvent = TrackingQueuedEvent,
> {
  event: TEvent;
  enqueuedAt: number;
}

/** A key/value store inside one atomic transaction. */
export interface TrackingOutboxMeta {
  get(key: string): Promise<unknown>;
  put(key: string, value: unknown): void;
  delete(key: string): void;
}

/** The event store inside the same transaction. */
export interface TrackingOutboxEvents<
  TEvent extends TrackingQueuedEvent = TrackingQueuedEvent,
> {
  put(record: TrackingOutboxRecord<TEvent>): void;
  delete(eventId: string): void;
  /** Every record, ordered by `browserSequence`. */
  all(): Promise<TrackingOutboxRecord<TEvent>[]>;
  count(): Promise<number>;
}

/**
 * One atomic read-modify-write over both stores. Atomicity is the whole
 * contract: two tabs reserving sequences or racing for the lease must see each
 * other's writes, which is what a single IndexedDB `readwrite` transaction —
 * and the memory adapter's serialised queue — provide.
 */
export interface TrackingOutboxStorage<
  TEvent extends TrackingQueuedEvent = TrackingQueuedEvent,
> {
  transact<T>(
    fn: (tx: { meta: TrackingOutboxMeta; events: TrackingOutboxEvents<TEvent> }) => Promise<T>,
    /** `readonly` for a pure read, so one tab's reads do not queue behind another's writes. */
    mode?: 'readonly' | 'readwrite',
  ): Promise<T>;
}

export interface TrackingOutboxOptions {
  /** Records kept; the oldest beyond it are dropped and counted. Default 1000. */
  maxEvents?: number;
  /** Age beyond which a record is dropped and counted. Default 7 days. */
  maxAgeMs?: number;
  /** Flush lease duration. Default 3 s — short, because it is released on leave. */
  leaseMs?: number;
  /** Wall clock; injectable for tests. */
  now?: () => number;
  randomUUID?: () => string;
}

export interface TrackingOutboxHealth {
  state: 'available' | 'unavailable';
  queued: number;
  dropped: number;
}

export interface TrackingOutbox<TEvent extends TrackingQueuedEvent = TrackingQueuedEvent> {
  /** Browser lineage — shared by every tab, survives reload and login. */
  streamId(): Promise<string>;
  /** Atomically reserve `count` consecutive sequence numbers. */
  reserveSequences(count: number): Promise<number[]>;
  /** Write an event that already carries its identity, then trim. */
  enqueue(event: TEvent): Promise<void>;
  /** One flusher per lineage: tabs compete for a renewable lease. */
  acquireLease(owner: string): Promise<boolean>;
  /** Give the lease back on leave so the next document flushes at once. */
  releaseLease(owner: string): Promise<void>;
  /** The oldest `limit` events in sequence order. */
  readBatch(limit?: number): Promise<TEvent[]>;
  /** Delete the events the server answered — every disposition is terminal. */
  acknowledge(eventIds: readonly string[]): Promise<void>;
  /** Queue depth and drops; `unavailable` when storage throws. */
  health(): Promise<TrackingOutboxHealth>;
}

const META_STREAM = 'streamId';
const META_SEQUENCE = 'sequence';
const META_LEASE = 'lease';
const META_DROPPED = 'dropped';

function numberOr(value: unknown, fallback: number): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : fallback;
}

function leaseOf(raw: unknown): { owner: string; expiresAt: number } | null {
  if (typeof raw !== 'object' || raw === null) return null;
  const owner = Reflect.get(raw, 'owner');
  const expiresAt = Reflect.get(raw, 'expiresAt');
  return typeof owner === 'string' && typeof expiresAt === 'number'
    ? { owner, expiresAt }
    : null;
}

export function createTrackingOutbox<TEvent extends TrackingQueuedEvent>(
  storage: TrackingOutboxStorage<TEvent>,
  options: TrackingOutboxOptions = {},
): TrackingOutbox<TEvent> {
  const maxEvents = options.maxEvents ?? 1_000;
  const maxAgeMs = options.maxAgeMs ?? 7 * 24 * 60 * 60 * 1000;
  const leaseMs = options.leaseMs ?? 3_000;
  const now = options.now ?? (() => Date.now());
  const randomUUID = options.randomUUID ?? (() => crypto.randomUUID());

  const trim = () =>
    storage.transact(async ({ meta, events }) => {
      const all = await events.all();
      const cutoff = now() - maxAgeMs;
      const remove = all.filter(
        (record, index) => record.enqueuedAt < cutoff || index < all.length - maxEvents,
      );
      for (const record of remove) events.delete(record.event.eventId);
      if (remove.length > 0) {
        meta.put(META_DROPPED, numberOr(await meta.get(META_DROPPED), 0) + remove.length);
      }
    });

  return {
    streamId: () =>
      storage.transact(async ({ meta }) => {
        const existing = await meta.get(META_STREAM);
        if (typeof existing === 'string') return existing;
        const created = randomUUID();
        meta.put(META_STREAM, created);
        return created;
      }),
    reserveSequences: (count) =>
      storage.transact(async ({ meta }) => {
        const start = numberOr(await meta.get(META_SEQUENCE), 0) + 1;
        meta.put(META_SEQUENCE, start + count - 1);
        return Array.from({ length: count }, (_, index) => start + index);
      }),
    async enqueue(event) {
      await storage.transact(async ({ events }) => {
        events.put({ event, enqueuedAt: now() });
      });
      await trim();
    },
    acquireLease: (owner) =>
      storage.transact(async ({ meta }) => {
        const lease = leaseOf(await meta.get(META_LEASE));
        const at = now();
        const acquired = lease === null || lease.owner === owner || lease.expiresAt <= at;
        if (acquired) meta.put(META_LEASE, { owner, expiresAt: at + leaseMs });
        return acquired;
      }),
    releaseLease: (owner) =>
      storage.transact(async ({ meta }) => {
        const lease = leaseOf(await meta.get(META_LEASE));
        if (lease?.owner === owner) meta.delete(META_LEASE);
      }),
    readBatch: (limit = 50) =>
      storage.transact(
        async ({ events }) =>
          (await events.all()).slice(0, limit).map((record) => record.event),
        'readonly',
      ),
    acknowledge: async (eventIds) => {
      if (eventIds.length === 0) return;
      await storage.transact(async ({ events }) => {
        for (const id of eventIds) events.delete(id);
      });
    },
    async health() {
      try {
        return await storage.transact(
          async ({ meta, events }) => ({
            state: 'available' as const,
            queued: await events.count(),
            dropped: numberOr(await meta.get(META_DROPPED), 0),
          }),
          'readonly',
        );
      } catch {
        return { state: 'unavailable', queued: 0, dropped: 0 };
      }
    },
  };
}
