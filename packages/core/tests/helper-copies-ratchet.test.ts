/**
 * A helper the source owns once does not come back as a copy. A secret comparison written out by
 * hand drifts from the one that also hides the length; an integer limit checked inline answers
 * with its own class and text. The copies that remain are counted file by file: the count only
 * shrinks, by review, and a new copy is a red test that points at the owner.
 */
import { expect, test } from 'bun:test';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';

const SRC = join(import.meta.dir, '..', 'src');

function sourceFiles(directory: string): string[] {
  return readdirSync(directory).flatMap((name) => {
    const path = join(directory, name);
    if (statSync(path).isDirectory()) return sourceFiles(path);
    return path.endsWith('.ts') ? [path] : [];
  });
}

/** Files whose text matches `pattern`, with how often, keyed by their `src`-relative path. */
function countsOf(pattern: RegExp): Record<string, number> {
  return Object.fromEntries(
    sourceFiles(SRC).flatMap((path) => {
      const count = readFileSync(path, 'utf8').match(pattern)?.length ?? 0;
      return count > 0 ? [[path.slice(SRC.length + 1), count]] : [];
    }),
  );
}

/** A byte-by-byte difference folded into an accumulator: the loop of a constant-time compare. */
const CONSTANT_TIME_FOLD = /\|=\s*\(?[^;\n]*\^|\btimingSafeEqual\b/g;

/**
 * `Number.isSafeInteger(x) || x < 1` and its forms: the positive or non-negative rule of
 * `internal/positive-integer.ts`, written inline.
 */
const INLINE_INTEGER_RULE =
  /isSafeInteger\(([\w.$]+)\)\s*(?:\|\|\s*\1\s*(?:<\s*[01]|<=\s*0)|&&\s*\1\s*(?:>\s*0|>=\s*[01]))(?![\w.])/g;

/** The inline copies left, by file. Remove an entry when its file moves to the owner. */
const INLINE_INTEGER_COPIES: Record<string, number> = {
  'agent-runtime/compaction.ts': 1,
  'agent-runtime/models.ts': 1,
  'agent-runtime/openrouter.ts': 1,
  'agent-runtime/prompt.ts': 4,
  'agent-runtime/runtime-internals.ts': 1,
  'agent-runtime/runtime-recovery.ts': 1,
  'agent-runtime/sql-reads.ts': 2,
  'application/diagnostic-journal-generations.ts': 1,
  'application/file-state-store.ts': 1,
  'application/sqlite-migrations.ts': 2,
  'browser/chunked-upload.ts': 2,
  'browser/client-executors.ts': 1,
  'contract/define-validation.ts': 2,
  'files/chunk-spool.ts': 3,
  'internal/channel.ts': 1,
  'primitives/deadline.ts': 2,
  'react/entity-cache.ts': 1,
  'react/query-client.ts': 1,
  'server/middleware/signed-link.ts': 1,
  'server/multipart-reader.ts': 1,
  'server/unix-client.ts': 1,
  'service-host/launchd-render.ts': 1,
  'service-host/launchd.ts': 1,
  'service-host/macos/launch-services.ts': 1,
  'service-host/macos/responsibility.ts': 3,
  'service-host/systemd-inspect.ts': 1,
  'telegram/html/markdown-split.ts': 1,
  'telegram/init-data.ts': 1,
  'telegram/outbound-queue.ts': 1,
  'telegram/transport.ts': 1,
  'telegram/update-intake.ts': 1,
  'tools/cli/command.ts': 1,
};

test('the patterns find the copies they name and pass the owners (controls)', () => {
  expect('difference |= (a[i] ?? 0) ^ (b[i] ?? 0);'.match(CONSTANT_TIME_FOLD)).toHaveLength(1);
  expect('difference |= a ^ b;'.match(CONSTANT_TIME_FOLD)).toHaveLength(1);
  expect('return timingSafeEqual(a, b);'.match(CONSTANT_TIME_FOLD)).toHaveLength(1);
  expect('flags |= MASK;'.match(CONSTANT_TIME_FOLD)).toBeNull();
  for (const copy of [
    'if (!Number.isSafeInteger(value) || value < 1)',
    'if (!Number.isSafeInteger(read.limit) || read.limit <= 0)',
    'return Number.isSafeInteger(pid) && pid > 0 ? pid : null;',
    'if (!Number.isSafeInteger(count) || count < 0)',
  ])
    expect(copy.match(INLINE_INTEGER_RULE), copy).toHaveLength(1);
  for (const other of [
    'if (!Number.isSafeInteger(value) || value < least)',
    'if (!Number.isSafeInteger(a) || b < 1)',
    'if (!Number.isSafeInteger(code) || code < 10)',
  ])
    expect(other.match(INLINE_INTEGER_RULE), other).toBeNull();
});

test('secrets are compared by secretsEqual alone', () => {
  expect(Object.keys(countsOf(CONSTANT_TIME_FOLD))).toEqual(['internal/secret-equal.ts']);
});

/**
 * A one-shot timer handed out with its cancellation — the body of a clock's `schedule`, in either
 * shape a seam takes: `{ cancel: () => clearTimeout(t) }` or `() => clearTimeout(t)`.
 */
const CANCELLABLE_TIMER = /return\s*(?:\{\s*cancel:\s*)?\(\)\s*=>\s*\{?\s*clearTimeout\(/g;

test('a clock that arms a timer is monotonicTimerClock, apart from the two unreferenced ones', () => {
  for (const shape of [
    'return { cancel: () => clearTimeout(timer) };',
    'return () => clearTimeout(timer);',
    'return () => { clearTimeout(timer); };',
  ])
    expect(shape.match(CANCELLABLE_TIMER), shape).toHaveLength(1);
  // A listener that clears a timer hands nothing out.
  expect(
    "outgoing.once('response', () => clearTimeout(timer));".match(CANCELLABLE_TIMER),
  ).toBeNull();
  // Other clocks, not copies: the durability clock keeps wall time (`Date.now`), and both it and
  // the log-repeat flush arm a timer that does not keep the process alive (`unref`).
  expect(Object.keys(countsOf(CANCELLABLE_TIMER)).sort()).toEqual([
    'durability/scheduler.ts',
    'internal/timers.ts',
    'observability/log-repeat.ts',
  ]);
});

test('an inline integer rule is a counted copy that only shrinks', () => {
  expect(countsOf(INLINE_INTEGER_RULE)).toEqual(INLINE_INTEGER_COPIES);
});

/** A delay held under the timer ceiling by hand: `Math.min(…, MAX_TIMER_MS)`, in either order. */
const CEILING_CLAMP = /Math\.min\([^;]*\bMAX_TIMER_MS\b/g;

test('a wait past the timer ceiling steps through scheduleAt; the clamps that remain are counted', () => {
  expect('Math.min(remaining, MAX_TIMER_MS)'.match(CEILING_CLAMP)).toHaveLength(1);
  expect('Math.min(MAX_TIMER_MS, Math.max(0, ms))'.match(CEILING_CLAMP)).toHaveLength(1);
  expect(countsOf(CEILING_CLAMP)).toEqual({
    // The one stepper.
    'internal/timers.ts': 1,
    // A cap on a doubling retry pause: the pause is shortened, no deadline is waited for.
    'browser/chunked-upload.ts': 1,
    // A cap on the retry-after a server asked for, a schema field held to the ceiling.
    'telegram/broadcast-failure.ts': 1,
  });
});
