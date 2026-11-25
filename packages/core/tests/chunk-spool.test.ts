/**
 * `createChunkSpool` on its own: every refusal is a typed 4xx `AppError`, a
 * repeated call is idempotent, the first writer of a part wins a race, and
 * nothing is assembled until every part is in.
 */
import { afterAll, describe, expect, test } from 'bun:test';
import { mkdtempSync, readdirSync, rmSync, statSync, utimesSync } from 'node:fs';
import { open, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { z } from 'zod';
import { AppError } from '../src/contract/errors';
import {
  CHUNK_SPOOL_ERROR_CODES,
  createChunkSpool,
  createChunkSpoolWith,
  isChunkSpoolErrorCode,
} from '../src/files/chunk-spool';

const root = mkdtempSync(join(tmpdir(), 'sk-spool-'));
afterAll(() => rmSync(root, { recursive: true, force: true }));
let spools = 0;

function makeSpool(staleAfterMs?: number) {
  spools += 1;
  const directory = join(root, String(spools));
  return {
    directory,
    spool: createChunkSpool({
      directory,
      chunkBytes: 4,
      maxFileBytes: 64,
      meta: z.object({ name: z.string() }),
      ...(staleAfterMs !== undefined && { staleAfterMs }),
    }),
  };
}

const key = { owner: 'u1', uploadId: 'up-1' };
const opening = { ...key, totalBytes: 10, chunkCount: 3, meta: { name: 'a.bin' } };
const part = (index: number, text: string) => ({ ...key, index, bytes: new Blob([text]) });

async function refusal(promise: Promise<unknown>): Promise<[string, number]> {
  const error = await promise.then(
    () => undefined,
    (reason: unknown) => reason,
  );
  if (!(error instanceof AppError))
    throw new Error(`expected an AppError, got ${String(error)}`);
  return [error.code, error.status];
}

describe('error codes', () => {
  test('every refusal code is listed and recognised; others are not', () => {
    expect([...CHUNK_SPOOL_ERROR_CODES].sort()).toEqual([
      'UPLOAD_CHUNK_OUT_OF_RANGE',
      'UPLOAD_CHUNK_SIZE',
      'UPLOAD_CONFLICT',
      'UPLOAD_INCOMPLETE',
      'UPLOAD_INVALID',
      'UPLOAD_NOT_FOUND',
      'UPLOAD_TOO_LARGE',
    ]);
    expect(Object.isFrozen(CHUNK_SPOOL_ERROR_CODES)).toBe(true);
    expect(isChunkSpoolErrorCode('UPLOAD_CONFLICT')).toBe(true);
    expect(isChunkSpoolErrorCode('NOT_FOUND')).toBe(false);
    expect(isChunkSpoolErrorCode('toString')).toBe(false);
  });

  test('a real refusal carries a listed code', async () => {
    const { spool } = makeSpool();
    const [code] = await refusal(spool.put(part(0, 'abcd')));
    expect(isChunkSpoolErrorCode(code)).toBe(true);
  });
});

describe('open', () => {
  test('the same declaration again reopens; another one conflicts', async () => {
    const { spool } = makeSpool();
    expect(await spool.open(opening)).toBe('opened');
    expect(await spool.open(opening)).toBe('reopened');
    expect(await refusal(spool.open({ ...opening, meta: { name: 'b.bin' } }))).toEqual([
      'UPLOAD_CONFLICT',
      409,
    ]);
  });

  test('a declaration that does not add up is refused', async () => {
    const { spool } = makeSpool();
    expect(await refusal(spool.open({ ...opening, chunkCount: 2 }))).toEqual([
      'UPLOAD_INVALID',
      400,
    ]);
    expect(await refusal(spool.open({ ...opening, totalBytes: 65, chunkCount: 17 }))).toEqual([
      'UPLOAD_TOO_LARGE',
      413,
    ]);
    expect(await refusal(spool.open({ ...opening, uploadId: '../x' }))).toEqual([
      'UPLOAD_INVALID',
      400,
    ]);
    expect(await refusal(spool.open({ ...opening, totalBytes: 0, chunkCount: 0 }))).toEqual([
      'UPLOAD_INVALID',
      400,
    ]);
  });

  test('the same upload id from another owner is another upload', async () => {
    const { spool } = makeSpool();
    await spool.open(opening);
    expect(await spool.open({ ...opening, owner: 'u2', meta: { name: 'other' } })).toBe(
      'opened',
    );
  });
});

describe('put', () => {
  test('a part before open, out of range or of the wrong size is refused', async () => {
    const { spool } = makeSpool();
    expect(await refusal(spool.put(part(0, 'abcd')))).toEqual(['UPLOAD_NOT_FOUND', 404]);
    await spool.open(opening);
    expect(await refusal(spool.put(part(3, 'ab')))).toEqual([
      'UPLOAD_CHUNK_OUT_OF_RANGE',
      400,
    ]);
    expect(await refusal(spool.put(part(0, 'abc')))).toEqual(['UPLOAD_CHUNK_SIZE', 400]);
    expect(await refusal(spool.put(part(2, 'abcd')))).toEqual(['UPLOAD_CHUNK_SIZE', 400]);
  });

  test('the same bytes again are repeated; other bytes conflict and leave the first', async () => {
    const { spool } = makeSpool();
    await spool.open(opening);
    expect(await spool.put(part(0, 'abcd'))).toBe('stored');
    expect(await spool.put(part(0, 'abcd'))).toBe('repeated');
    expect(await refusal(spool.put(part(0, 'wxyz')))).toEqual(['UPLOAD_CONFLICT', 409]);
    await spool.put(part(1, 'efgh'));
    await spool.put(part(2, 'ij'));
    const assembled = await spool.assemble(key);
    expect(await new Response(assembled.stream()).text()).toBe('abcdefghij');
  });

  test('eight racing writers of one part: one stores, the same bytes repeat', async () => {
    const { spool } = makeSpool();
    await spool.open(opening);
    const states = await Promise.all(
      Array.from({ length: 8 }, () => spool.put(part(1, 'efgh'))),
    );
    expect(states.filter((state) => state === 'stored')).toHaveLength(1);
    expect(states.filter((state) => state === 'repeated')).toHaveLength(7);
  });

  test('eight racing writers of different bytes: exactly one wins, and its bytes stay', async () => {
    const { spool, directory } = makeSpool();
    await spool.open(opening);
    const texts = ['aaaa', 'bbbb', 'cccc', 'dddd', 'eeee', 'ffff', 'gggg', 'hhhh'];
    const results = await Promise.all(
      texts.map((text) =>
        spool.put(part(0, text)).then(
          (state) => ({ text, state }),
          (error: unknown) => ({
            text,
            state: error instanceof AppError ? error.code : 'crash',
          }),
        ),
      ),
    );
    const winners = results.filter((result) => result.state === 'stored');
    expect(winners).toHaveLength(1);
    expect(results.filter((result) => result.state === 'UPLOAD_CONFLICT')).toHaveLength(7);
    await spool.put(part(1, 'efgh'));
    await spool.put(part(2, 'ij'));
    const assembled = await spool.assemble(key);
    expect(await new Response(assembled.stream()).text()).toBe(`${winners[0]?.text}efghij`);
    // No loser's bytes and no staging file stay behind.
    const [uploadDir] = readdirSync(directory);
    const files = readdirSync(join(directory, uploadDir ?? ''));
    expect(
      files.filter((name) => name.startsWith('0.') && name.endsWith('.part')),
    ).toHaveLength(1);
    expect(files.filter((name) => name.endsWith('.tmp'))).toHaveLength(0);
  });
});

describe('assemble, discard and sweep', () => {
  test('a missing part is named and nothing is assembled', async () => {
    const { spool } = makeSpool();
    await spool.open(opening);
    await spool.put(part(0, 'abcd'));
    await spool.put(part(2, 'ij'));
    const error = await spool.assemble(key).catch((reason: unknown) => reason);
    expect(error instanceof AppError && [error.code, error.status, error.details]).toEqual([
      'UPLOAD_INCOMPLETE',
      409,
      { index: 1, chunkCount: 3 },
    ]);
  });

  test('assembly hands back the parsed meta and the parts in order', async () => {
    const { spool } = makeSpool();
    await spool.open(opening);
    for (const [index, text] of ['abcd', 'efgh', 'ij'].entries())
      await spool.put(part(index, text));
    const assembled = await spool.assemble(key);
    expect(assembled.meta).toEqual({ name: 'a.bin' });
    expect(assembled.totalBytes).toBe(10);
    expect(assembled.chunkPaths).toHaveLength(3);
    await spool.discard(key);
    expect(await refusal(spool.assemble(key))).toEqual(['UPLOAD_NOT_FOUND', 404]);
  });

  test('sweep removes an upload untouched past its age and keeps a fresh one', async () => {
    const { spool, directory } = makeSpool(60_000);
    expect(await spool.sweep()).toBe(0);
    await spool.open(opening);
    await spool.open({ ...opening, uploadId: 'fresh' });
    const [first, second] = readdirSync(directory);
    const old = new Date(Date.now() - 120_000);
    utimesSync(join(directory, first ?? ''), old, old);
    expect(await spool.sweep()).toBe(1);
    expect(readdirSync(directory)).toEqual([second ?? '']);
  });

  test('sweep skips an entry that vanishes mid-loop (ENOENT) and continues sweeping remaining stale uploads', async () => {
    spools += 1;
    const directory = join(root, String(spools));
    let vanishedDir: string | undefined;
    let enoentHits = 0;

    const spool = createChunkSpoolWith(
      {
        directory,
        chunkBytes: 4,
        maxFileBytes: 64,
        meta: z.object({ name: z.string() }),
        staleAfterMs: 0,
      },
      {
        async stat(target) {
          if (target === vanishedDir) {
            await rm(target, { recursive: true, force: true });
            try {
              return await stat(target);
            } catch (error) {
              enoentHits += 1;
              throw error;
            }
          }
          return stat(target);
        },
      },
    );

    await spool.open({ ...opening, uploadId: 'vanishing' });
    await spool.open({ ...opening, uploadId: 'still-stale' });
    const entries = readdirSync(directory);
    expect(entries).toHaveLength(2);
    const old = new Date(Date.now() - 10_000);
    for (const entry of entries) utimesSync(join(directory, entry), old, old);
    vanishedDir = join(directory, entries[0] ?? '');

    expect(await spool.sweep()).toBe(1);
    expect(enoentHits).toBe(1);
    expect(readdirSync(directory)).toEqual([]);
  });

  test('sweep rejects when stat fails with a non-ENOENT error (EACCES)', async () => {
    spools += 1;
    const directory = join(root, String(spools));
    const permissionDenied = Object.assign(new Error('permission denied'), { code: 'EACCES' });

    const spool = createChunkSpoolWith(
      {
        directory,
        chunkBytes: 4,
        maxFileBytes: 64,
        meta: z.object({ name: z.string() }),
        staleAfterMs: 0,
      },
      {
        async stat() {
          throw permissionDenied;
        },
      },
    );

    await spool.open(opening);
    await expect(spool.sweep()).rejects.toBe(permissionDenied);
  });

  test('assembled stream closes the open FileHandle when handle.read throws EIO', async () => {
    spools += 1;
    const directory = join(root, String(spools));
    const readError = Object.assign(new Error('disk I/O failure'), { code: 'EIO' });
    let openCount = 0;
    let closeCount = 0;

    const spool = createChunkSpoolWith(
      {
        directory,
        chunkBytes: 4,
        maxFileBytes: 64,
        meta: z.object({ name: z.string() }),
      },
      {
        async open(target, flags) {
          openCount += 1;
          const handle = await open(target, flags);
          return {
            async read() {
              throw readError;
            },
            async close() {
              closeCount += 1;
              await handle.close();
            },
          };
        },
      },
    );

    await spool.open(opening);
    for (const [index, text] of ['abcd', 'efgh', 'ij'].entries()) {
      await spool.put(part(index, text));
    }

    const assembled = await spool.assemble(key);
    const reader = assembled.stream().getReader();
    await expect(reader.read()).rejects.toBe(readError);
    expect(openCount).toBe(1);
    expect(closeCount).toBe(1);
  });
});

describe('config validation and private file mode', () => {
  test('refuses invalid maxFileBytes and staleAfterMs while allowing staleAfterMs: 0', () => {
    const base = {
      directory: join(root, 'config-validation'),
      chunkBytes: 4,
      maxFileBytes: 64,
      meta: z.object({ name: z.string() }),
    };

    for (const badMax of [
      0,
      -1,
      1.5,
      Number.NaN,
      Number.POSITIVE_INFINITY,
      Number.MAX_SAFE_INTEGER + 1,
    ]) {
      expect(() => createChunkSpool({ ...base, maxFileBytes: badMax })).toThrow(TypeError);
    }

    for (const badStale of [
      -1,
      1.5,
      Number.NaN,
      Number.POSITIVE_INFINITY,
      Number.NEGATIVE_INFINITY,
      Number.MAX_SAFE_INTEGER + 1,
    ]) {
      expect(() => createChunkSpool({ ...base, staleAfterMs: badStale })).toThrow(TypeError);
    }

    expect(() => createChunkSpool({ ...base, staleAfterMs: 0 })).not.toThrow();
  });

  test('publishes declaration, part and receipt files with 0600 permissions', async () => {
    if (process.platform === 'win32') return;
    const { spool, directory } = makeSpool();
    await spool.open(opening);
    await spool.put(part(0, 'abcd'));
    const [uploadDir] = readdirSync(directory);
    const fullDir = join(directory, uploadDir ?? '');
    const files = readdirSync(fullDir);
    expect(files.length).toBeGreaterThanOrEqual(3);
    for (const name of files) {
      expect(statSync(join(fullDir, name)).mode & 0o777).toBe(0o600);
    }
  });
});
