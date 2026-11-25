import { afterEach, beforeEach, expect, test } from 'bun:test';
import {
  chmodSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { z } from 'zod';
import { createSpoolCore, type SpoolCoreConfig } from '../src/observability/spool-core';

let directory: string;
let path: string;
beforeEach(() => {
  directory = mkdtempSync(join(tmpdir(), 'stitchkit-spool-core-'));
  path = join(directory, 'spool.ndjson');
});
afterEach(() => rmSync(directory, { recursive: true, force: true }));

type Row = { id: string; group?: string };
const RowSchema = z.strictObject({ id: z.string(), group: z.string().optional() });

function core(
  write: (row: Row) => void | Promise<void>,
  extra: Partial<SpoolCoreConfig<Row>> = {},
) {
  return createSpoolCore<Row>({
    path,
    write,
    key: (row) => row.id,
    encode: (row) => ({ ...row }),
    decode: (value) => RowSchema.parse(value),
    ...extra,
  });
}
const down = () => {
  throw new Error('down');
};

test('a torn last line left by a crash does not swallow the next record', async () => {
  writeFileSync(path, '{"k":"half","e":{"id":"ha');
  await core(down).write({ id: 'next' });
  const delivered: string[] = [];
  expect(await core((row) => void delivered.push(row.id)).recover()).toEqual({
    replayed: 1,
    failed: 0,
  });
  expect(delivered).toEqual(['next']);
});

test('a line that cannot be decoded is reported and kept through compaction, never erased', async () => {
  writeFileSync(path, `${JSON.stringify({ k: 'future', e: { id: 1, shape: 'v2' } })}\n`);
  const errors: unknown[] = [];
  await core(() => undefined, { onSpoolError: ({ error }) => errors.push(error) }).recover();
  expect(errors).toHaveLength(1);
  expect(readFileSync(path, 'utf8')).toContain('"future"');
});

test('a file full of delivered lines is compacted before a record is refused for size', async () => {
  const errors: unknown[] = [];
  const spool = core(() => undefined, {
    maxFileBytes: 200,
    compactAfter: 1_000,
    onSpoolError: ({ error }) => errors.push(error),
  });
  for (let i = 0; i < 20; i += 1)
    expect((await spool.write({ id: `row-${i}` })).outcome).toBe('delivered');
  expect(errors).toEqual([]);
  expect(statSync(path).size).toBeLessThanOrEqual(200);
});

test('an existing spool file is narrowed to 0600', async () => {
  writeFileSync(path, '');
  chmodSync(path, 0o644);
  await core(down).write({ id: 'secret' });
  expect(statSync(path).mode & 0o777).toBe(0o600);
});

test('without groups a refused record does not hold back the others; within a group it does', async () => {
  for (const row of [
    { id: 'a1', group: 'a' },
    { id: 'poison', group: 'b' },
    { id: 'b2', group: 'b' },
    { id: 'a2', group: 'a' },
  ])
    await core(down).write(row);
  const free: string[] = [];
  const refuse = (row: Row) => {
    if (row.id === 'poison') throw new Error('rejected forever');
    free.push(row.id);
  };
  // Copy the file: each recovery compacts it.
  const body = readFileSync(path, 'utf8');
  expect(await core(refuse).recover()).toEqual({ replayed: 4, failed: 1 });
  expect(free).toEqual(['a1', 'b2', 'a2']);

  writeFileSync(path, body);
  const grouped: string[] = [];
  const result = await core(
    (row) => {
      if (row.id === 'poison') throw new Error('rejected forever');
      grouped.push(row.id);
    },
    { group: (row) => row.group ?? row.id },
  ).recover();
  expect(result).toEqual({ replayed: 4, failed: 2 });
  expect(grouped).toEqual(['a1', 'a2']);
});

test('in one process a record of a group first delivers the ones ahead of it, in order', async () => {
  let up = false;
  const delivered: string[] = [];
  const spool = core(
    (row) => {
      if (!up) throw new Error('down');
      delivered.push(row.id);
    },
    { group: (row) => row.group ?? row.id },
  );
  expect((await spool.write({ id: 'first', group: 'g' })).outcome).toBe('spooled');
  // Still down: the second waits behind the first instead of overtaking it.
  expect((await spool.write({ id: 'second', group: 'g' })).outcome).toBe('spooled');
  expect(delivered).toEqual([]);
  up = true;
  expect((await spool.write({ id: 'third', group: 'g' })).outcome).toBe('delivered');
  expect(delivered).toEqual(['first', 'second', 'third']);
  expect(spool.pending()).toBe(0);
});

test('two concurrent writes of one group reach the store in write order', async () => {
  const delivered: string[] = [];
  const spool = core(
    async (row) => {
      if (row.id === 'a') await Bun.sleep(20);
      delivered.push(row.id);
    },
    { group: (row) => row.group ?? row.id },
  );
  await Promise.all([
    spool.write({ id: 'a', group: 'g' }),
    spool.write({ id: 'b', group: 'g' }),
  ]);
  expect(delivered.indexOf('a')).toBeLessThan(delivered.indexOf('b'));
});

test('compaction keeps what an earlier process left undelivered', async () => {
  await core(down).write({ id: 'earlier' });
  const later = core(() => undefined, { compactAfter: 1 });
  await later.write({ id: 'now' });
  const delivered: string[] = [];
  await core((row) => void delivered.push(row.id)).recover();
  expect(delivered).toEqual(['earlier']);
});
