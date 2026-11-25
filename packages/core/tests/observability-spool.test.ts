import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import {
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { z } from 'zod';
import type { RequestEvent } from '../src/observability/event';
import type { JsonValue } from '../src/observability/sanitize';
import { createSpooledSink } from '../src/observability/spool';
import { createSpoolCore } from '../src/observability/spool-core';

let directory: string;
let path: string;

beforeEach(() => {
  directory = mkdtempSync(join(tmpdir(), 'stitchkit-observability-spool-'));
  path = join(directory, 'spool.ndjson');
});

afterEach(() => {
  rmSync(directory, { recursive: true, force: true });
});

interface Row {
  id: string;
  group?: string;
  payload?: unknown;
}

const RowSchema = z.strictObject({
  id: z.string(),
  group: z.string().optional(),
  payload: z.unknown().optional(),
});

function sampleEvent(
  patch: Partial<Pick<RequestEvent, 'spanId' | 'payload'>> = {},
): RequestEvent {
  return {
    source: 'http',
    kind: 'request',
    method: 'POST',
    path: '/api/items',
    traceId: '0af7651916cd43dd8448eb211c80319c',
    spanId: patch.spanId ?? 'b7ad6b7169203331',
    ok: true,
    statusCode: 200,
    durationMs: 4,
    payload: patch.payload ?? null,
    resultSize: null,
    responseBytes: 0,
    startedAt: new Date('2026-11-24T00:00:00.000Z'),
  };
}

describe('spool-core encoding, cleanup and atomic compaction', () => {
  test('a throw inside encode cleans up undelivered and does not wedge its group', async () => {
    const delivered: string[] = [];
    const spool = createSpoolCore<Row>({
      path,
      write: (row) => void delivered.push(row.id),
      key: (row) => row.id,
      group: (row) => row.group ?? row.id,
      encode: (row) => {
        if (row.id === 'broken') throw new Error('encode boom');
        return row;
      },
      decode: (value) => RowSchema.parse(value),
    });

    await expect(spool.write({ id: 'broken', group: 'g1' })).rejects.toThrow('encode boom');
    expect(spool.pending()).toBe(0);

    const next = await spool.write({ id: 'after', group: 'g1' });
    expect(next).toEqual({ outcome: 'delivered' });
    expect(delivered).toEqual(['after']);
    expect(spool.pending()).toBe(0);
  });

  test('a throw inside JSON.stringify cleans up undelivered, reports onSpoolError, and still offers the record', async () => {
    const delivered: string[] = [];
    const errors: unknown[] = [];
    const cyclic: Record<string, unknown> = {};
    cyclic.self = cyclic;

    const spool = createSpoolCore<Row>({
      path,
      write: (row) => void delivered.push(row.id),
      key: (row) => row.id,
      group: (row) => row.group ?? row.id,
      encode: (row) => (row.id === 'cycle' ? cyclic : row),
      decode: (value) => RowSchema.parse(value),
      onSpoolError: ({ error }) => void errors.push(error),
    });

    const cycleResult = await spool.write({ id: 'cycle', group: 'g1' });
    expect(cycleResult).toEqual({ outcome: 'delivered' });
    expect(spool.pending()).toBe(0);
    expect(errors).toHaveLength(1);
    expect(errors[0]).toBeInstanceOf(TypeError);

    // BigInt also triggers a JSON.stringify TypeError.
    const bigIntResult = await spool.write({ id: 'bigint', group: 'g1', payload: 42n });
    expect(bigIntResult).toEqual({ outcome: 'delivered' });
    expect(spool.pending()).toBe(0);
    expect(errors).toHaveLength(2);
    expect(errors[1]).toBeInstanceOf(TypeError);
    expect(delivered).toEqual(['cycle', 'bigint']);

    // When the store also refuses an unserializable record, the outcome is unspooled and pending stays 0.
    const failingErrors: unknown[] = [];
    const downSpool = createSpoolCore<Row>({
      path: join(directory, 'down.ndjson'),
      write: () => {
        throw new Error('store down');
      },
      key: (row) => row.id,
      encode: () => cyclic,
      decode: (value) => RowSchema.parse(value),
      onSpoolError: ({ error }) => void failingErrors.push(error),
    });
    const downResult = await downSpool.write({ id: 'cycle-down' });
    expect(downResult.outcome).toBe('unspooled');
    expect(downSpool.pending()).toBe(0);
    expect(failingErrors).toHaveLength(1);
    expect(failingErrors[0]).toBeInstanceOf(TypeError);
  });

  test('compaction writes atomically with 0600 mode and leaves no temporary files behind', async () => {
    const spool = createSpoolCore<Row>({
      path,
      write: () => undefined,
      key: (row) => row.id,
      encode: (row) => row,
      decode: (value) => RowSchema.parse(value),
      compactAfter: 2,
    });

    await spool.write({ id: 'one' });
    await spool.write({ id: 'two' });

    const files = readdirSync(directory);
    expect(files).toEqual(['spool.ndjson']);
    if (process.platform !== 'win32') {
      expect(statSync(path).mode & 0o777).toBe(0o600);
    }
  });
});

describe('createSpooledSink without double JSON round-trip', () => {
  test('spools and recovers RequestEvent with Date and optional undefined fields', async () => {
    const down = createSpooledSink({
      path,
      write: () => {
        throw new Error('db down');
      },
    });
    const eventWithUndefined = Object.assign(
      sampleEvent({ spanId: 'span-1', payload: { nested: 'ok' } }),
      { errorCode: undefined },
    );
    await expect(down.write(eventWithUndefined)).rejects.toThrow('db down');
    expect(down.pending()).toBe(1);

    const recovered: RequestEvent[] = [];
    const up = createSpooledSink({
      path,
      write: (event) => void recovered.push(event),
    });
    expect(await up.recover()).toEqual({ replayed: 1, failed: 0 });
    expect(recovered).toHaveLength(1);
    expect(recovered[0]?.spanId).toBe('span-1');
    expect(recovered[0]?.startedAt).toBeInstanceOf(Date);
    expect(recovered[0]?.startedAt.toISOString()).toBe('2026-11-24T00:00:00.000Z');
    expect(recovered[0]?.payload).toEqual({ nested: 'ok' });
  });

  test('an unserializable RequestEvent payload reports onSpoolError without leaking pending()', async () => {
    const cyclic: { [key: string]: JsonValue } = {};
    cyclic.self = cyclic;
    const spoolErrors: unknown[] = [];
    const delivered: RequestEvent[] = [];

    const sink = createSpooledSink({
      path,
      write: (event) => void delivered.push(event),
      onSpoolError: ({ error }) => void spoolErrors.push(error),
    });

    await sink.write(sampleEvent({ spanId: 'cyclic-span', payload: cyclic }));
    expect(sink.pending()).toBe(0);
    expect(spoolErrors).toHaveLength(1);
    expect(spoolErrors[0]).toBeInstanceOf(TypeError);
    expect(delivered).toHaveLength(1);
  });
});

describe('createSpooledSink over a file larger than its bound (a 0.126 spool, a lowered bound)', () => {
  const line = (spanId: string) => JSON.stringify({ k: spanId, e: sampleEvent({ spanId }) });
  const ack = (spanId: string) => JSON.stringify({ a: spanId });
  const down = () => {
    throw new Error('db down');
  };

  test('a debt that fits is replayed from the file read line by line, and the spool goes on', async () => {
    // Delivered records and their marks fill the file; two records are still owed.
    const delivered = Array.from({ length: 200 }, (_, index) => `done-${index}`);
    const lines = [
      ...delivered.flatMap((id) => [line(id), ack(id)]),
      line('owed-1'),
      line('owed-2'),
    ];
    writeFileSync(path, `${lines.join('\n')}\n`);
    const maxFileBytes = 8 * 1024;
    expect(statSync(path).size).toBeGreaterThan(maxFileBytes);
    const stored: string[] = [];
    let up = true;
    const sink = createSpooledSink({
      path,
      maxFileBytes,
      write: (event) => {
        if (!up) down();
        stored.push(event.spanId);
      },
    });
    expect(await sink.recover()).toEqual({ replayed: 2, failed: 0 });
    expect(stored).toEqual(['owed-1', 'owed-2']);
    expect(statSync(path).size).toBeLessThanOrEqual(maxFileBytes);
    up = false;
    await expect(sink.write(sampleEvent({ spanId: 'new' }))).rejects.toThrow('db down');
    expect(sink.pending()).toBe(1);
    expect(readFileSync(path, 'utf8')).toContain('"k":"new"');
  });

  test('without recover, a file of delivered lines over the bound is compacted once instead of refusing every record', async () => {
    const delivered = Array.from({ length: 200 }, (_, index) => `done-${index}`);
    writeFileSync(path, `${delivered.flatMap((id) => [line(id), ack(id)]).join('\n')}\n`);
    const sink = createSpooledSink({ path, maxFileBytes: 8 * 1024, write: down });
    await expect(sink.write(sampleEvent({ spanId: 'new' }))).rejects.toThrow('db down');
    expect(sink.pending()).toBe(1);
    expect(readFileSync(path, 'utf8')).toBe(`${line('new')}\n`);
  });

  test('a spool file that cannot be read is an unknown debt, reported with its cause and left on disk', async () => {
    // A directory where the file stands: the open succeeds, every read refuses.
    mkdirSync(path);
    writeFileSync(join(path, 'kept'), 'owed');
    const errors: unknown[] = [];
    const sink = createSpooledSink({
      path,
      write: () => undefined,
      onSpoolError: ({ error }) => void errors.push(error),
    });
    expect(await sink.recover()).toEqual({ replayed: 0, failed: 0, unread: true });
    expect(errors).toEqual([
      expect.objectContaining({
        code: 'SPOOL_UNREADABLE',
        cause: expect.objectContaining({ code: 'EISDIR' }),
      }),
    ]);
    expect(readdirSync(path)).toEqual(['kept']);
    expect(readFileSync(join(path, 'kept'), 'utf8')).toBe('owed');
    // Positive control: no file at all is the first run, an empty debt.
    rmSync(path, { recursive: true });
    expect(await sink.recover()).toEqual({ replayed: 0, failed: 0 });
  });

  test('a debt that does not fit goes aside whole, new records still spool, and it replays from there', async () => {
    const owed = Array.from({ length: 40 }, (_, index) => `owed-${index}`);
    const original = `${owed.map(line).join('\n')}\n`;
    writeFileSync(path, original);
    const errors: unknown[] = [];
    const sink = createSpooledSink({
      path,
      maxFileBytes: 4096,
      write: down,
      onSpoolError: ({ error }) => void errors.push(error),
    });
    const recovery = await sink.recover();
    expect(recovery).toMatchObject({ replayed: 0, failed: 0 });
    const aside = recovery.quarantined ?? '';
    expect(aside.startsWith(`${path}.`) && aside.endsWith('.overflow')).toBe(true);
    expect(readFileSync(aside, 'utf8')).toBe(original);
    expect(errors).toEqual([
      expect.objectContaining({ code: 'SPOOL_QUARANTINED', quarantined: aside }),
    ]);
    // The store is down and the record is not lost: it is on disk and pending.
    await expect(sink.write(sampleEvent({ spanId: 'new' }))).rejects.toThrow('db down');
    expect(sink.pending()).toBe(1);
    expect(readFileSync(path, 'utf8')).toContain('"k":"new"');

    // The debt is a spool file of its own: one with a bound it fits replays it.
    const replayed: string[] = [];
    const drain = createSpooledSink({
      path: aside,
      write: (event) => void replayed.push(event.spanId),
    });
    expect(await drain.recover()).toEqual({ replayed: 40, failed: 0 });
    expect(replayed).toEqual(owed);
  });

  test('a debt the replay leaves over the bound is written aside and counted in failed', async () => {
    const owed = ['owed-1', 'owed-2', 'owed-3'];
    writeFileSync(path, `${owed.map(line).join('\n')}\n`);
    // The records fit the bound in memory; with their line breaks the file would not.
    const maxFileBytes = owed.reduce((sum, id) => sum + Buffer.byteLength(line(id)), 0) + 1;
    const errors: unknown[] = [];
    const sink = createSpooledSink({
      path,
      maxFileBytes,
      write: down,
      onSpoolError: ({ error }) => void errors.push(error),
    });
    const recovery = await sink.recover();
    expect(recovery).toMatchObject({ replayed: 3, failed: 3 });
    expect(readFileSync(recovery.quarantined ?? '', 'utf8')).toBe(
      `${owed.map(line).join('\n')}\n`,
    );
    expect(readFileSync(path, 'utf8')).toBe('');
    expect(sink.pending()).toBe(0);
    expect(errors.at(-1)).toMatchObject({ code: 'SPOOL_QUARANTINED' });
    await expect(sink.write(sampleEvent({ spanId: 'new' }))).rejects.toThrow('db down');
    expect(sink.pending()).toBe(1);
  });
});

describe('createSpooledSink at its bounds: a row kept nowhere is never silent', () => {
  test('past maxPendingEntries or maxFileBytes the writer is refused with SPOOL_UNSPOOLED and onSpoolError says which bound', async () => {
    const down = () => {
      throw new Error('db down');
    };
    for (const bound of [
      { bound: 'entries', config: { maxPendingEntries: 2 } },
      {
        bound: 'bytes',
        config: {
          maxFileBytes:
            2 *
              Buffer.byteLength(
                JSON.stringify({ k: 'r0', e: sampleEvent({ spanId: 'r0' }) }),
              ) +
            2,
        },
      },
    ] as const) {
      const spoolPath = join(directory, `${bound.bound}.ndjson`);
      const errors: unknown[] = [];
      const sink = createSpooledSink({
        path: spoolPath,
        write: down,
        onSpoolError: ({ error }) => void errors.push(error),
        ...bound.config,
      });
      // Spooled and refused: the store's own error, and `recover` will offer the row again.
      for (const spanId of ['r0', 'r1'])
        await expect(sink.write(sampleEvent({ spanId })), bound.bound).rejects.toThrow(
          'db down',
        );
      // Kept nowhere: the writer learns it, with the store's refusal as the cause.
      await expect(
        sink.write(sampleEvent({ spanId: 'r2' })),
        bound.bound,
      ).rejects.toMatchObject({
        code: 'SPOOL_UNSPOOLED',
        cause: expect.objectContaining({ message: 'db down' }),
      });
      expect(errors, bound.bound).toEqual([
        expect.objectContaining({ code: 'SPOOL_FULL', bound: bound.bound }),
      ]);
      expect(sink.pending(), bound.bound).toBe(2);
    }
  });
});
