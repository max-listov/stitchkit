import type {
  TrackingOutboxRecord,
  TrackingOutboxStorage,
  TrackingQueuedEvent,
} from './outbox';

const VERSION = 1;
const EVENTS = 'events';
const META = 'meta';

function requestResult<T>(request: IDBRequest<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}

function transactionDone(transaction: IDBTransaction): Promise<void> {
  return new Promise((resolve, reject) => {
    transaction.oncomplete = () => resolve();
    // A request failure bubbles to the transaction as an error event whose
    // target is the request; `transaction.error` is still null then, and by
    // the time the abort fires it only says "AbortError". The request's own
    // error is the one that names the cause, so it is read first — by shape,
    // because the request class in a test environment is not the global one.
    const failure = (event: Event): Error => {
      const target: unknown = event.target;
      if (
        typeof target === 'object' &&
        target !== null &&
        'error' in target &&
        target.error instanceof Error
      ) {
        return target.error;
      }
      return transaction.error ?? new Error('IndexedDB transaction aborted');
    };
    transaction.onerror = (event) => reject(failure(event));
    transaction.onabort = (event) => reject(failure(event));
  });
}

function openDatabase(name: string, factory: IDBFactory): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const request = factory.open(name, VERSION);
    request.onupgradeneeded = () => {
      const database = request.result;
      if (!database.objectStoreNames.contains(EVENTS)) {
        const events = database.createObjectStore(EVENTS, { keyPath: 'event.eventId' });
        events.createIndex('sequence', 'event.browserSequence', { unique: true });
      }
      if (!database.objectStoreNames.contains(META)) database.createObjectStore(META);
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}

/**
 * The outbox in IndexedDB — the store every tab of one origin shares, which is
 * what makes the sequence counter and the flush lease lineage-wide. Each
 * `transact` is one `readwrite` transaction over both object stores; the
 * database is opened per transaction and closed after it, so a tab holds no
 * connection open across the page's life.
 *
 * `factory` is injectable so the adapter can be exercised outside a browser.
 */
export function indexedDbOutboxStorage<
  TEvent extends TrackingQueuedEvent = TrackingQueuedEvent,
>(name: string, factory: () => IDBFactory = () => indexedDB): TrackingOutboxStorage<TEvent> {
  return {
    async transact(fn, mode = 'readwrite') {
      const database = await openDatabase(name, factory());
      try {
        const transaction = database.transaction([META, EVENTS], mode);
        const meta = transaction.objectStore(META);
        const events = transaction.objectStore(EVENTS);
        let result: Awaited<ReturnType<typeof fn>>;
        try {
          result = await fn({
            meta: {
              get: (key) => requestResult(meta.get(key)),
              put: (key, value) => void meta.put(value, key),
              delete: (key) => void meta.delete(key),
            },
            events: {
              put: (record) => void events.put(record),
              delete: (eventId) => void events.delete(eventId),
              all: async () => {
                const raw: unknown[] = await requestResult(events.index('sequence').getAll());
                // The store only ever holds what `put` wrote; a record that does
                // not look like one is skipped rather than trusted.
                return raw.flatMap((value) => (isRecord<TEvent>(value) ? [value] : []));
              },
              count: () => requestResult(events.count()),
            },
          });
        } catch (error) {
          // Closing the database would let the open transaction commit what
          // `fn` wrote before it threw. One `transact` is all-or-nothing.
          transaction.abort();
          throw error;
        }
        await transactionDone(transaction);
        return result;
      } finally {
        database.close();
      }
    },
  };
}

/**
 * The store only ever holds what `put` wrote, so this narrows on the envelope
 * fields the outbox itself reads; the application's own event fields are the
 * application's to validate. A type predicate, not a cast: an unshaped value
 * is skipped rather than trusted.
 */
function isRecord<TEvent extends TrackingQueuedEvent>(
  value: unknown,
): value is TrackingOutboxRecord<TEvent> {
  if (typeof value !== 'object' || value === null) return false;
  const event = Reflect.get(value, 'event');
  return (
    typeof Reflect.get(value, 'enqueuedAt') === 'number' &&
    typeof event === 'object' &&
    event !== null &&
    typeof Reflect.get(event, 'eventId') === 'string' &&
    typeof Reflect.get(event, 'browserSequence') === 'number'
  );
}
