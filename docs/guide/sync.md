# Sync

An offline-first client writes to its own database first and reaches the server when it can.
`stitchkit/sync` is the client half of that, with no driver and no domain — it runs in a browser,
in Hermes and in Bun. `stitchkit/sync/postgres` is the server half, inside your own transaction.
What an entity contains and how two edits merge stay yours.
→ [ADR 0304](../decisions/0304-sync-is-a-client-half-a-server-half-and-the-apps-own-merge.md)

## The outbox: what leaves next

Every local change is a row in your outbox table, written in the same transaction as the change.
`decideOutboxBatch` reads a page of rows and says what to send, what to mark sent and what to
quarantine; you commit that and send the batch.

```ts
import { decideOutboxBatch } from 'stitchkit/sync';

const policy = {
  toChange: (row, payload) => {
    const parsed = Change.safeParse({ id: row.id, entity: row.entity, entityId: row.entityId, payload });
    return parsed.success ? parsed.data : undefined; // undefined → quarantined as invalid_change
  },
  emptyEnvelopeBytes: new TextEncoder().encode(JSON.stringify({ changes: [] })).byteLength,
  maxBytes: 64 * 1024,
  maxChanges: 50,
  retryAfterMs: 30_000,
  keysOf: (row) => row.keys,   // default: [entity, entityId]
  setAside: 'holds-keys',      // the default; 'releases-keys' for rows that stand alone
};

let previous;
for (const rows of readOutboxPages()) {
  previous = decideOutboxBatch(rows, { now: Date.now(), policy, previous });
  if (previous.full) break;
}
```

The rules: FIFO across pages (`previous` carries the decision over). A row depends on keys —
by default one, its entity — and is ripe when no earlier unresolved row shares one of them: a page
made in a new folder waits for the folder, a move waits for both the folder it leaves and the one it
enters, and rows that share nothing go side by side. A row that waits holds all its keys, so nothing
behind it overtakes it. A row with no keys depends on nothing.

A sent, unanswered row goes again with the same id after `retryAfterMs`, and a row whose `sentAt` is
missing or unreadable goes now. The batch is measured in exact UTF-8 bytes of the message.
`nextWakeMs` says when to look again; `blockedKeys` carries the keys rows of this decision hold.
The three sizes must be positive safe integers and `retryAfterMs` a timer delay (1 ms to about
24.8 days): anything else, `NaN` from an unset variable included, is a `RangeError` before a row is
decided, never a batch bounded by nothing.

### Set aside: quarantined and held rows

A row that cannot be sent is quarantined (`invalid_json`, `invalid_change`, `payload_too_large`), and
a row a person must look at is `held` (see [the wire](#the-wire)). Both are skipped, and by default
both **hold their keys**: the rows after them were made on top of them — an edit that was to take the
earlier edit's version as its base carries none of its own, and sent alone it would write over another
device unseen. Only a person releases the chain: retry the set-aside row (back to `pending`) and the
chain goes in order, or discard it and the next row goes. Other keys go on meanwhile.
`setAside: 'releases-keys'` lets the rows after a set-aside row go, for an app whose rows stand alone.

### Replacing a row, and confirmed rows

Commit the `sent` marks of a decision before the batch leaves. From then on the row's id stands for
the content the server may already hold, and it survives a restart: `replaceableOutboxRow(row)` is
true only for a `pending` row with no `sentAt` and no attempt, the only kind you may fold another edit
into. What folds into what — the same kind of edit, the same target, the same editor — and how a
conflict merges the rows after it into one are yours.

A change the server acknowledges with a version stays on top of remote rows until the client has
read that version: set the row `confirmed` with its `confirmedVersion`, and after each saved cursor
remove `coveredOutboxIds(rows, cursor)`. A page read before the answer then cannot show the older
value for a moment. A confirmed row is never sent again and holds nothing; one confirmed without a
version leaves at once.

## Pending edits on top of what the server sends

Until the server acknowledges a local edit, a page of remote rows must not overwrite the fields it
touched — not even for a moment. `deriveOverlay` reads the pending updates of one entity:

```ts
import { applyOverlay, deriveOverlay } from 'stitchkit/sync';

const spec = {
  parse: (payload) => {
    const parsed = TaskUpdate.safeParse(payload);
    return parsed.success ? { values: parsed.data } : undefined;
  },
};
const overlay = deriveOverlay(pendingUpdatesOf(task.id), { current: localRow ?? null, spec });
store(applyOverlay(remoteRow, overlay));
```

With a local row, its current values of the touched fields win — it already holds the edit; the
payload is used only when there is no local row yet; a key whose value is `undefined` is no value
and erases nothing. `protects` names a field an edit changes without carrying its value, and `keep`
decides per field what to keep from the local row.

Deletes: a local delete is a tombstone that wins until acknowledged (`decideRemoteRow('local')` →
`skip`); a tombstone the server sent yields to a live row arriving later (`resurrect`).
`dependentRowVisible` hides a child whose parent this page deleted, or whose parent is tombstoned
and was not brought back by this page. After a complete full snapshot,
`staleAfterFullSync({ local, server, protectedIds })` lists local rows the server no longer has,
minus those with work still pending, and `orphansOf(children, { ids, of })` the children whose
parent is gone — call it again with the survivors for grandchildren.

`server` is the rows the snapshot named, and it is kept with the rows, never in memory. Every page
of a full snapshot reaches `apply` with the snapshot's id (`{ snapshot }`, `null` in an incremental
session): mark each row a snapshot page writes with it, in the same write, and leave the mark as it
is on an incremental page. After the last page,
`rebasePending(snapshot)` receives the same id; the rows marked with it are `server`. A snapshot
continued after a restart keeps its id, so the rows the process before applied are still named — a
set collected in memory would hold only this process's pages and call the rest stale.

```ts
apply: (page, { current, snapshot }) => db.applyPage(page, { current, snapshot }), // marks the rows a snapshot page writes
rebasePending: (snapshot) => {
  db.rebaseOutbox();
  const server = db.idsMarkedWith(snapshot);
  db.remove(staleAfterFullSync({ local: db.ids(), server, protectedIds: db.pendingIds() }));
},
```

## The cursor session

`createSyncSession` owns the order of a sync; what a page contains and how it is applied stay with
you. Ports may be synchronous (`bun:sqlite`) or asynchronous (`expo-sqlite`).

```ts
import { createSyncSession } from 'stitchkit/sync';

const session = createSyncSession({
  isConnected: () => socket.connected,
  readCursor: () => db.cursor(),          // null starts a snapshot; a saved version, including 0, starts the feed
  beginFullSync: () => db.resetCursor(),  // keeps the projection; nothing is deleted yet
  send: (request) => socket.emit('sync_request', toWire(request)),
  apply: (page, context) => db.applyPage(page, context), // { current, snapshot }: see above
  saveCursor: (version) => db.saveCursor(version),
  saveProgress: (progress) => db.saveProgress(progress), // optional: a number, or where a snapshot stands; readCursor returns it
  log,
});
socket.on('connect', () => session.onReconnect());
socket.on('disconnect', () => session.onDisconnect());
socket.on('sync_response', (page) => session.handleResponse(fromWire(page)));
socket.on('sync_error', (error) => session.handleError(error)); // map a stale cursor to 'stale_cursor'
```

One session at a time; requests that arrive mid-session run next, a full one wins. Pages follow
`nextCursor`, which must grow. A full snapshot saves the version the server named on its first
page, not its last: its pages list live rows only, so an entity deleted after its page went by
would never come back to the client. When the version grew while the snapshot ran, an incremental
session starts at once from where the snapshot began and brings those changes, deletes included. A
snapshot resumed after a disconnect keeps that starting version too: its pages may already stand
past it, and a catch-up from the page it was cut at would miss a delete made in between. The same
holds across a restart: in a full snapshot `saveProgress` saves `{ snapshot, after, from }` — its
id, the next page's cursor and the version it began at — not a bare cursor, and `readCursor` returning that
object continues the snapshot, so its last page still rebases pending changes and its catch-up
starts at `from`. In an incremental session it saves the next cursor as a number. A
transport failure in the middle of a full snapshot asks for the same page again instead of starting
over. Consecutive failures grow the pause (2 s doubling to 60 s,
`retry` changes it), and `diagnostics().lastFailure` shows a poisoned page instead of only logging
it. After `stop()` or a disconnect, nothing that was waiting — a cursor read, a page apply — sends
another page or schedules a retry.

A server whose full snapshot is not ordered by version (by kind, then id) pages it by token: every
page carries `nextToken`, the request carries it back as `token`, and the server lists only rows at
or below the version the snapshot began at, which its first page names as `latestVersion`; newer
rows come through the feed. `saveProgress({ snapshot, token, from })` saves where it stands with each page,
and `readCursor` returning that object continues the snapshot after a restart. After its last
page the cursor is the version it began at, and the feed catches up from there.

A cursor older than the feed the server keeps is refused with `stale_cursor` (`SYNC_STALE_CURSOR`,
passed to `handleError`): the session begins a full snapshot at once, without a pause. Inside a
snapshot the same refusal starts it over after a pause. `beginFullSync` keeps the outbox, and after
the last page of any full snapshot — asked for, forced by the server or after `stale_cursor` —
`rebasePending` merges pending local changes onto what it brought, before its cursor is saved; a
refusal there is `rebase_failed` and the session retries. Ids come from `crypto.randomUUID`, falling back to
`crypto.getRandomValues`; on a runtime with neither (bare Hermes without a polyfill) pass
`newId`, or the session refuses at creation.

## The wire

`syncPushRequestSchema(change, { maxChanges, maxBytes })`, `SyncPushResultSchema`,
`SyncPageRequestSchema` and `SyncPageHeaderSchema` go into your contract; the push limits are
required, so a contract never accepts a batch of any size into one request. `SyncPageRequest` and
`SyncPageHeader` are inferred from the schemas.

Read push results with `classifyChangeResults`: each result on its own, so a value this client does
not know does not drop the acknowledgements beside it. Each result says what to do with its row:

| Result | Action |
| --- | --- |
| `applied`, `replayed` | `acknowledge`, with the `version` the change got when the server names it |
| `terminal_rejected` | `hold` — a person sees the code; `rejected: 'acknowledge'` drops it instead |
| `retryable_failed` | `retry`; `hold` once it came back `holdAfterFailures` times, counted by `failuresOf` |
| an outcome this client does not know | `retry`; `hold` once it came back `holdAfter` times (3), counted by `unknownOutcomesOf` |

Keep the counts in your outbox row. Set a held row's status to `held`: the outbox skips it and holds
its keys, so the rows made on top of it wait with it.

```ts
const { results } = classifyChangeResults(answer.results, {
  holdAfterFailures: 8,
  failuresOf: (changeId) => outbox.failures(changeId),
  unknownOutcomesOf: (changeId) => outbox.unknownOutcomes(changeId),
});
for (const result of results) {
  if (result.action === 'acknowledge')
    result.version === undefined
      ? outbox.remove(result.changeId)
      : outbox.confirm(result.changeId, result.version);
  else if (result.action === 'hold') outbox.hold(result.changeId, result.code);
  else if (result.known) outbox.countFailure(result.changeId);
  else outbox.countUnknown(result.changeId);
}
```

The client half needs no server of ours: the schemas, the outbox, the results and the session work
the same against a server that keeps its own journal, as long as it answers in this wire.

When versions live in the rows of several streams, `mergeStreamCursors` gives one cursor: the
lowest last version of a stream that was cut, so no stream skips rows. Its result spreads into a
page header; a stream cut without a version is refused.

## The server store

```ts
import { postgresSyncStore } from 'stitchkit/sync/postgres';

const store = postgresSyncStore({
  transaction: (work) => sql.begin(work),
  query: (tx, text, parameters) => tx.unsafe(text, [...parameters]),
});

// A push from the replica the authentication names.
const { results, effects, failures } = await store.push(
  { scope: accountId, replicaId: session.replicaId, claimedReplicaId: body.replicaId, changes: body.changes },
  async (tx, change) => {
    if (!allowed(change)) return { outcome: 'terminal_rejected', code: 'not_allowed' };
    await writeEntity(tx, change);
    await store.publish(tx, accountId, [{ entity: change.entity, entityId: change.entityId, deleted: false }]);
    return { outcome: 'applied', effect: change.entityId };
  },
);
for (const id of effects) emitChanged(id); // after the commits
for (const { changeId, error } of failures) log.error({ changeId }, error); // never to the client
```

An applied change's result names the newest `version` its transaction took through `publish` or
`allocateVersions`, and its replay names the same one, so the client keeps its row confirmed until
its cursor covers it. A rejection rolls back whatever `apply` wrote and is recorded in a transaction
of its own, so its repeat is rejected the same way; a throw rolls back, is not recorded, comes back as
`retryable_failed`, and its cause is in `failures`. The codes the store itself answers are
`replica_mismatch` and `change_id_reused`; a client released with a closed list of codes needs
them mapped at your boundary.

Every writer of the stream — not only `push` — takes its numbers inside its transaction, through
`publish` or `allocateVersions`. The scope's counter row stays locked until commit, so versions
commit in their order and a reader never finds a lower version behind one it saw. Take numbers late
in the transaction; when one transaction writes several scopes, take them in sorted order;
`lockTimeoutMs` (5 s) fails a writer instead of hanging it, for the counter statement only. The
wait needs `READ COMMITTED`, Postgres's default; under a stricter isolation a waiting writer fails.

`changesAfter(scope, cursor, { limit, full })` pages the feed; a full read lists live entities only.
The ledger is pruned by age with `prune({ before, scope? })`; a repeat of a forgotten change runs
again. `createTables: false` and `postgresSyncStoreDdl()` put the tables in your migrations
(recommended in production); otherwise they are created on first use, inside your transaction when
a write comes first.

### Moving existing data in

A stream that already has versions keeps its clients' cursors valid when its counter starts where
it ended, and a full snapshot is only complete when every live entity is in the feed. In one
migration, per scope:

```sql
INSERT INTO sync_counters (scope, version)
SELECT account_id, max(sync_version) FROM tasks GROUP BY account_id
ON CONFLICT (scope) DO NOTHING;

INSERT INTO sync_feed (scope, entity, entity_id, version, deleted)
SELECT account_id, 'task', id, sync_version, deleted_at IS NOT NULL FROM tasks
ON CONFLICT (scope, entity, entity_id) DO NOTHING;
```

The ledger of an earlier implementation does not carry over; changes a client repeats while it
moves may run again, so moving is a moment without pending pushes or with changes that are safe
twice. `startAfter` sets where scopes that have no row begin.

`memorySyncStore()` keeps the same rules in one process; a transaction opened inside another is
refused rather than left waiting for itself. A store for another database implements
`SyncStoreBackend` and gets the rules from `createSyncServerStore`; `checkSyncStore(make)` proves
them: `expect(await checkSyncStore(make)).toEqual([])`.

## SQLite migrations

The local database's schema comes from `runSqliteMigrations` in `stitchkit/application`. Its
ledger is the `schema_migrations` table with a 32-bit FNV-1a checksum; an applied migration whose
name or text changed throws `SqliteMigrationLedgerMismatchError` before anything runs, and what to
do — set the database aside or refuse it — is the host's decision. Each migration is one
transaction; the synchronous runner never awaits inside it, and a migration that fails throws
`SqliteMigrationFailedError` with its `scope`, `version` and the driver's error as `cause`. A ledger
row that is not a migration refuses the database (`SqliteMigrationLedgerUnreadableError`).
Two connections may run the same migrations on one file at once — a second window, a helper beside
the app: each transaction reads the ledger again, so the later one applies nothing twice.
`runSqliteMigrationsAsync` is for a driver that only speaks promises.

```ts
import { defineSqliteMigrations, runSqliteMigrations } from 'stitchkit/application';

const migrations = defineSqliteMigrations([
  { version: 1, name: 'tasks', statements: ['CREATE TABLE tasks (id TEXT PRIMARY KEY, text TEXT)'] },
]);
runSqliteMigrations(database, { scope: `account:${accountId}`, migrations });
```

Independent groups of tables in one file — a queue of unsent changes and a copy of the server's
rows — keep independent lists. Each names its own `ledger` table, numbers its versions from 1 and
never reads the other's history; without `ledger` a list is recorded in `schema_migrations`. A
ledger name is a plain SQL identifier (`TypeError` otherwise), and a list keeps its name for life:
a renamed ledger is an empty one, and every migration would run again.

```ts
runSqliteMigrations(database, { scope: 'device', ledger: 'queue_migrations', migrations: queue });
runSqliteMigrations(database, { scope: 'device', ledger: 'replica_migrations', migrations: replica });
```

A synchronous `expo-sqlite` handle (`openDatabaseSync`) takes a wrapper. Its convenience calls
prepare, run and finalize a statement each, so none stays open; `expo-sqlite` binds no `bigint`,
and the wrapper refuses one rather than narrowing it. Each migration still runs inside its own
`BEGIN IMMEDIATE`:

```ts
import type { SqliteDatabase, SqliteValue } from 'stitchkit/application';

const bind = (values: SqliteValue[]) =>
  values.map((value) => {
    if (typeof value === 'bigint') throw new TypeError('expo-sqlite binds no bigint');
    return value;
  });
const database: SqliteDatabase = {
  exec: (sql) => expo.execSync(sql),
  prepare: (sql) => ({
    get: (...values) => expo.getFirstSync(sql, bind(values)),
    all: (...values) => expo.getAllSync(sql, bind(values)),
    run: (...values) => ({ changes: expo.runSync(sql, bind(values)).changes }),
  }),
  close: () => expo.closeSync(),
};
```

Never edit an applied migration: add the next one.
