/**
 * The two pieces of audit machinery a project should not be writing itself.
 *
 * Both were measured as divergent across six consuming projects before they
 * lived here: the filter disagreed with itself on `OPTIONS`, and five of the six
 * lost the event whenever the store was down.
 */
import { describe, expect, test } from 'bun:test';
import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { auditChanges } from '../src/observability/changes';
import type { RequestEvent } from '../src/observability/event';
import { createSpooledSink } from '../src/observability/spool';

function event(patch: Partial<RequestEvent> = {}): RequestEvent {
  return {
    source: 'http',
    method: 'GET',
    path: '/api/notes',
    traceId: '0af7651916cd43dd8448eb211c80319c',
    spanId: 'b7ad6b7169203331',
    ok: true,
    statusCode: 200,
    durationMs: 3,
    payload: null,
    resultSize: null,
    responseBytes: 0,
    startedAt: new Date('2026-09-15T02:00:00.000Z'),
    ...patch,
  } as RequestEvent;
}

describe('the filter every project was writing itself', () => {
  test('reads are dropped, including the two a hand-written filter forgets', () => {
    expect(auditChanges(event({ method: 'GET' }))).toBe(false);
    expect(auditChanges(event({ method: 'HEAD' }))).toBe(false);
    // The verb the six consumers disagreed on.
    expect(auditChanges(event({ method: 'OPTIONS' }))).toBe(false);
  });

  test('writes are kept, on HTTP and on a tool call alike', () => {
    expect(auditChanges(event({ method: 'POST' }))).toBe(true);
    expect(auditChanges(event({ method: 'DELETE' }))).toBe(true);
    // A tool call says `TOOL` and carries its contract verb separately.
    expect(auditChanges(event({ method: 'TOOL', httpMethod: 'POST' }))).toBe(true);
    expect(auditChanges(event({ method: 'TOOL', httpMethod: 'GET' }))).toBe(false);
  });

  test('a refused read is written, which is the row a write-only filter loses', () => {
    expect(auditChanges(event({ method: 'GET', ok: false, statusCode: 401 }))).toBe(true);
    expect(auditChanges(event({ method: 'GET', ok: false, statusCode: 403 }))).toBe(true);
    // Not every failure is a security outcome: an audit of every stale bookmark
    // buries the rows that mean something.
    expect(auditChanges(event({ method: 'GET', ok: false, statusCode: 404 }))).toBe(false);
  });

  test('an unrecognised verb is kept, because the two mistakes do not cost the same', () => {
    expect(auditChanges(event({ method: 'PROPFIND' }))).toBe(true);
    expect(auditChanges(event({ method: 'TOOL' }))).toBe(true);
  });
});

describe('an audit row survives the store being down', () => {
  function spoolPath(): string {
    return join(mkdtempSync(join(tmpdir(), 'stitchkit-spool-')), 'audit.ndjson');
  }

  test('what the store refused is replayed by the next process', async () => {
    const path = spoolPath();
    const failures: unknown[] = [];

    // First process: the store is down and every write throws.
    const down = createSpooledSink({
      path,
      write: () => {
        throw new Error('the database is unreachable');
      },
      onSpoolError: (failure) => failures.push(failure.error),
    });
    await expect(down.write(event({ spanId: 'aaaa', method: 'POST' }))).rejects.toThrow(
      'the database is unreachable',
    );
    await expect(down.write(event({ spanId: 'bbbb', method: 'DELETE' }))).rejects.toThrow();
    expect(down.pending()).toBe(2);

    // Second process, same path: the store is back.
    const stored: RequestEvent[] = [];
    const up = createSpooledSink({
      path,
      write: (value) => {
        stored.push(value);
      },
    });
    const recovery = await up.recover();
    expect(recovery).toEqual({ replayed: 2, failed: 0 });
    expect(stored.map((value) => value.spanId).sort()).toEqual(['aaaa', 'bbbb']);
    // A `Date` column handed a string fails at 3am on rows that only exist
    // because something already went wrong once.
    expect(stored[0]?.startedAt).toBeInstanceOf(Date);
    expect(stored[0]?.startedAt.toISOString()).toBe('2026-09-15T02:00:00.000Z');
    expect(failures).toHaveLength(0);
  });

  test('a delivered row is not replayed', async () => {
    const path = spoolPath();
    const first: RequestEvent[] = [];
    const sink = createSpooledSink({ path, write: (value) => void first.push(value) });
    await sink.write(event({ spanId: 'cccc', method: 'POST' }));
    expect(sink.pending()).toBe(0);

    const second: RequestEvent[] = [];
    const next = createSpooledSink({ path, write: (value) => void second.push(value) });
    expect(await next.recover()).toEqual({ replayed: 0, failed: 0 });
    expect(second).toEqual([]);
  });

  test('a store still refusing keeps the row for the process after this one', async () => {
    const path = spoolPath();
    const down = createSpooledSink({
      path,
      write: () => {
        throw new Error('still down');
      },
    });
    await expect(down.write(event({ spanId: 'dddd', method: 'POST' }))).rejects.toThrow();

    const refusals: unknown[] = [];
    const stillDown = createSpooledSink({
      path,
      write: () => {
        throw new Error('still down');
      },
      onSpoolError: (failure) => refusals.push(failure.error),
    });
    expect(await stillDown.recover()).toEqual({ replayed: 1, failed: 1 });
    expect(refusals).toHaveLength(1);

    // And the row is still there for the next attempt — a replay that dropped
    // what it could not deliver would be worse than no spool at all.
    const stored: RequestEvent[] = [];
    const up = createSpooledSink({ path, write: (value) => void stored.push(value) });
    expect(await up.recover()).toEqual({ replayed: 1, failed: 0 });
    expect(stored[0]?.spanId).toBe('dddd');
  });

  test('a torn last line loses that record and no other', async () => {
    const path = spoolPath();
    const sink = createSpooledSink({
      path,
      write: () => {
        throw new Error('down');
      },
    });
    await expect(sink.write(event({ spanId: 'eeee', method: 'POST' }))).rejects.toThrow();
    const { appendFile } = await import('node:fs/promises');
    await appendFile(path, '{"k":"ffff","e":{"spanId":"ff', 'utf8');

    const stored: RequestEvent[] = [];
    const torn: unknown[] = [];
    const up = createSpooledSink({
      path,
      write: (value) => void stored.push(value),
      onSpoolError: (failure) => torn.push(failure.error),
    });
    expect(await up.recover()).toEqual({ replayed: 1, failed: 0 });
    expect(stored.map((value) => value.spanId)).toEqual(['eeee']);
    expect(torn).toHaveLength(1);
  });

  test('the file is rewritten once the delivered rows pile up', async () => {
    const path = spoolPath();
    const sink = createSpooledSink({ path, write: () => undefined, compactAfter: 4 });
    for (let index = 0; index < 8; index += 1) {
      await sink.write(event({ spanId: `s${index}`, method: 'POST' }));
    }
    const lines = readFileSync(path, 'utf8').split('\n').filter(Boolean);
    // Everything was delivered, so nothing is owed and the file says so.
    expect(lines).toHaveLength(0);
  });

  test('recovering a path that was never written is zero, not a failure', async () => {
    const failures: unknown[] = [];
    const sink = createSpooledSink({
      path: join(mkdtempSync(join(tmpdir(), 'stitchkit-spool-')), 'nested', 'audit.ndjson'),
      write: () => undefined,
      onSpoolError: (failure) => failures.push(failure.error),
    });
    expect(await sink.recover()).toEqual({ replayed: 0, failed: 0 });
    expect(failures).toHaveLength(0);
  });

  test('a missing directory is created rather than losing the row', async () => {
    const path = join(mkdtempSync(join(tmpdir(), 'stitchkit-spool-')), 'deep', 'audit.ndjson');
    const stored: RequestEvent[] = [];
    const sink = createSpooledSink({ path, write: (value) => void stored.push(value) });
    await sink.write(event({ spanId: 'gggg', method: 'POST' }));
    expect(readFileSync(path, 'utf8').split('\n').filter(Boolean).length).toBeGreaterThan(0);
    expect(stored).toHaveLength(1);
  });
});
