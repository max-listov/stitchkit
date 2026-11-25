import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { spawnSync } from 'node:child_process';
import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  renameSync,
  rmSync,
  symlinkSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { z } from 'zod';
import {
  type JsonFileReading,
  MAX_POLLED_JSON_CACHE_BYTES,
  MAX_POLLED_JSON_PATHS,
  PolledJsonFile,
  PolledJsonFiles,
  readJsonOnce,
} from '../src/entrypoints/files';

let root: string;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'stitchkit-polled-json-'));
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

const ConfigSchema = z.strictObject({
  version: z.number().int(),
  label: z.string(),
});
type Config = z.infer<typeof ConfigSchema>;

describe('readJsonOnce', () => {
  test('classifies missing, unreadable, invalid and read states accurately', () => {
    const missing = join(root, 'missing.json');
    expect(readJsonOnce(missing, ConfigSchema)).toEqual({ state: 'missing' });

    const dir = join(root, 'dir');
    mkdirSync(dir);
    const dirReading = readJsonOnce(dir, ConfigSchema);
    expect(dirReading.state).toBe('unreadable');
    if (dirReading.state === 'unreadable') expect(dirReading.detail.length).toBeGreaterThan(0);

    const fifo = join(root, 'pipe.fifo');
    expect(spawnSync('mkfifo', [fifo]).status).toBe(0);
    expect(readJsonOnce(fifo, ConfigSchema).state).toBe('unreadable');

    const badUtf8 = join(root, 'bad-utf8.json');
    // Valid JSON framing with invalid UTF-8 bytes inside the string value:
    // only strict UTF-8 decoding rejects it (non-fatal decoding would emit U+FFFD).
    writeFileSync(
      badUtf8,
      new Uint8Array([
        ...new TextEncoder().encode('{"version":1,"label":"'),
        0xff,
        0xfe,
        ...new TextEncoder().encode('"}'),
      ]),
    );
    expect(readJsonOnce(badUtf8, ConfigSchema)).toMatchObject({
      state: 'invalid',
      reason: 'encoding',
    });

    const badJson = join(root, 'bad.json');
    writeFileSync(badJson, '{not-json');
    expect(readJsonOnce(badJson, ConfigSchema)).toMatchObject({
      state: 'invalid',
      reason: 'syntax',
    });

    const badSchema = join(root, 'bad-schema.json');
    writeFileSync(badSchema, '{"version":"nope","label":"x"}');
    const schemaReading = readJsonOnce(badSchema, ConfigSchema);
    expect(schemaReading).toMatchObject({ state: 'invalid', reason: 'schema' });
    if (schemaReading.state === 'invalid') expect(schemaReading.detail).toContain('version');

    const tooBig = join(root, 'big.json');
    writeFileSync(tooBig, '{"version":1,"label":"abcdef"}');
    expect(readJsonOnce(tooBig, ConfigSchema, { limit: 10 })).toMatchObject({
      state: 'unreadable',
      reason: 'too-large',
    });

    const valid = join(root, 'valid.json');
    const text = '{"version":1,"label":"ok"}';
    writeFileSync(valid, text);
    const ok: JsonFileReading<Config> = readJsonOnce(valid, ConfigSchema);
    expect(ok).toEqual({ state: 'read', text, value: { version: 1, label: 'ok' } });
  });
});

describe('PolledJsonFile', () => {
  test('caches unchanged reads and returns null from readChanged when unchanged', () => {
    const file = join(root, 'state.json');
    let parseCalls = 0;
    const countingSchema = {
      safeParse: (input: unknown) => {
        parseCalls += 1;
        return ConfigSchema.safeParse(input);
      },
    };
    const polled = new PolledJsonFile(file, countingSchema);

    // Missing -> unchanged missing -> created -> unchanged -> rewritten identical -> changed
    expect(polled.readChanged()).toEqual({ state: 'missing' });
    expect(polled.readChanged()).toBeNull();

    writeFileSync(file, '{"version":1,"label":"a"}');
    const first = polled.readChanged();
    expect(first).toEqual({
      state: 'read',
      text: '{"version":1,"label":"a"}',
      value: { version: 1, label: 'a' },
    });
    expect(parseCalls).toBe(1);

    // Repeated reads hit cache without re-parsing
    expect(first).not.toBeNull();
    if (first !== null) expect(polled.read()).toEqual(first);
    expect(polled.readChanged()).toBeNull();
    expect(parseCalls).toBe(1);

    // Rewrite with identical bytes (new mtime/inode) does not report change or re-parse
    const temp = join(root, 'state.tmp');
    writeFileSync(temp, '{"version":1,"label":"a"}');
    rmSync(file);
    writeFileSync(file, '{"version":1,"label":"a"}');
    rmSync(temp);
    expect(polled.readChanged()).toBeNull();
    expect(parseCalls).toBe(1);

    // Actual content change triggers re-parse and returns new reading
    writeFileSync(file, '{"version":2,"label":"b"}');
    const second = polled.readChanged();
    expect(second).toEqual({
      state: 'read',
      text: '{"version":2,"label":"b"}',
      value: { version: 2, label: 'b' },
    });
    expect(parseCalls).toBe(2);

    // Corrupt -> invalid -> unchanged invalid -> different invalid -> repaired read -> clear() -> deleted -> missing
    writeFileSync(file, '{broken');
    const corrupted = polled.readChanged();
    expect(corrupted).toMatchObject({ state: 'invalid', reason: 'syntax' });
    expect(polled.readChanged()).toBeNull();

    // Rewrite with a DIFFERENT error (schema mismatch instead of syntax error) -> reports the new reason
    writeFileSync(file, '{"version":"bad-type","label":"x"}');
    const schemaBroken = polled.readChanged();
    expect(schemaBroken).toMatchObject({ state: 'invalid', reason: 'schema' });
    if (schemaBroken?.state === 'invalid') expect(schemaBroken.detail).toContain('version');
    expect(polled.readChanged()).toBeNull();

    // invalid -> read transition
    writeFileSync(file, '{"version":3,"label":"repaired"}');
    const repaired = polled.readChanged();
    expect(repaired).toEqual({
      state: 'read',
      text: '{"version":3,"label":"repaired"}',
      value: { version: 3, label: 'repaired' },
    });
    expect(polled.readChanged()).toBeNull();
    expect(polled.cachedBytes).toBeGreaterThan(0);

    // clear() drops cache so next readChanged() reloads from disk
    polled.clear();
    expect(polled.cachedBytes).toBe(0);
    expect(polled.readChanged()).toEqual(repaired);

    unlinkSync(file);
    expect(polled.readChanged()).toEqual({ state: 'missing' });
    expect(polled.readChanged()).toBeNull();
  });

  test('respects maxCacheBytes bound and never caches oversized payloads', () => {
    expect(Number.isSafeInteger(MAX_POLLED_JSON_CACHE_BYTES)).toBe(true);
    expect(MAX_POLLED_JSON_CACHE_BYTES).toBeGreaterThan(0);

    const file = join(root, 'over-cache.json');
    const payload = JSON.stringify({ version: 1, label: 'a'.repeat(120) });
    writeFileSync(file, payload);

    let parseCalls = 0;
    const countingSchema = {
      safeParse: (input: unknown) => {
        parseCalls += 1;
        return ConfigSchema.safeParse(input);
      },
    };
    const polled = new PolledJsonFile(file, countingSchema, {
      limit: 4096,
      maxCacheBytes: 64,
    });

    const first = polled.readChanged();
    expect(first?.state).toBe('read');
    expect(polled.cachedBytes).toBe(0);
    expect(parseCalls).toBe(1);

    // Unchanged check still returns null without retaining the payload bytes
    expect(polled.readChanged()).toBeNull();
    // Explicit read() re-parses because the payload exceeded maxCacheBytes
    const reread = polled.read();
    expect(reread.state).toBe('read');
    expect(polled.cachedBytes).toBe(0);
    expect(parseCalls).toBe(2);
  });
});

describe('PolledJsonFiles', () => {
  test('tracks multiple files with LRU bounded cache and supports refresh/delete/clear', () => {
    const fileA = join(root, 'a.json');
    const fileB = join(root, 'b.json');
    const fileC = join(root, 'c.json');
    const payloadA = JSON.stringify({ version: 1, label: 'aaaaaaaaaa' });
    const payloadB = JSON.stringify({ version: 2, label: 'bbbbbbbbbb' });
    const payloadC = JSON.stringify({ version: 3, label: 'cccccccccc' });
    writeFileSync(fileA, payloadA);
    writeFileSync(fileB, payloadB);
    writeFileSync(fileC, payloadC);

    const sizeEach = Buffer.byteLength(payloadA);
    // Allow at most 2 cached payloads simultaneously
    const maxCacheBytes = sizeEach * 2 + 4;

    let parseCalls = 0;
    const countingSchema = {
      safeParse: (input: unknown) => {
        parseCalls += 1;
        return ConfigSchema.safeParse(input);
      },
    };
    const polled = new PolledJsonFiles(countingSchema, { limit: 4096, maxCacheBytes });

    expect(polled.readChanged(fileA)?.state).toBe('read');
    expect(polled.readChanged(fileB)?.state).toBe('read');
    expect(parseCalls).toBe(2);
    expect(polled.cachedBytes).toBeLessThanOrEqual(maxCacheBytes);

    // Touch A so B becomes LRU
    expect(polled.read(fileA).state).toBe('read');
    expect(parseCalls).toBe(2);

    // Reading C evicts B's cached payload to stay within maxCacheBytes
    expect(polled.readChanged(fileC)?.state).toBe('read');
    expect(parseCalls).toBe(3);
    expect(polled.cachedBytes).toBeLessThanOrEqual(maxCacheBytes);

    // A is still cached (no re-parse), B was evicted (re-parses on read)
    expect(polled.read(fileA).state).toBe('read');
    expect(parseCalls).toBe(3);
    expect(polled.read(fileB).state).toBe('read');
    expect(parseCalls).toBe(4);
    expect(polled.cachedBytes).toBeLessThanOrEqual(maxCacheBytes);

    // refresh drops everything outside the set, each with a removed change
    const pruned = polled.refresh([{ path: fileB }]);
    expect(pruned.map((change) => change.kind)).toEqual(['removed', 'removed']);
    expect(new Set(pruned.map((change) => change.path))).toEqual(new Set([fileA, fileC]));
    expect(polled.size).toBe(1);
    expect(polled.delete(fileB)).toBe(true);
    expect(polled.size).toBe(0);
    expect(polled.cachedBytes).toBe(0);

    polled.read(fileA);
    expect(polled.size).toBe(1);
    polled.clear();
    expect(polled.size).toBe(0);
    expect(polled.cachedBytes).toBe(0);
  });

  test('refresh reports a new path, a state change and a path that left the set', () => {
    const fileA = join(root, 'a.json');
    const fileB = join(root, 'b.json');
    writeFileSync(fileA, JSON.stringify({ version: 1, label: 'a' }));
    const polled = new PolledJsonFiles(ConfigSchema);

    const both = [{ path: fileA }, { path: fileB }];
    const first = polled.refresh(both);
    expect(first).toEqual([
      {
        kind: 'changed',
        path: fileA,
        reading: {
          state: 'read',
          text: '{"version":1,"label":"a"}',
          value: { version: 1, label: 'a' },
        },
      },
      { kind: 'changed', path: fileB, reading: { state: 'missing' } },
    ]);
    expect(polled.refresh(both)).toEqual([]);

    writeFileSync(fileB, JSON.stringify({ version: 2, label: 'b' }));
    unlinkSync(fileA);
    const second = polled.refresh(both);
    expect(second.map((change) => [change.kind, change.path])).toEqual([
      ['changed', fileA],
      ['changed', fileB],
    ]);

    expect(polled.refresh([{ path: fileA }])).toEqual([{ kind: 'removed', path: fileB }]);
    expect(polled.size).toBe(1);
    expect(polled.refresh([])).toEqual([{ kind: 'removed', path: fileA }]);
    expect(polled.size).toBe(0);
  });

  test('the byte limit applies to every polled read', () => {
    const file = join(root, 'big.json');
    writeFileSync(file, JSON.stringify({ version: 1, label: 'x'.repeat(64) }));
    const bounded = new PolledJsonFiles(ConfigSchema, { limit: 32 });
    const reading = bounded.read(file);
    expect(reading.state).toBe('unreadable');
    expect(reading.state === 'unreadable' && reading.detail).toMatch(/32-byte limit/);
    expect(new PolledJsonFiles(ConfigSchema).read(file).state).toBe('read');
  });

  test('refresh refuses a set larger than the tracked bound instead of evicting', () => {
    const polled = new PolledJsonFiles(ConfigSchema);
    const paths = Array.from({ length: MAX_POLLED_JSON_PATHS + 1 }, (_, i) => ({
      path: join(root, `${i}.json`),
    }));
    expect(() => polled.refresh(paths)).toThrow(RangeError);
    expect(polled.size).toBe(0);
  });

  test('noFollow refuses a symlink, including one that points at the inode already cached', () => {
    const dir = join(root, 'conf.d');
    const old = join(root, 'conf.d.old');
    mkdirSync(dir);
    const file = join(dir, 'decl.json');
    writeFileSync(file, JSON.stringify({ version: 1, label: 'x' }));
    const strict = new PolledJsonFiles(ConfigSchema, { noFollow: true });
    const loose = new PolledJsonFiles(ConfigSchema);
    expect(strict.read(file).state).toBe('read');
    expect(loose.read(file).state).toBe('read');

    // Swap the directory, not the file: the file's inode and times stay exactly as
    // cached, and the path now reaches it through a symbolic link.
    renameSync(dir, old);
    mkdirSync(dir);
    symlinkSync(join(old, 'decl.json'), file);
    expect(strict.read(file)).toMatchObject({ state: 'unreadable', reason: 'symbolic-link' });
    expect(loose.read(file).state).toBe('read');
  });

  test('a schema that throws is an invalid file, and refresh still reports what left the set', () => {
    const good = join(root, 'good.json');
    const bad = join(root, 'bad.json');
    writeFileSync(good, JSON.stringify({ version: 1, label: 'g' }));
    writeFileSync(bad, JSON.stringify({ version: 2, label: 'boom' }));
    const throwing = {
      safeParse: (input: unknown) => {
        const parsed = ConfigSchema.safeParse(input);
        if (parsed.success && parsed.data.label === 'boom')
          throw new Error('transform failed');
        return parsed;
      },
    };
    const polled = new PolledJsonFiles(throwing);
    expect(polled.refresh([{ path: good }])).toHaveLength(1);
    const changes = polled.refresh([{ path: bad }]);
    expect(changes).toEqual([
      { kind: 'removed', path: good },
      {
        kind: 'changed',
        path: bad,
        reading: {
          state: 'invalid',
          reason: 'schema',
          detail: 'Schema validation failed: transform failed',
        },
      },
    ]);
  });

  test('a new path beyond the tracked bound is refused by read too, and nothing is evicted', () => {
    const polled = new PolledJsonFiles(ConfigSchema);
    const paths = Array.from({ length: MAX_POLLED_JSON_PATHS }, (_, i) =>
      join(root, `${i}.json`),
    );
    polled.refresh(paths.map((path) => ({ path })));
    expect(polled.size).toBe(MAX_POLLED_JSON_PATHS);
    expect(() => polled.read(join(root, 'one-more.json'))).toThrow(RangeError);
    expect(polled.size).toBe(MAX_POLLED_JSON_PATHS);
    expect(polled.read(paths[0] ?? '').state).toBe('missing');
  });

  test('readJsonOnce and PolledJsonFile take noFollow and accept too', () => {
    const file = join(root, 'single.json');
    const link = join(root, 'single-link.json');
    writeFileSync(file, JSON.stringify({ version: 1, label: 's' }));
    symlinkSync(file, link);
    expect(readJsonOnce(link, ConfigSchema, { noFollow: true })).toMatchObject({
      state: 'unreadable',
      reason: 'symbolic-link',
    });
    expect(readJsonOnce(file, ConfigSchema, { accept: () => false })).toMatchObject({
      state: 'unreadable',
      reason: 'rejected',
    });
    expect(new PolledJsonFile(link, ConfigSchema, { noFollow: true }).read()).toMatchObject({
      state: 'unreadable',
      reason: 'symbolic-link',
    });
    expect(new PolledJsonFile(file, ConfigSchema, { accept: () => true }).read().state).toBe(
      'read',
    );
  });

  test('accept runs on every real read and its refusal is an unreadable reading', () => {
    const file = join(root, 'owned.json');
    writeFileSync(file, JSON.stringify({ version: 1, label: 'x' }), { mode: 0o600 });
    const seen: number[] = [];
    const polled = new PolledJsonFiles(ConfigSchema, {
      accept: (info) => {
        seen.push(info.mode & 0o777);
        return (info.mode & 0o022) === 0;
      },
    });
    expect(polled.read(file).state).toBe('read');
    chmodSync(file, 0o666);
    const refused = polled.read(file);
    expect(refused.state).toBe('unreadable');
    expect(refused.state === 'unreadable' && refused.detail).toMatch(/metadata check/);
    expect(seen).toEqual([0o600, 0o666]);
  });
});

describe('bytes that are not the value, and a set read with its own options per path', () => {
  const entries = (...paths: string[]) => paths.map((path) => ({ path }));

  test('broken JSON, malformed UTF-8, a schema mismatch and __proto__ are invalid with a reason, and a refused file is unreadable', () => {
    const cases: Array<[string, string | Uint8Array, string]> = [
      ['syntax', '{"version":', 'syntax'],
      [
        'utf8',
        new Uint8Array([0x7b, 0x22, 0x61, 0x22, 0x3a, 0x22, 0xff, 0x22, 0x7d]),
        'encoding',
      ],
      ['schema', '{"version":1}', 'schema'],
      ['proto', '{"version":1,"label":"x","__proto__":{"polluted":true}}', 'syntax'],
    ];
    const polled = new PolledJsonFiles(ConfigSchema);
    for (const [name, body, reason] of cases) {
      const file = join(root, `${name}.json`);
      writeFileSync(file, body);
      expect([name, readJsonOnce(file, ConfigSchema)]).toMatchObject([
        name,
        { state: 'invalid', reason },
      ]);
      expect([name, polled.read(file)]).toMatchObject([name, { state: 'invalid', reason }]);
      // The same invalid bytes again are no change.
      expect(polled.readChanged(file)).toBeNull();
    }
    const dir = join(root, 'dir.json');
    mkdirSync(dir);
    expect(readJsonOnce(dir, ConfigSchema)).toMatchObject({
      state: 'unreadable',
      reason: 'not-regular',
    });
    expect(polled.read(dir)).toMatchObject({ state: 'unreadable', reason: 'not-regular' });
  });

  test('one set reads each path with its own options, and new options for a path read it again', () => {
    const explicitTarget = join(root, 'node.target.json');
    const explicit = join(root, 'node.json');
    const dropIn = join(root, 'conf.d-10.json');
    writeFileSync(explicitTarget, JSON.stringify({ version: 1, label: 'node' }));
    symlinkSync(explicitTarget, explicit);
    symlinkSync(explicitTarget, dropIn);
    const polled = new PolledJsonFiles(ConfigSchema);
    const strict = { noFollow: true, accept: () => true };
    const changes = polled.refresh([{ path: explicit }, { path: dropIn, options: strict }]);
    expect(
      changes.map((change) => [change.path, change.kind === 'changed' && change.reading]),
    ).toEqual([
      [
        explicit,
        {
          state: 'read',
          text: '{"version":1,"label":"node"}',
          value: { version: 1, label: 'node' },
        },
      ],
      [dropIn, expect.objectContaining({ state: 'unreadable', reason: 'symbolic-link' })],
    ]);
    expect(polled.refresh([{ path: explicit }, { path: dropIn, options: strict }])).toEqual(
      [],
    );
    // Same file, same identity: the new accept must still run rather than reuse the cache.
    const refused = polled.refresh([
      { path: explicit, options: { accept: () => false } },
      { path: dropIn, options: strict },
    ]);
    expect(refused).toEqual([
      {
        kind: 'changed',
        path: explicit,
        reading: expect.objectContaining({ state: 'unreadable', reason: 'rejected' }),
      },
    ]);
    expect(() =>
      polled.refresh([{ path: explicit }, { path: explicit, options: strict }]),
    ).toThrow(TypeError);
  });

  test('refreshAsync reports what refresh reports, commits nothing when aborted, and refuses overlap', async () => {
    const fileA = join(root, 'a.json');
    const fileB = join(root, 'b.json');
    writeFileSync(fileA, JSON.stringify({ version: 1, label: 'a' }));
    writeFileSync(fileB, '{"version":');
    const sync = new PolledJsonFiles(ConfigSchema);
    const polled = new PolledJsonFiles(ConfigSchema);
    const expected = sync.refresh(entries(fileA, fileB, join(root, 'absent.json')));
    const aborted = new AbortController();
    aborted.abort(new Error('stop'));
    await expect(
      polled.refreshAsync(entries(fileA, fileB), { signal: aborted.signal }),
    ).rejects.toThrow('stop');
    expect(polled.size).toBe(0);
    // Aborted during the read of the last path: that read is not a reading, and nothing is committed.
    const midRead = new AbortController();
    const abortOnRead = {
      accept: () => {
        midRead.abort(new Error('stop mid-read'));
        return true;
      },
    };
    await expect(
      polled.refreshAsync([{ path: fileA }, { path: fileB, options: abortOnRead }], {
        signal: midRead.signal,
      }),
    ).rejects.toThrow('stop mid-read');
    expect(polled.size).toBe(0);
    const running = polled.refreshAsync(entries(fileA, fileB, join(root, 'absent.json')));
    expect(() => polled.refresh(entries(fileA))).toThrow(/refreshAsync/);
    await expect(polled.refreshAsync(entries(fileA))).rejects.toThrow(/refreshAsync/);
    expect(await running).toEqual(expected);
    expect(
      await polled.refreshAsync(entries(fileA, fileB, join(root, 'absent.json'))),
    ).toEqual([]);
    writeFileSync(fileA, JSON.stringify({ version: 2, label: 'a' }));
    expect(await polled.refreshAsync(entries(fileA))).toEqual([
      { kind: 'removed', path: fileB },
      { kind: 'removed', path: join(root, 'absent.json') },
      {
        kind: 'changed',
        path: fileA,
        reading: {
          state: 'read',
          text: '{"version":2,"label":"a"}',
          value: { version: 2, label: 'a' },
        },
      },
    ]);
  });
});
