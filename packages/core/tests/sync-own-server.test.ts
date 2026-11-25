/**
 * The client half against a server the app wrote itself: a journal of change
 * sets with the state before each, numbered by the app, without the store of
 * `stitchkit/sync/postgres`. Everything here comes from the entry a client
 * imports — the outbox with keys, results with versions, confirmed rows that
 * stay on top until the cursor covers them, a snapshot paged by token, a cursor
 * the server no longer keeps — and that entry never reaches the server store.
 */
import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { z } from 'zod';
import {
  applyOverlay,
  classifyChangeResults,
  coveredOutboxIds,
  createSyncSession,
  decideOutboxBatch,
  deriveOverlay,
  type OutboxRow,
  SYNC_STALE_CURSOR,
  SyncPageHeaderSchema,
  type SyncPageRequest,
  SyncPushResultSchema,
  syncPushRequestSchema,
} from '../src/entrypoints/sync';

const SRC = resolve(import.meta.dir, '../src');

/** Every module a file reaches through its relative imports. */
function reach(entry: string): Set<string> {
  const seen = new Set<string>();
  const transpiler = new Bun.Transpiler({ loader: 'ts' });
  const visit = (file: string) => {
    if (seen.has(file)) return;
    seen.add(file);
    for (const { path } of transpiler.scanImports(readFileSync(file, 'utf8'))) {
      if (!path.startsWith('.')) continue;
      const base = resolve(dirname(file), path);
      const target = [`${base}.ts`, `${base}/index.ts`, base].find((candidate) =>
        Bun.file(candidate).size > 0 ? candidate.endsWith('.ts') : false,
      );
      if (target) visit(target);
    }
  };
  visit(entry);
  return seen;
}

describe('the client entry stands without the server store', () => {
  test('nothing the client entry reaches is the server store; the server entry does reach it', () => {
    const storeModule = (file: string) => file.includes('/sync/server-store');
    const client = [...reach(resolve(SRC, 'entrypoints/sync.ts'))];
    expect(client.length).toBeGreaterThan(5);
    expect(client.filter(storeModule)).toEqual([]);
    // Negative control: the walk finds the store where it is imported.
    const server = [...reach(resolve(SRC, 'entrypoints/sync/postgres.ts'))];
    expect(server.filter(storeModule).length).toBeGreaterThan(0);
  });
});

const Change = z.object({ id: z.string(), entityId: z.string(), text: z.string() });
type Change = z.infer<typeof Change>;
const PushRequest = syncPushRequestSchema(Change, { maxChanges: 10, maxBytes: 4096 });
const Page = SyncPageHeaderSchema.extend({
  rows: z.array(z.object({ id: z.string(), text: z.string(), version: z.int() })),
});
type Page = z.infer<typeof Page>;

/** The app's own server: change sets with the state before each, a floor the feed keeps. */
class OwnServer {
  version = 0;
  floor = 0;
  readonly rows = new Map<string, { text: string; version: number }>();
  readonly journal: { version: number; entityId: string; before: string | null }[] = [];

  push(body: unknown): unknown {
    const { changes } = PushRequest.parse(body);
    return {
      results: changes.map((change) => {
        this.version += 1;
        this.journal.push({
          version: this.version,
          entityId: change.entityId,
          before: this.rows.get(change.entityId)?.text ?? null,
        });
        this.rows.set(change.entityId, { text: change.text, version: this.version });
        return { changeId: change.id, outcome: 'applied', version: this.version };
      }),
    };
  }

  /** A page, or the refusal of a cursor below the floor. */
  page(request: SyncPageRequest): Page | { code: string } {
    const head = { sessionId: request.sessionId, requestId: request.requestId };
    const live = [...this.rows].map(([id, row]) => ({ id, ...row }));
    if (!request.full) {
      if ((request.after ?? 0) < this.floor) return { code: SYNC_STALE_CURSOR };
      const rows = live.filter((row) => row.version > (request.after ?? 0));
      return { ...head, hasMore: false, latestVersion: this.version, rows };
    }
    // A snapshot by id: rows at or below the version it began at; the token carries both.
    const [at, last] = request.token ? request.token.split(':') : [String(this.version), ''];
    const snapshotAt = Number(at);
    const rows = live
      .filter((row) => row.version <= snapshotAt && row.id > (last ?? ''))
      .toSorted((a, b) => (a.id < b.id ? -1 : 1))
      .slice(0, 1);
    const more = live.some(
      (row) => row.version <= snapshotAt && row.id > (rows[0]?.id ?? '~'),
    );
    return {
      ...head,
      hasMore: more,
      ...(more && { nextToken: `${snapshotAt}:${rows[0]?.id}` }),
      latestVersion: snapshotAt,
      rows,
    };
  }
}

interface Row extends OutboxRow {
  confirmedVersion: number | null;
}

/** A client with its projection, its outbox and a cursor session over the server above. */
function client(server: OwnServer) {
  const projection = new Map<string, { text: string; updatedAt: string }>();
  const remote = new Map<string, { text: string; updatedAt: string }>();
  let outbox: Row[] = [];
  let cursor: number | null = null;
  const events: string[] = [];
  const queue: SyncPageRequest[] = [];
  const spec = {
    parse: (payload: unknown) => {
      const parsed = z.object({ text: z.string() }).safeParse(payload);
      return parsed.success ? { values: parsed.data } : undefined;
    },
  };
  const show = (id: string) => {
    const base = remote.get(id) ?? { text: '', updatedAt: '' };
    const pending = outbox
      .filter((row) => row.entityId === id && row.status !== 'quarantined')
      .map((row) => ({ payload: JSON.parse(row.payloadJson), createdAt: row.id }));
    projection.set(
      id,
      applyOverlay(
        base,
        deriveOverlay(pending, { current: projection.get(id) ?? null, spec }),
      ),
    );
  };
  const session = createSyncSession<Page>({
    isConnected: () => true,
    readCursor: () => cursor,
    beginFullSync: () => {
      events.push('begin');
      cursor = null;
    },
    send: (request) => queue.push(request),
    apply: (page) => {
      for (const row of page.rows) {
        remote.set(row.id, { text: row.text, updatedAt: String(row.version) });
        show(row.id);
      }
    },
    saveCursor: (version) => {
      cursor = version ?? cursor;
      const covered = new Set(coveredOutboxIds(outbox, cursor));
      const left = outbox.filter((row) => covered.has(row.id)).map((row) => row.entityId);
      outbox = outbox.filter((row) => !covered.has(row.id));
      for (const id of left) show(id);
    },
    rebasePending: () => {
      events.push(`rebase:${outbox.map((row) => row.id).join(',')}`);
    },
    log: { info: () => undefined, warn: () => undefined, error: () => undefined },
    schedule: () => () => undefined,
    newId: (() => {
      let id = 0;
      return () => `id-${++id}`;
    })(),
  });
  /** Rows of a page the app applies outside the session, e.g. a read that was in flight. */
  const land = (rows: Page['rows']) => {
    for (const row of rows) {
      remote.set(row.id, { text: row.text, updatedAt: String(row.version) });
      show(row.id);
    }
  };
  const pump = async () => {
    for (let request = queue.shift(); request; request = queue.shift()) {
      const answer = server.page(request);
      if ('code' in answer) await session.handleError({ ...request, code: answer.code });
      else await session.handleResponse(Page.parse(answer));
    }
  };
  const edit = (id: string, entityId: string, text: string) => {
    outbox.push({
      id,
      entity: 'note',
      entityId,
      payloadJson: JSON.stringify({ text }),
      status: 'pending',
      sentAt: null,
      attempts: 0,
      confirmedVersion: null,
    });
    // The local row takes the edit in the same transaction as its outbox row.
    projection.set(entityId, { text, updatedAt: id });
  };
  const push = () => {
    const decision = decideOutboxBatch(outbox, {
      now: 0,
      policy: {
        toChange: (row, payload): Change | undefined => {
          const parsed = Change.safeParse({
            id: row.id,
            entityId: row.entityId,
            ...Object(payload),
          });
          return parsed.success ? parsed.data : undefined;
        },
        emptyEnvelopeBytes: 14,
        maxBytes: 4096,
        maxChanges: 10,
        retryAfterMs: 30_000,
      },
    });
    for (const mark of decision.sent)
      outbox = outbox.map((row) =>
        row.id === mark.id ? { ...row, status: 'sent', ...mark } : row,
      );
    if (decision.send.length === 0) return [];
    const answer = SyncPushResultSchema.parse(server.push({ changes: decision.send }));
    const { results } = classifyChangeResults(answer.results);
    for (const result of results)
      if (result.action === 'acknowledge')
        outbox = outbox.map((row) =>
          row.id === result.changeId
            ? { ...row, status: 'confirmed', confirmedVersion: result.version ?? null }
            : row,
        );
    return results;
  };
  return {
    session,
    pump,
    land,
    edit,
    push,
    events,
    projection,
    outbox: () => outbox,
    cursor: () => cursor,
  };
}

describe('an app’s own server', () => {
  test('a confirmed edit stays on top until the cursor covers its version, then leaves', async () => {
    const server = new OwnServer();
    server.rows.set('n', { text: 'old', version: 1 });
    server.version = 1;
    const device = client(server);
    await device.session.requestSync();
    await device.pump();
    expect(device.projection.get('n')?.text).toBe('old');

    device.edit('e1', 'n', 'typed');
    // A page read before the push lands after its answer: the confirmed edit stays on top.
    const early = server.page({
      sessionId: 'x',
      requestId: 'y',
      after: 0,
      token: null,
      full: false,
    });
    expect(device.push()).toMatchObject([
      { changeId: 'e1', action: 'acknowledge', version: 2 },
    ]);
    expect(device.outbox()).toMatchObject([
      { id: 'e1', status: 'confirmed', confirmedVersion: 2 },
    ]);
    if ('code' in early) throw new Error('the early page was refused');
    expect(early.rows[0]?.text).toBe('old');
    device.land(early.rows);
    expect(device.projection.get('n')?.text).toBe('typed');
    device.session.requestSync();
    await device.pump();
    expect(device.cursor()).toBe(2);
    expect(device.outbox()).toEqual([]);
    expect(device.projection.get('n')?.text).toBe('typed');
  });

  test('a cursor below the floor reloads a token snapshot, keeps the outbox and rebases it', async () => {
    const server = new OwnServer();
    for (const id of ['a', 'b', 'c']) {
      server.version += 1;
      server.rows.set(id, { text: id, version: server.version });
    }
    const device = client(server);
    await device.session.requestSync();
    await device.pump();
    expect(device.cursor()).toBe(3);

    // Offline for long: the feed forgot what follows the cursor; another device wrote `d`.
    device.edit('e1', 'a', 'mine');
    server.version += 1;
    server.rows.set('d', { text: 'd', version: server.version });
    server.floor = 4;
    device.session.requestSync();
    await device.pump();
    // The first load rebases an empty outbox; the reload rebases the edit made offline.
    expect(device.events).toEqual(['begin', 'rebase:', 'begin', 'rebase:e1']);
    expect(device.cursor()).toBe(4);
    expect([...device.projection.keys()].toSorted()).toEqual(['a', 'b', 'c', 'd']);
    expect(device.projection.get('a')?.text).toBe('mine');
    expect(device.outbox().map((row) => row.id)).toEqual(['e1']);
    expect(device.push()).toMatchObject([
      { changeId: 'e1', action: 'acknowledge', version: 5 },
    ]);
  });
});
