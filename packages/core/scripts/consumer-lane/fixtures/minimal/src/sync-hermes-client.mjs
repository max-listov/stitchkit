import { defineSqliteMigrations, runSqliteMigrations } from 'stitchkit/application';
import * as sync from 'stitchkit/sync';

/** One sync step with synchronous ports, as an `expo-sqlite` host on Hermes runs it. */
export function syncStep() {
  const sent = [];
  const saved = [];
  let cursor = 5;
  let fullStarts = 0;
  const session = sync.createSyncSession({
    isConnected: () => true,
    readCursor: () => cursor,
    beginFullSync: () => {
      fullStarts++;
    },
    send: (request) => sent.push(request),
    apply: () => undefined,
    saveCursor: (version) => saved.push(version),
    log: { info: () => undefined, warn: () => undefined, error: () => undefined },
    newId: () => `id-${sent.length}-${saved.length}-${Math.random()}`,
    schedule: () => () => undefined,
  });
  session.requestSync();
  session.handleResponse({
    sessionId: sent[0].sessionId,
    requestId: sent[0].requestId,
    hasMore: false,
    latestVersion: 9,
  });
  cursor = 0;
  session.requestSync();
  session.stop();
  const batch = sync.decideOutboxBatch(
    [
      {
        id: 'a',
        entity: 'task',
        entityId: 'a',
        payloadJson: '{"text":"я"}',
        status: 'pending',
        sentAt: null,
        attempts: 0,
      },
    ],
    {
      now: 0,
      policy: {
        toChange: (row, payload) => ({ id: row.id, payload }),
        emptyEnvelopeBytes: 2,
        maxBytes: 1024,
        maxChanges: 10,
        retryAfterMs: 1000,
      },
    },
  );
  const { results } = sync.classifyChangeResults([
    { changeId: 'a', outcome: 'applied' },
    { changeId: 'b', outcome: 'from_a_newer_server' },
  ]);
  // The schema of the local database, on a synchronous handle as a phone holds one.
  const executed = [];
  const ledger = [];
  const database = {
    exec: (sql) => executed.push(sql),
    prepare: (sql) => ({
      get: () => undefined,
      all: () => (sql.startsWith('SELECT') ? ledger : []),
      run: (...row) => {
        ledger.push({ version: row[0], name: row[1], checksum: row[2] });
        return { changes: 1 };
      },
    }),
    close: () => undefined,
  };
  const run = {
    scope: 'phone',
    migrations: Object.freeze(
      defineSqliteMigrations([
        { version: 10, name: 'title', statements: ['ALTER TABLE tasks ADD title TEXT'] },
        {
          version: 2,
          name: 'tasks',
          statements: ['CREATE TABLE tasks (id TEXT PRIMARY KEY)'],
        },
      ]),
    ),
  };
  const applied = runSqliteMigrations(database, run);
  const replayed = runSqliteMigrations(database, run);
  return { sent, saved, fullStarts, batch, results, applied, replayed, executed };
}
// Metro retains a barrel's exports. Keep the entire sync surface in the compiler proof too.
globalThis.syncSurface = Object.keys(sync);
