// A filesystem whose clock is coarse: every stat of a file reports the same mtime and
// ctime until the scenario moves the stamp, the way a same-length rewrite inside one tick
// looks on a kernel without fine-grained timestamps (vfat, FUSE, 9p, ext4 before 6.13).
// Prints one JSON object of what each public reader saw.
import { mock, setSystemTime } from 'bun:test';
import * as fs from 'node:fs';
import * as fsp from 'node:fs/promises';
import { join } from 'node:path';
import { z } from 'zod';

const [root] = process.argv.slice(2);
if (!root) throw new Error('Expected a scratch directory');

/** The stamp every stat reports while set: nanoseconds since the epoch. */
let frozenNs: bigint | null = null;

function frozen<S extends object>(info: S): S {
  if (frozenNs === null) return info;
  const ns = frozenNs;
  const ms = Number(ns / 1_000_000n);
  const big = typeof Reflect.get(info, 'mtimeNs') === 'bigint';
  return Object.create(info, {
    mtimeMs: { value: big ? BigInt(ms) : ms },
    ctimeMs: { value: big ? BigInt(ms) : ms },
    ...(big && { mtimeNs: { value: ns }, ctimeNs: { value: ns } }),
  });
}

const realStatSync = fs.statSync;
const realLstatSync = fs.lstatSync;
const realFstatSync = fs.fstatSync;
const realStat = fsp.stat;
const realLstat = fsp.lstat;
const realOpen = fsp.open;
mock.module('node:fs', () => ({
  ...fs,
  statSync: (...args: Parameters<typeof fs.statSync>) => {
    const info = realStatSync(...args);
    return info === undefined ? info : frozen(info);
  },
  lstatSync: (...args: Parameters<typeof fs.lstatSync>) => {
    const info = realLstatSync(...args);
    return info === undefined ? info : frozen(info);
  },
  fstatSync: (...args: Parameters<typeof fs.fstatSync>) => {
    const info = realFstatSync(...args);
    return info === undefined ? info : frozen(info);
  },
}));
mock.module('node:fs/promises', () => ({
  ...fsp,
  stat: async (...args: Parameters<typeof fsp.stat>) => {
    const info = await realStat(...args);
    return info === undefined ? info : frozen(info);
  },
  lstat: async (...args: Parameters<typeof fsp.lstat>) => frozen(await realLstat(...args)),
  open: async (...args: Parameters<typeof fsp.open>) => {
    const handle = await realOpen(...args);
    const stat = handle.stat.bind(handle);
    // The handle's `stat` is overloaded on `bigint`; the wrapper answers both the same way.
    handle.stat = (async (options?: fs.StatOptions) =>
      frozen(await stat(options))) as typeof handle.stat;
    return handle;
  },
}));

const { PolledJsonFile, PolledJsonFiles } = await import('../../src/entrypoints/files');
const { createPolledJsonConfigSource } = await import('../../src/entrypoints/service-host');

const schema = z.object({ v: z.number() });
const nowNs = () => BigInt(Date.now()) * 1_000_000n;
const write = (path: string, v: number) => fs.writeFileSync(path, JSON.stringify({ v }));
const seenValue = (reading: { state: string; value?: { v: number } } | null) =>
  reading === null
    ? null
    : reading.state === 'read'
      ? (reading.value?.v ?? null)
      : reading.state;

const result: Record<string, unknown> = {};

// 1. A same-length rewrite in the tick of the first read.
{
  const path = join(root, 'sync.json');
  write(path, 1);
  frozenNs = nowNs();
  const file = new PolledJsonFile(path, schema);
  const first = seenValue(file.readChanged());
  write(path, 2);
  const second = seenValue(file.readChanged());
  write(path, 3);
  const third = seenValue(file.read());
  result.sync = [first, second, third];
}

// 2. The same through the asynchronous set refresh.
{
  const path = join(root, 'async.json');
  write(path, 1);
  frozenNs = nowNs();
  const files = new PolledJsonFiles(schema);
  const first = (await files.refreshAsync([{ path }])).map((change) =>
    change.kind === 'changed' ? seenValue(change.reading) : change.kind,
  );
  write(path, 2);
  const second = (await files.refreshAsync([{ path }])).map((change) =>
    change.kind === 'changed' ? seenValue(change.reading) : change.kind,
  );
  result.async = [first, second];
}

// 3. The config source a reloader polls.
{
  const path = join(root, 'config.json');
  write(path, 1);
  frozenNs = nowNs();
  const source = createPolledJsonConfigSource({ path, schema });
  const first = await source.read();
  write(path, 2);
  const second = await source.read();
  result.config = [first, second].map((reading) =>
    reading.state === 'valid' ? reading.config.v : reading.state,
  );
}

// 4. Bytes are read again only while the stamp is as young as the read: a file last changed
// long before it was read, or read again once its stamp is old, is answered from metadata.
{
  let reads = 0;
  const accept = () => {
    reads += 1;
    return true as const;
  };
  const oldPath = join(root, 'old.json');
  write(oldPath, 1);
  frozenNs = nowNs() - 3_600_000_000_000n;
  const old = new PolledJsonFile(oldPath, schema, { accept });
  old.readChanged();
  for (let poll = 0; poll < 5; poll += 1) old.readChanged();
  const oldReads = reads;

  reads = 0;
  const youngPath = join(root, 'young.json');
  write(youngPath, 1);
  frozenNs = nowNs();
  const young = new PolledJsonFile(youngPath, schema, { accept });
  young.readChanged();
  const youngPolls = [young.readChanged(), young.readChanged()].map(seenValue);
  const youngReads = reads;
  setSystemTime(new Date(Date.now() + 60_000));
  young.readChanged();
  const settlingReads = reads;
  for (let poll = 0; poll < 5; poll += 1) young.readChanged();
  setSystemTime();
  result.reads = { oldReads, youngPolls, youngReads, settlingReads, settledReads: reads };
}

frozenNs = null;
console.log(JSON.stringify(result));
