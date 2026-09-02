/**
 * A keyspace: memory that is authoritative because nothing reaches it before it
 * is durable.
 *
 * Every claim here is written so that the opposite ordering fails it. "Event
 * after durability" is only worth asserting against a backend that has *not*
 * acknowledged yet — against an instant one, the wrong order and the right one
 * produce identical output.
 */
import { Database } from 'bun:sqlite';
import { describe, expect, test } from 'bun:test';
import { z } from 'zod';
import {
  defineKeyspace,
  type KeyspaceBackend,
  type KeyspaceChange,
  keyspaceResource,
  memoryKeyspaceBackend,
  type OpenKeyspace,
  openKeyspace,
} from '../src/application/keyspace';
import { sqliteKeyspaceBackend } from '../src/application/keyspace-sqlite';
import type { ManagedResource, ManagedResourceContext } from '../src/application/resource';

const NoteSchema = z.object({ id: z.string(), body: z.string() });
type Note = z.infer<typeof NoteSchema>;

const notes = defineKeyspace('notes', {
  schema: NoteSchema,
  key: (note: Note) => note.id,
});

/** Start a resource outside the kernel — the graph is not what is under test here. */
async function open(resource: ManagedResource): Promise<OpenKeyspace<Note>> {
  const started = await resource.start({} as ManagedResourceContext);
  const value = started && 'value' in started ? started.value : undefined;
  if (!value) throw new Error('the keyspace published no handle');
  return value as OpenKeyspace<Note>;
}

/** A backend whose writes settle when the test says so. */
function heldBackend() {
  const gates: { resolve: () => void; reject: (error: unknown) => void }[] = [];
  const writes: string[] = [];
  const backend: KeyspaceBackend = {
    load: async () => [],
    put: async (key) => {
      writes.push(key);
      const { promise, resolve, reject } = Promise.withResolvers<void>();
      gates.push({ resolve, reject });
      await promise;
    },
    delete: async () => undefined,
  };
  /** Wait for the nth write to reach the backend, then hand back its gate. */
  async function gate(n: number) {
    for (let attempt = 0; attempt < 200 && gates.length <= n; attempt += 1) {
      await Bun.sleep(1);
    }
    const found = gates[n];
    if (!found) throw new Error(`write ${n} never reached the backend`);
    return found;
  }
  return { backend, gates, writes, gate };
}

describe('the change is announced after it is durable, never before', () => {
  test('a write that has not been acknowledged is neither visible nor announced', async () => {
    const changes: KeyspaceChange<Note>[] = [];
    const { backend, gate } = heldBackend();
    const keyspace = await open(
      keyspaceResource(notes, { backend, onChanged: (c) => changes.push(c) }),
    );

    const pending = keyspace.put({ id: 'a', body: 'first' });
    await Bun.sleep(5);
    // The backend has been asked and has not answered. Nothing may have moved.
    expect(changes).toEqual([]);
    expect(keyspace.get('a')).toBeUndefined();
    expect(keyspace.pendingWrites()).toBe(1);

    (await gate(0)).resolve();
    await pending;
    expect(keyspace.get('a')).toEqual({ id: 'a', body: 'first' });
    expect(changes).toEqual([
      { keyspace: 'notes', key: 'a', value: { id: 'a', body: 'first' }, change: 'put' },
    ]);
    expect(keyspace.pendingWrites()).toBe(0);
  });

  test('a write the backend refuses changes nothing and returns the reason', async () => {
    // The negative control: an implementation that announced before writing
    // would pass the test above only by luck and fails this one outright.
    const changes: KeyspaceChange<Note>[] = [];
    const keyspace = await open(
      keyspaceResource(notes, {
        backend: {
          load: async () => [],
          put: async () => {
            throw new Error('disk is full');
          },
          delete: async () => undefined,
        },
        onChanged: (c) => changes.push(c),
      }),
    );

    await expect(keyspace.put({ id: 'a', body: 'first' })).rejects.toThrow('disk is full');
    expect(keyspace.get('a')).toBeUndefined();
    expect(changes).toEqual([]);
  });

  test('a read during a write sees the previous consistent value', async () => {
    const { backend, gate } = heldBackend();
    const keyspace = await open(keyspaceResource(notes, { backend }));

    const first = keyspace.put({ id: 'a', body: 'one' });
    (await gate(0)).resolve();
    await first;

    const second = keyspace.put({ id: 'a', body: 'two' });
    await Bun.sleep(5);
    expect(keyspace.get('a')).toEqual({ id: 'a', body: 'one' });
    (await gate(1)).resolve();
    await second;
    expect(keyspace.get('a')).toEqual({ id: 'a', body: 'two' });
  });
});

describe('writes are one chain', () => {
  test('two writes to one key reach the backend in the order they were accepted', async () => {
    const { backend, gate, writes } = heldBackend();
    const keyspace = await open(keyspaceResource(notes, { backend }));

    const first = keyspace.put({ id: 'a', body: 'one' });
    const second = keyspace.put({ id: 'b', body: 'two' });
    await Bun.sleep(5);
    // The second has not even been offered to the backend yet: one chain.
    expect(writes).toEqual(['a']);
    (await gate(0)).resolve();
    await first;
    await Bun.sleep(5);
    expect(writes).toEqual(['a', 'b']);
    (await gate(1)).resolve();
    await second;
  });

  test('a rejected write does not break the chain for the next one', async () => {
    let attempt = 0;
    const keyspace = await open(
      keyspaceResource(notes, {
        backend: {
          load: async () => [],
          put: async () => {
            attempt += 1;
            if (attempt === 1) throw new Error('transient');
          },
          delete: async () => undefined,
        },
      }),
    );
    await expect(keyspace.put({ id: 'a', body: 'one' })).rejects.toThrow('transient');
    await keyspace.put({ id: 'b', body: 'two' });
    expect(keyspace.get('b')).toEqual({ id: 'b', body: 'two' });
  });

  test('the queue is bounded, and the refusal says so rather than growing', async () => {
    const { backend, gate } = heldBackend();
    const keyspace = await open(keyspaceResource(notes, { backend, maxPendingWrites: 2 }));
    const first = keyspace.put({ id: 'a', body: '1' });
    const second = keyspace.put({ id: 'b', body: '2' });
    // Asserted against a deadline rather than with `.rejects`: without the
    // bound the third write does not reject, it *queues*, and a bare
    // `.rejects` would hang forever instead of failing. A hang and a slow pass
    // are the same observation, which is no observation at all.
    const third = keyspace.put({ id: 'c', body: '3' });
    const outcome = await Promise.race([
      third.then(
        () => 'accepted' as const,
        (error: unknown) =>
          /2 writes are already waiting/.test(String(error))
            ? ('refused' as const)
            : ('failed for another reason' as const),
      ),
      Bun.sleep(100).then(() => 'still queued' as const),
    ]);
    expect(outcome).toBe('refused');
    (await gate(0)).resolve();
    await first;
    (await gate(1)).resolve();
    await second;
  });
});

describe('shutdown says what it lost', () => {
  test('stopAdmission refuses new writes and drain waits for the accepted ones', async () => {
    const { backend, gate } = heldBackend();
    const resource = keyspaceResource(notes, { backend });
    const keyspace = await open(resource);

    const accepted = keyspace.put({ id: 'a', body: 'one' });
    await resource.stopAdmission?.({} as ManagedResourceContext);
    await expect(keyspace.put({ id: 'b', body: 'two' })).rejects.toThrow(
      /not accepting writes/,
    );

    (await gate(0)).resolve();
    await resource.drain?.({} as ManagedResourceContext);
    await accepted;
    expect(keyspace.get('a')).toEqual({ id: 'a', body: 'one' });
  });

  test('closing with writes still queued reports how many, as a number', async () => {
    // Shutdown is deadline-bounded and a forced close can cut a drain short.
    // Silence here would be a keyspace that lost records and said nothing.
    const unwritten: number[] = [];
    const { backend } = heldBackend();
    const resource = keyspaceResource(notes, {
      backend,
      onUnwritten: (n) => unwritten.push(n),
    });
    const keyspace = await open(resource);
    void keyspace.put({ id: 'a', body: 'one' });
    void keyspace.put({ id: 'b', body: 'two' });
    await Bun.sleep(5);
    await resource.close?.({} as ManagedResourceContext);
    expect(unwritten).toEqual([2]);
  });

  test('the backend is closed exactly once, by the keyspace that owns it', async () => {
    let closed = 0;
    const resource = keyspaceResource(notes, {
      backend: {
        ...memoryKeyspaceBackend(),
        close: async () => {
          closed += 1;
        },
      },
    });
    await open(resource);
    await resource.close?.({} as ManagedResourceContext);
    expect(closed).toBe(1);
  });
});

describe('what is loaded has to satisfy the declaration', () => {
  test('a stored record that no longer parses stops the start rather than vanishing', async () => {
    // The alternative — skip it and carry on — makes "absent" and "never
    // written" the same observation for everything downstream.
    const resource = keyspaceResource(notes, {
      backend: {
        load: async () => [{ id: 'a', body: 'fine' }, { id: 'b' }],
        put: async () => undefined,
        delete: async () => undefined,
      },
    });
    await expect(open(resource)).rejects.toThrow();
  });

  test('a value that does not satisfy the schema never reaches the backend', async () => {
    const writes: string[] = [];
    const keyspace = await open(
      keyspaceResource(notes, {
        backend: {
          load: async () => [],
          put: async (key) => {
            writes.push(key);
          },
          delete: async () => undefined,
        },
      }),
    );
    // @ts-expect-error — the runtime refusal is the point; the type refuses it too
    expect(() => keyspace.put({ id: 'a' })).toThrow();
    expect(writes).toEqual([]);
  });
});

describe('the resource it declares itself as', () => {
  test('the id defaults to the keyspace name and can be given explicitly', () => {
    expect(keyspaceResource(notes, { backend: memoryKeyspaceBackend() }).id).toBe(
      'keyspace:notes',
    );
    expect(
      keyspaceResource(notes, { backend: memoryKeyspaceBackend(), id: 'notes-store' }).id,
    ).toBe('notes-store');
  });

  test('a declared dependency reaches the resource, so the graph can order it', () => {
    // Without this the keyspace would close in an arbitrary position relative to
    // the things that write to it — which is the whole reason it is a resource.
    const resource = keyspaceResource(notes, {
      backend: memoryKeyspaceBackend(),
      dependsOn: ['database'],
    });
    expect(resource.dependsOn).toEqual(['database']);
  });
});

describe('opened directly, by an application that owns its lifecycle', () => {
  test('openKeyspace loads the store and hands back the same four phases', async () => {
    // The kernel is not the only legitimate owner. A server that binds its own
    // signals and closes what it holds in an order it wrote has no context to
    // hand a resource, and should not have to invent one.
    const database = new Database(':memory:');
    const seed = await openKeyspace(notes, {
      backend: sqliteKeyspaceBackend(notes, { database }),
    });
    await seed.keyspace.put({ id: 'a', body: 'written before the restart' });
    await seed.close();

    const opened = await openKeyspace(notes, {
      backend: sqliteKeyspaceBackend(notes, { database }),
    });
    // Loaded before it returned: the first read answers without awaiting.
    expect(opened.keyspace.get('a')).toEqual({ id: 'a', body: 'written before the restart' });

    opened.stopAdmission();
    await expect(opened.keyspace.put({ id: 'b', body: 'after' })).rejects.toThrow(
      /not accepting writes/,
    );
    await opened.drain();
    await opened.close();
  });

  test('an unwritten record is reported to the owner, not swallowed', async () => {
    const unwritten: number[] = [];
    const opened = await openKeyspace(notes, {
      backend: {
        load: async () => [],
        put: () => new Promise<void>(() => undefined),
        delete: async () => undefined,
      },
      onUnwritten: (count) => unwritten.push(count),
    });
    void opened.keyspace.put({ id: 'a', body: 'never lands' });
    await Bun.sleep(5);
    await opened.close();
    expect(unwritten).toEqual([1]);
  });
});

describe('the sqlite backend', () => {
  test('a record survives a restart of the keyspace over the same table', async () => {
    const database = new Database(':memory:');
    const first = await open(
      keyspaceResource(notes, { backend: sqliteKeyspaceBackend(notes, { database }) }),
    );
    await first.put({ id: 'a', body: 'stored' });

    const second = await open(
      keyspaceResource(notes, { backend: sqliteKeyspaceBackend(notes, { database }) }),
    );
    expect(second.get('a')).toEqual({ id: 'a', body: 'stored' });
    expect(second.list()).toHaveLength(1);
  });

  test('a delete removes the row, not just the memory', async () => {
    const database = new Database(':memory:');
    const backend = sqliteKeyspaceBackend(notes, { database });
    const first = await open(keyspaceResource(notes, { backend }));
    await first.put({ id: 'a', body: 'stored' });
    await first.delete('a');
    const second = await open(
      keyspaceResource(notes, { backend: sqliteKeyspaceBackend(notes, { database }) }),
    );
    expect(second.get('a')).toBeUndefined();
  });

  test('a table name that is not a bare identifier stops startup', () => {
    const database = new Database(':memory:');
    expect(() =>
      sqliteKeyspaceBackend(notes, { database, table: 'notes; DROP TABLE users' }),
    ).toThrow(/not a bare SQL identifier/);
  });

  test('initialize false leaves the schema to whoever owns the migrations', () => {
    // Not a nicety: where migrations are owned elsewhere, a backend that
    // creates the table on the side hides that owner's failure to run.
    const database = new Database(':memory:');
    const backend = sqliteKeyspaceBackend(notes, { database, initialize: false });
    expect(backend.load()).rejects.toThrow(/no such table/);
  });

  test('the caller keeps its database handle open', async () => {
    // The handle may back several keyspaces and the agent store besides. A
    // backend that closed it would take the rest of the process with it.
    const database = new Database(':memory:');
    const resource = keyspaceResource(notes, {
      backend: sqliteKeyspaceBackend(notes, { database }),
    });
    await open(resource);
    await resource.close?.({} as ManagedResourceContext);
    expect(() => database.prepare('SELECT 1').get()).not.toThrow();
  });
});
