import { expect, test } from 'bun:test';
import { readdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { isStitchErrorCode, STITCH_ERROR_STATUS } from '../src/entrypoints/contract';

/**
 * The registry is only "one source of truth" if it is COMPLETE.
 *
 * Four codes — `WAIT_TIMEOUT`, `WAIT_FAILED`, `DOWNLOAD_NOT_FOUND`,
 * `VIEW_HTTP_ERROR` — were thrown by the framework and absent from it. For those
 * `isStitchErrorCode` answered `false`, so `createErrorHook` skipped both the
 * `codeMap` lookup and the `unmappedCode` resolver: the code travelled to the
 * wire in stitchkit's spelling, exactly as if the project had thrown it. A
 * consumer who mapped "every framework code" missed four and could not tell.
 *
 * Reading the source is the only way to see it — the type cannot, because the
 * type is derived FROM the registry.
 */
test('every code the framework throws is in the registry', async () => {
  const root = join(import.meta.dir, '../src');
  const thrown = new Set<string>();
  const entries = await readdir(root, { recursive: true, withFileTypes: true });
  for (const entry of entries) {
    if (!entry.isFile() || !entry.name.endsWith('.ts')) continue;
    const source = await readFile(join(entry.parentPath, entry.name), 'utf8');
    for (const match of source.matchAll(/new AppError\(\s*'([A-Z][A-Z0-9_]*)'/g)) {
      const code = match[1];
      if (code) thrown.add(code);
    }
    // A SUBCLASS of AppError names its code through `super(...)`, which the
    // pattern above cannot see — and that is exactly how two admission codes
    // reached the wire unregistered. The scan follows the code, not one way of
    // writing it.
    if (/extends AppError</.test(source)) {
      for (const match of source.matchAll(/super\(\s*'([A-Z][A-Z0-9_]*)'/g)) {
        const code = match[1];
        if (code) thrown.add(code);
      }
    }
  }

  expect(thrown.size).toBeGreaterThan(10);
  const missing = [...thrown].filter((code) => !isStitchErrorCode(code)).sort();
  expect(missing).toEqual([]);
});

test('every registered code has a plausible HTTP status', () => {
  const wrong = Object.entries(STITCH_ERROR_STATUS).filter(
    ([, status]) => !Number.isInteger(status) || status < 400 || status > 599,
  );
  expect(wrong).toEqual([]);
});

/**
 * The guide enumerates the same codes in prose, and prose is a second source of
 * truth the moment it drifts.
 *
 * The guide says so about itself — "this list is enumerated here for reading,
 * and the enumeration is what goes stale" — and names one drift that cost a
 * compile: `APPLICATION_NOT_ACCEPTING` dropped out of it. That note is a warning
 * with nothing behind it, and the list went stale again: on 2026-09-15 it was
 * missing `STREAM_ITEM_INVALID`, `STREAM_FRAME_TOO_LARGE`,
 * `STREAM_TERMINAL_MISSING`, `STREAM_LIFETIME_EXCEEDED` and
 * `GRAMMY_WEBHOOK_NOT_ACCEPTING` — five of thirty-one — while every gate in the
 * repository stayed green, this file included.
 *
 * Set equality in both directions on purpose. A missing code sends a reader
 * hunting for a vocabulary that is already published; an invented one sends
 * them to map a code the framework never throws.
 */
test('the guide enumerates exactly the registered codes', async () => {
  const guide = await readFile(
    join(import.meta.dir, '../../../docs/guide/auth-and-errors.md'),
    'utf8',
  );
  // Bounded to the enumeration itself: the same file shows codes in an example
  // `codeMap`, and a whole-file scan would read those as the list and pass
  // while the list was wrong.
  const enumeration =
    /But stitchkit itself emits a set of its own:([\s\S]*?)— a set that grows/.exec(
      guide,
    )?.[1];
  if (enumeration === undefined) {
    throw new Error('the guide no longer carries the enumeration this test holds');
  }
  const listed = [...enumeration.matchAll(/`([A-Z][A-Z0-9_]*)`/g)].map((match) => match[1]);
  expect(listed.length).toBeGreaterThan(10);
  expect([...new Set(listed)].sort()).toEqual(Object.keys(STITCH_ERROR_STATUS).sort());
});
