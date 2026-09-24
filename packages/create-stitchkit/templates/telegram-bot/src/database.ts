import { Database } from 'bun:sqlite';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { defineManagedResource } from 'stitchkit/application';

/** What the bot stores. Replace it with the product's own tables. */
export interface Store {
  /** Remember a user; `true` the first time this user is seen. */
  rememberUser(user: { id: number; firstName: string }): boolean;
  userCount(): number;
}

function openStore(path: string): { store: Store; close(): void } {
  if (path !== ':memory:') mkdirSync(dirname(path), { recursive: true });
  const db = new Database(path, { create: true, strict: true });
  db.run('PRAGMA journal_mode = WAL');
  db.run(`CREATE TABLE IF NOT EXISTS users (
    id INTEGER PRIMARY KEY,
    first_name TEXT NOT NULL,
    first_seen_at TEXT NOT NULL
  )`);
  const insert = db.query(
    'INSERT OR IGNORE INTO users (id, first_name, first_seen_at) VALUES ($id, $firstName, $at)',
  );
  const count = db.query<{ count: number }, []>('SELECT count(*) AS count FROM users');
  return {
    store: {
      rememberUser: (user) =>
        insert.run({ id: user.id, firstName: user.firstName, at: new Date().toISOString() })
          .changes > 0,
      userCount: () => count.get()?.count ?? 0,
    },
    close: () => db.close(),
  };
}

/**
 * The database as the first resource of the graph. Handlers are registered
 * before it opens, so they reach the store through `store()`, which the graph
 * guarantees is open by the time an update is admitted.
 */
export function createDatabase(path: string) {
  let opened: ReturnType<typeof openStore> | undefined;
  const resource = defineManagedResource({
    id: 'database',
    start() {
      opened = openStore(path);
    },
    close() {
      opened?.close();
      opened = undefined;
    },
  });
  return {
    resource,
    store(): Store {
      if (!opened) throw new Error('The database is not open');
      return opened.store;
    },
  };
}
