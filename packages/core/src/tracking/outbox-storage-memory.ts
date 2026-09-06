import type {
  TrackingOutboxRecord,
  TrackingOutboxStorage,
  TrackingQueuedEvent,
} from './outbox';

/**
 * The outbox over two maps. Transactions are serialised through one promise
 * chain and are all-or-nothing: `fn` works on copies that replace the store
 * only when it returns, so two concurrent `reserveSequences` see each other
 * exactly as they would through IndexedDB, and one that throws leaves
 * nothing behind. For tests, and for a browser whose IndexedDB is
 * unavailable — then it is one tab's private queue, which is what the
 * `unavailable` health state tells the server.
 */
export function memoryOutboxStorage<
  TEvent extends TrackingQueuedEvent = TrackingQueuedEvent,
>(): TrackingOutboxStorage<TEvent> {
  let meta = new Map<string, unknown>();
  let events = new Map<string, TrackingOutboxRecord<TEvent>>();
  let chain: Promise<unknown> = Promise.resolve();
  return {
    transact(fn) {
      const run = chain.then(async () => {
        const nextMeta = new Map(meta);
        const nextEvents = new Map(events);
        const result = await fn({
          meta: {
            get: async (key) => nextMeta.get(key),
            put: (key, value) => void nextMeta.set(key, value),
            delete: (key) => void nextMeta.delete(key),
          },
          events: {
            put: (record) => void nextEvents.set(record.event.eventId, record),
            delete: (eventId) => void nextEvents.delete(eventId),
            all: async () =>
              [...nextEvents.values()].sort(
                (a, b) => a.event.browserSequence - b.event.browserSequence,
              ),
            count: async () => nextEvents.size,
          },
        });
        meta = nextMeta;
        events = nextEvents;
        return result;
      });
      chain = run.catch(() => undefined);
      return run;
    },
  };
}
