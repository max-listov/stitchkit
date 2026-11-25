import { expect, test } from 'bun:test';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { errnoOf } from '../src/internal/errno';

/**
 * The system error code of a failed call (`ENOENT`, `EPIPE`, `ERR_MODULE_NOT_FOUND`) is read
 * by `errnoOf` in `internal/errno.ts` and nowhere else: a hand-written `'code' in error`
 * differs from it in what it accepts (an `Error` only, a non-string code, a record) and in
 * what it lets through. The places below read a `code` that is not a system error code; each
 * says what it reads. The list only shrinks.
 */
const NOT_A_SYSTEM_ERROR_CODE: Readonly<Record<string, string>> = {
  'live/watch-client-state.ts':
    'the code a server put on a refused watch acknowledgement, of any type, shown as text',
  'testing/realtime-probe.ts':
    'the code of a realtime rejection or domain error a probe reports, of any type, as text',
  'telegram/not-dispatched.ts':
    "stitchkit's own TELEGRAM_NOT_DISPATCHED marker, recognised across realms and wrappers",
  'agent-runtime/postgres-transactions.ts': 'the Prisma error code (P2010, P2034) of a cause',
  'realtime/rejected-frame.ts': 'the code field of an issue inside a rejected realtime frame',
};

const OWNER = 'internal/errno.ts';
const READS_CODE =
  /'code' in\b|Reflect\.get\([^,()]+,\s*'code'\)|isRecord\((\w+)\) && \1\.code\b/;

function sourceFiles(directory: string): string[] {
  return readdirSync(directory).flatMap((name) => {
    const path = join(directory, name);
    if (statSync(path).isDirectory()) return sourceFiles(path);
    return path.endsWith('.ts') ? [path] : [];
  });
}

test('the pattern finds each hand-written read of a code and none of the reads through errnoOf', () => {
  for (const line of [
    "if (error instanceof Error && 'code' in error) {",
    "const code = typeof error === 'object' && error !== null ? Reflect.get(error, 'code') : undefined;",
    "return isRecord(error) && error.code === 'ENOENT';",
  ]) {
    expect(READS_CODE.test(line), line).toBe(true);
  }
  for (const line of [
    "if (errnoOf(error) === 'ENOENT') return;",
    "const path = Reflect.get(entry, 'path');",
    'return isRecord(error) && other.code;',
  ]) {
    expect(READS_CODE.test(line), line).toBe(false);
  }
});

test('a system error code is read by errnoOf alone; every other code read is listed with its reason', () => {
  const root = join(import.meta.dir, '..', 'src');
  const readers = sourceFiles(root)
    .map((path) => relative(root, path))
    .filter((path) => READS_CODE.test(readFileSync(join(root, path), 'utf8')))
    .filter((path) => path !== OWNER)
    .sort();
  expect(readers).toEqual(Object.keys(NOT_A_SYSTEM_ERROR_CODE).sort());
});

test('errnoOf reads a string code from any object and nothing else', () => {
  expect(errnoOf(Object.assign(new Error('gone'), { code: 'ENOENT' }))).toBe('ENOENT');
  expect(errnoOf({ code: 'EPIPE' })).toBe('EPIPE');
  expect(errnoOf({ code: 13 })).toBeUndefined();
  expect(errnoOf(new Error('no code'))).toBeUndefined();
  expect(errnoOf('ENOENT')).toBeUndefined();
  expect(errnoOf(null)).toBeUndefined();
});
