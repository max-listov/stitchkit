/**
 * A keyspace: authoritative memory in front of a durable backend.
 *
 * The shape an application writes by hand the second time it needs a cache it
 * can trust — declared once with a schema and a key, read synchronously from
 * memory, written through one serialised chain to a backend, and announced only
 * after the backend said yes. Written twice in one process it is two subtly
 * different orderings; written a third time it is a defect nobody can see,
 * because a cache that is *usually* right looks exactly like one that is right.
 *
 * ## The order, and why it is that order
 *
 * `put` reaches the backend first and memory second. That costs a round trip on
 * every write and buys the one property that makes the memory authoritative: a
 * reader can never observe a value that did not survive. The reverse order —
 * memory first, backend after — makes writes feel instant and makes every
 * rejected write a lie already read by somebody.
 *
 * The change event is last, after memory. A subscriber woken by it and reading
 * immediately must find the new value, and an event emitted before the memory
 * update is a wake-up to the old one.
 *
 * ## What "durable" means here, exactly
 *
 * It means *the backend's `put` resolved*. It does not mean `fsync`, and this
 * boundary cannot make it mean that: with SQLite in WAL mode and
 * `synchronous = NORMAL` a successful write has not necessarily reached the
 * disk. What the backend's acknowledgement is worth is the backend's to state —
 * and the owner's to configure. Saying "durable" without saying whose durability
 * would be the more comfortable lie.
 *
 * ## Two ways in, because there are two lifecycles
 *
 * {@link keyspaceResource} declares it to the application kernel, which is right
 * whenever there is a kernel: it closes after everything that writes to it,
 * because a writer that depends on it is stopped first.
 *
 * {@link openKeyspace} opens one directly, for an application that owns its own
 * lifecycle — a server that binds its signals and closes what it holds in an
 * order it wrote itself. The resource is a thin wrapper over exactly this, not a
 * second implementation: without it the only way to open a keyspace would be to
 * have a kernel, which is a requirement nothing about a keyspace justifies.
 *
 * ## It is a resource, not a global
 *
 * A keyspace is opened as a {@link ManagedResource} and its handle is read with
 * `context.use(...)`. That is not ceremony: the application kernel resolves its
 * resource graph in the constructor and has no way to register one later, so a
 * keyspace opened by a bare function call inside another resource's `start`
 * would never be drained, closed, or ordered against its writers. Declared as a
 * resource it closes after everything that writes to it, because a writer that
 * depends on it is stopped first.
 *
 * → ADR 0152.
 */
import type { z } from 'zod';
import type { ManagedResource, ManagedResourceContext } from './resource';

export interface KeyspaceDeclaration<TValue> {
  readonly name: string;
  readonly schema: z.ZodType<TValue>;
  /** The key of a value. Must be pure and stable — it is the identity of a record. */
  readonly key: (value: TValue) => string;
}

/**
 * Where a keyspace's records survive a restart.
 *
 * Deliberately not a SQL boundary. A keyspace needs durability and nothing else,
 * and typing it against statements would make SQLite the only backend anyone
 * could actually write — everyone else would be forging a `prepare()`. Four
 * methods, all of them things a file, a table, a bucket or a remote store can
 * answer.
 */
export interface KeyspaceBackend {
  /** Every stored record. Called once, at start. */
  load(): Promise<readonly unknown[]>;
  /** Store one record under its key. Resolving means stored. */
  put(key: string, value: unknown): Promise<void>;
  /** Remove one key. Removing a key that is not there is not an error. */
  delete(key: string): Promise<void>;
  /** Release whatever the backend owns. The keyspace calls it once, on close. */
  close?(): Promise<void>;
}

export interface OpenKeyspace<TValue> {
  /** From memory, synchronously. Never a promise, never a read-through. */
  get(key: string): TValue | undefined;
  /** Every record, from memory, in insertion order. */
  list(): readonly TValue[];
  readonly size: number;
  /**
   * Store a record: backend first, then memory, then the change event.
   *
   * Rejects with the backend's own error when the backend refuses — and memory
   * is unchanged, so a caller that ignores the rejection reads the previous
   * value rather than one that was never stored.
   */
  put(value: TValue): Promise<void>;
  delete(key: string): Promise<void>;
  /** Writes accepted and not yet durable. A number, so shutdown can report it. */
  pendingWrites(): number;
}

export interface KeyspaceChange<TValue> {
  readonly keyspace: string;
  readonly key: string;
  /** Absent on a delete. */
  readonly value?: TValue;
  readonly change: 'put' | 'delete';
}

export interface KeyspaceResourceConfig<TValue> {
  readonly backend: KeyspaceBackend;
  /**
   * Called after a change is durable **and** visible in memory.
   *
   * Wire it to `createEventBus(...).emit` on a topic declared with
   * `defineEvents`, and a watched read invalidates on it. Kept a callback rather
   * than a bus dependency so a keyspace is usable without one.
   */
  readonly onChanged?: (change: KeyspaceChange<TValue>) => void;
  /**
   * The most writes that may be waiting for the backend at once.
   *
   * Reached, `put` rejects instead of queueing: an unbounded write queue turns a
   * slow backend into memory exhaustion, and the caller finds out only when the
   * process dies. Default 1024.
   */
  readonly maxPendingWrites?: number;
  /**
   * Called when the keyspace closes with writes still queued, with how many.
   *
   * Shutdown is deadline-bounded and a forced close can cut a drain short. The
   * number is the honest report; silence here would be a keyspace that lost
   * records and said nothing.
   */
  readonly onUnwritten?: (count: number) => void;
  /** Resource id. Defaults to `keyspace:<name>`. */
  readonly id?: string;
  readonly dependsOn?: ManagedResource['dependsOn'];
}

export function defineKeyspace<TValue>(
  name: string,
  declaration: { schema: z.ZodType<TValue>; key: (value: TValue) => string },
): KeyspaceDeclaration<TValue> {
  if (name.trim() === '') {
    throw new Error('[stitchkit] defineKeyspace: a keyspace needs a name.');
  }
  return { name, schema: declaration.schema, key: declaration.key };
}

/**
 * An opened keyspace, plus the lifecycle its owner drives.
 *
 * The same four phases a {@link ManagedResource} has, because they are the same
 * four phases — an application without a kernel calls them in the order it
 * chose, and one with a kernel gets them called for it.
 */
export interface OpenedKeyspace<TValue> {
  readonly keyspace: OpenKeyspace<TValue>;
  /** Refuse new writes. The queued ones still finish. */
  stopAdmission(): void;
  /** Wait for every accepted write to reach the backend. */
  drain(): Promise<void>;
  /** Report anything still unwritten, then close the backend. */
  close(): Promise<void>;
}

/**
 * Open a keyspace directly, for an application that owns its own lifecycle.
 *
 * Loads every stored record before it returns, so `get` and `list` are
 * answerable from the first call. Where there is a kernel, prefer
 * {@link keyspaceResource} — it gets the ordering right without anyone
 * remembering to.
 */
export async function openKeyspace<TValue>(
  declaration: KeyspaceDeclaration<TValue>,
  config: KeyspaceResourceConfig<TValue>,
): Promise<OpenedKeyspace<TValue>> {
  const machine = keyspaceMachine(declaration, config);
  await machine.load();
  return {
    keyspace: machine.keyspace,
    stopAdmission: machine.stopAdmission,
    drain: machine.drain,
    close: machine.close,
  };
}

/**
 * A keyspace as a managed resource. Its `start` publishes the {@link OpenKeyspace}.
 */
export function keyspaceResource<TValue>(
  declaration: KeyspaceDeclaration<TValue>,
  config: KeyspaceResourceConfig<TValue>,
): ManagedResource {
  const machine = keyspaceMachine(declaration, config);
  return {
    id: config.id ?? `keyspace:${declaration.name}`,
    ...(config.dependsOn && { dependsOn: config.dependsOn }),
    async start(_context: ManagedResourceContext) {
      await machine.load();
      return { value: machine.keyspace };
    },
    stopAdmission: machine.stopAdmission,
    drain: machine.drain,
    close: machine.close,
    force: machine.force,
  };
}

/** The one implementation both entry points drive. */
function keyspaceMachine<TValue>(
  declaration: KeyspaceDeclaration<TValue>,
  config: KeyspaceResourceConfig<TValue>,
) {
  const maxPending = config.maxPendingWrites ?? 1024;
  const records = new Map<string, TValue>();
  let admitting = true;
  let pending = 0;
  // One chain per keyspace: two writes to one key must reach the backend in the
  // order they were accepted, and the change events must follow that same order.
  let chain: Promise<void> = Promise.resolve();

  function run(work: () => Promise<void>): Promise<void> {
    if (!admitting) {
      return Promise.reject(
        new Error(
          `[stitchkit] keyspace "${declaration.name}" is shutting down and is not accepting writes.`,
        ),
      );
    }
    if (pending >= maxPending) {
      return Promise.reject(
        new Error(
          `[stitchkit] keyspace "${declaration.name}": ${pending} writes are already waiting for the backend (limit ${maxPending}). The backend is not keeping up; queueing this one would trade a visible refusal for an invisible leak.`,
        ),
      );
    }
    pending += 1;
    const queued = chain.then(work, work);
    // The chain must survive a rejected write: the next write still has to run.
    chain = queued.then(
      () => undefined,
      () => undefined,
    );
    return queued.finally(() => {
      pending -= 1;
    });
  }

  const keyspace: OpenKeyspace<TValue> = {
    get: (key) => records.get(key),
    list: () => [...records.values()],
    get size() {
      return records.size;
    },
    put(value) {
      // Parsed before anything else: a record that does not satisfy its own
      // declaration must not reach the backend, and finding that out at load
      // time on the next restart is finding out far too late.
      const parsed = declaration.schema.parse(value);
      const key = declaration.key(parsed);
      return run(async () => {
        await config.backend.put(key, parsed);
        records.set(key, parsed);
        config.onChanged?.({
          keyspace: declaration.name,
          key,
          value: parsed,
          change: 'put',
        });
      });
    },
    delete(key) {
      return run(async () => {
        await config.backend.delete(key);
        records.delete(key);
        config.onChanged?.({ keyspace: declaration.name, key, change: 'delete' });
      });
    },
    pendingWrites: () => pending,
  };

  function reportUnwritten(): void {
    if (pending > 0) config.onUnwritten?.(pending);
  }

  return {
    keyspace,
    async load() {
      for (const stored of await config.backend.load()) {
        // A stored record that no longer satisfies the schema is a real event —
        // a shape changed under a live store — and it stops the start rather
        // than being skipped. A keyspace silently missing records is the failure
        // mode a cache cannot recover from, because nothing downstream can tell
        // "absent" from "never written".
        const value = declaration.schema.parse(stored);
        records.set(declaration.key(value), value);
      }
    },
    stopAdmission() {
      admitting = false;
    },
    async drain() {
      await chain;
    },
    async close() {
      reportUnwritten();
      await config.backend.close?.();
    },
    force() {
      reportUnwritten();
    },
  };
}

/**
 * A backend that keeps records in this process only.
 *
 * For tests and for a keyspace whose contents are genuinely disposable. It is
 * the honest version of "no backend yet": everything a durable backend does,
 * except survive.
 */
export function memoryKeyspaceBackend(): KeyspaceBackend {
  const stored = new Map<string, unknown>();
  return {
    load: async () => [...stored.values()],
    put: async (key, value) => {
      stored.set(key, value);
    },
    delete: async (key) => {
      stored.delete(key);
    },
  };
}
