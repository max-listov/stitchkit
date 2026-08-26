import { describe, expect, test } from 'bun:test';
import { createApplication } from '../src/application/kernel';
import { defineManagedResource } from '../src/application/resource';

interface Connection {
  readonly dsn: string;
  query(sql: string): number;
}

function connection(dsn: string): Connection {
  return { dsn, query: (sql) => sql.length };
}

describe('a resource hands its handle to its dependants', () => {
  test('the dependant reads the very object start published, with its type', async () => {
    const database = defineManagedResource({
      id: 'database',
      start: async () => {
        await Promise.resolve();
        return { value: connection('postgres://test') };
      },
    });
    let seen: Connection | undefined;
    let rows = 0;
    const app = createApplication({
      id: 'values',
      resources: [
        database,
        defineManagedResource({
          id: 'worker',
          dependsOn: [database],
          start: (context) => {
            // No `let handle: T | null`, no guard the graph makes unreachable:
            // the type here is Connection, not Connection | null.
            const db = context.use(database);
            seen = db;
            rows = db.query('select 1');
          },
        }),
      ],
    });
    await app.start();
    expect(seen?.dsn).toBe('postgres://test');
    expect(rows).toBe(8);
    await app.shutdown();
  });

  test('a value read without declaring the dependency is refused, naming both', async () => {
    const database = defineManagedResource({
      id: 'database',
      start: () => ({ value: connection('postgres://test') }),
    });
    const app = createApplication({
      id: 'undeclared',
      resources: [
        database,
        defineManagedResource({
          id: 'worker',
          start: (context) => {
            context.use(database);
          },
        }),
      ],
    });
    // Undeclared happens to work whenever declaration order is lucky, which is
    // exactly why it has to be refused rather than tolerated.
    await expect(app.start()).rejects.toThrow(
      'resource "worker" used "database" without declaring it in dependsOn',
    );
  });

  test('a dependency that published nothing is refused', async () => {
    const clock = defineManagedResource({ id: 'clock', start: () => undefined });
    const app = createApplication({
      id: 'no-value',
      resources: [
        clock,
        defineManagedResource({
          id: 'worker',
          dependsOn: [clock],
          start: (context) => {
            // @ts-expect-error a resource that publishes nothing has nothing to read
            const value: string = context.use(clock);
            void value;
          },
        }),
      ],
    });
    await expect(app.start()).rejects.toThrow(
      'resource "worker" used "clock", which published no value from start()',
    );
  });

  test('the value is still readable from activate and from the shutdown phases', async () => {
    const database = defineManagedResource({
      id: 'database',
      start: () => ({ value: connection('postgres://test') }),
    });
    const seen: string[] = [];
    const app = createApplication({
      id: 'phases',
      resources: [
        database,
        defineManagedResource({
          id: 'worker',
          dependsOn: [database],
          start: (context) => {
            seen.push(`start:${context.use(database).dsn}`);
          },
          activate: (context) => {
            seen.push(`activate:${context.use(database).dsn}`);
          },
          close: (context) => {
            // A dependant may still need the handle it was given while it
            // drains. Dropping the value at the end of startup would make
            // `use()` work in `start` and fail in `close`.
            seen.push(`close:${context.use(database).dsn}`);
          },
        }),
      ],
    });
    await app.start();
    await app.shutdown();
    expect(seen).toEqual([
      'start:postgres://test',
      'activate:postgres://test',
      'close:postgres://test',
    ]);
  });

  test('a dependency declared by reference orders exactly like one declared by name', async () => {
    const order: string[] = [];
    const first = defineManagedResource({
      id: 'first',
      start: () => {
        order.push('first');
      },
    });
    const byReference = defineManagedResource({
      id: 'by-reference',
      dependsOn: [first],
      start: () => {
        order.push('by-reference');
      },
    });
    const byName = defineManagedResource({
      id: 'by-name',
      dependsOn: ['by-reference'],
      start: () => {
        order.push('by-name');
      },
    });
    const app = createApplication({
      id: 'mixed-declarations',
      // Declared out of order on purpose: the order below is not the answer.
      resources: [byName, byReference, first],
    });
    await app.start();
    expect(order).toEqual(['first', 'by-reference', 'by-name']);
    await app.shutdown();
  });

  test('a missing dependency declared by reference is still caught before any side effect', () => {
    const absent = defineManagedResource({ id: 'absent', start: () => undefined });
    let starts = 0;
    expect(() =>
      createApplication({
        id: 'missing-reference',
        resources: [
          defineManagedResource({
            id: 'worker',
            dependsOn: [absent],
            start: () => {
              starts += 1;
            },
          }),
        ],
      }),
    ).toThrow('depends on missing resource "absent"');
    expect(starts).toBe(0);
  });

  test('publishing undefined is publishing nothing', async () => {
    const maybe = defineManagedResource({
      id: 'maybe',
      start: () => ({ value: undefined }),
    });
    const app = createApplication({
      id: 'undefined-value',
      resources: [
        maybe,
        defineManagedResource({
          id: 'worker',
          dependsOn: [maybe],
          start: (context) => {
            context.use(maybe);
          },
        }),
      ],
    });
    await expect(app.start()).rejects.toThrow('which published no value from start()');
  });
});
