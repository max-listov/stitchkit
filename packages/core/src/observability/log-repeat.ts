import { serializeCanonicalJson } from '../internal/canonical-json';
import { assertTimerMs } from '../internal/deadline';
import type { StitchLogger } from '../internal/logger';
import { assertPositiveSafeInteger } from '../internal/positive-integer';
import { isRecord } from '../internal/typed';

/** Default suppression window per distinct `warn`/`error` kind (60 seconds). */
export const DEFAULT_REPEAT_WINDOW_MS = 60_000;

/** Default maximum number of distinct kinds held before LRU eviction. */
export const DEFAULT_REPEAT_MAX_KINDS = 256;

const MAX_KEY_DEPTH = 4;
const MAX_KEY_FIELDS = 32;
const UNREADABLE = '[unreadable]';
const NUMBER = '#';

const EXCLUDED_KEYS = new Set([
  'id',
  'at',
  'ts',
  'time',
  'timestamp',
  'stack',
  'error',
  'dimensions',
  'cause',
]);

/** Configuration for windowed suppression of repeated `warn` and `error` log entries. */
export interface RepeatLimitOptions {
  /** Suppression window per distinct `warn`/`error` kind in milliseconds. Default `60_000`. */
  readonly windowMs?: number;
  /** Maximum distinct kinds tracked in memory before LRU eviction. Default `256`. */
  readonly maxKinds?: number;
  /** Clock in epoch milliseconds. Default `Date.now`. */
  readonly now?: () => number;
  /**
   * Run `flush` once after `delayMs`; returns its cancel. Default an unreferenced
   * `setTimeout`, so a pending count never keeps a process alive.
   */
  readonly schedule?: (flush: () => void, delayMs: number) => () => void;
  /**
   * The kind of an entry, replacing the default key (see {@link repeatLimited}) — for
   * a string field the default keeps whole, such as a path. Entries of different levels
   * are never one kind, whatever it returns.
   */
  readonly kindOf?: (
    level: 'warn' | 'error',
    message: string,
    data?: Record<string, unknown>,
  ) => string;
}

type LimitedLevel = 'warn' | 'error';

interface KindState {
  readonly level: LimitedLevel;
  lastWrittenAt: number;
  lastMsg: string;
  /** The data of the last suppressed entry, held only until its count is written. */
  lastData?: Record<string, unknown>;
  suppressed: number;
  /** Cancels the write of `suppressed` scheduled for the end of the current window. */
  cancelFlush?: () => void;
}

function scheduleUnreferenced(flush: () => void, delayMs: number): () => void {
  const handle = setTimeout(flush, delayMs);
  if (typeof handle === 'object' && handle !== null && 'unref' in handle) handle.unref();
  return () => clearTimeout(handle);
}

function normalizeNumbers(text: string): string {
  return text.replace(/\d+(?:\.\d+)?/g, NUMBER);
}

function isPerCallKey(key: string): boolean {
  return EXCLUDED_KEYS.has(key) || key.endsWith('Id') || key.endsWith('ID');
}

function safeGet(target: object, key: string | number): unknown {
  try {
    return Reflect.get(target, key);
  } catch {
    return UNREADABLE;
  }
}

function safeSnapshot(data?: Record<string, unknown>): Record<string, unknown> | undefined {
  if (data === undefined) return undefined;
  const copy: Record<string, unknown> = {};
  let keys: string[];
  try {
    keys = Object.keys(data);
  } catch {
    return copy;
  }
  for (const key of keys) {
    copy[key] = safeGet(data, key);
  }
  return copy;
}

/**
 * Whether `message` holds `code` as a word of its own, as a system error's text does. Only a
 * code that is a name counts: a number (an exit status `1`, an HTTP `500`) stands as a word
 * in almost any message, beside the reason that tells two failures apart.
 */
function namesCode(message: string, code: unknown): boolean {
  return (
    typeof code === 'string' &&
    /^[A-Za-z]/.test(code) &&
    message.split(/[^A-Za-z0-9_]+/).includes(code)
  );
}

/**
 * A reason as part of a kind: its `name`, its `code`, and its number-normalised `message`
 * unless the message names a code that is a name. That is the form of a system error
 * (`ENOENT: no such file or directory, open '/path'`), whose text repeats a path or an
 * address per call; a category code (`INTERNAL_ERROR`, `COMMAND_FAILED`) carries different
 * reasons in a message that does not name it, and a numeric code (an exit status, an HTTP
 * status) is a word of nearly every message: either way the message stays part of the kind.
 */
function summarizeCause(cause: unknown): Record<string, string> | string | undefined {
  if (cause === undefined || cause === null) return undefined;
  if (typeof cause === 'string') return normalizeNumbers(cause);
  if (cause instanceof Error || isRecord(cause)) {
    const summary: Record<string, string> = {};
    const name = safeGet(cause, 'name');
    if (typeof name === 'string') summary.name = name;
    const code = safeGet(cause, 'code');
    if (typeof code === 'string' || typeof code === 'number') summary.code = String(code);
    const message = safeGet(cause, 'message');
    if (typeof message === 'string' && !namesCode(message, code)) {
      summary.message = normalizeNumbers(message);
    }
    return Object.keys(summary).length > 0 ? summary : undefined;
  }
  return undefined;
}

function normalizeKeyValue(value: unknown, depth: number, seen: Set<object>): unknown {
  if (value === null || value === undefined) return value;
  if (typeof value === 'string' || typeof value === 'boolean') return value;
  // A number is per call (an attempt, a duration, a status): the field is part of the
  // kind, its value is not — the same rule as for digits in the message.
  if (typeof value === 'number' || typeof value === 'bigint') return NUMBER;
  if (value instanceof Error) return summarizeCause(value);
  if (value instanceof URL) return value.href;
  if (value instanceof RegExp) return String(value);
  if (typeof value !== 'object') return undefined;
  if (isRecord(value) && safeGet(value, '_type') === 'error') {
    return summarizeCause(value);
  }
  if (seen.has(value)) return '[Circular]';
  if (depth >= MAX_KEY_DEPTH) return '[Depth]';

  seen.add(value);
  try {
    if (Array.isArray(value)) {
      const length = Math.min(value.length, MAX_KEY_FIELDS);
      const items: unknown[] = [];
      for (let i = 0; i < length; i += 1) {
        items.push(normalizeKeyValue(safeGet(value, i), depth + 1, seen));
      }
      return items;
    }
    const stable: Record<string, unknown> = {};
    let keys: string[];
    try {
      keys = Object.keys(value);
    } catch {
      return UNREADABLE;
    }
    let count = 0;
    for (const key of keys) {
      if (isPerCallKey(key)) continue;
      if (count >= MAX_KEY_FIELDS) break;
      const normalized = normalizeKeyValue(safeGet(value, key), depth + 1, seen);
      if (normalized !== undefined) {
        stable[key] = normalized;
        count += 1;
      }
    }
    return stable;
  } finally {
    seen.delete(value);
  }
}

function dedupeKey(level: LimitedLevel, msg: string, data?: Record<string, unknown>): string {
  const seen = new Set<object>();
  const stableData = data ? normalizeKeyValue(data, 0, seen) : undefined;
  const hasStableData =
    stableData !== undefined && (!isRecord(stableData) || Object.keys(stableData).length > 0);
  // The reason an entry was written is part of its kind wherever the caller put it: this
  // framework logs it as `error`, others as `cause`. The stack and the rest of the object
  // are per call; name, code and message are what make two failures the same failure.
  const cause = data ? summarizeCause(safeGet(data, 'cause')) : undefined;
  const error = data ? summarizeCause(safeGet(data, 'error')) : undefined;
  return serializeCanonicalJson({
    level,
    message: normalizeNumbers(msg),
    ...(hasStableData && { data: stableData }),
    ...(cause !== undefined && { cause }),
    ...(error !== undefined && { error }),
  });
}

function flushEvicted(logger: StitchLogger, evicted: KindState): void {
  evicted.cancelFlush?.();
  if (evicted.suppressed <= 0) return;
  try {
    logger[evicted.level](evicted.lastMsg, {
      ...evicted.lastData,
      repeatedSinceLastWrite: evicted.suppressed,
    });
  } catch {
    // A failing eviction flush must never prevent the new log entry from being written.
  }
}

/**
 * Wrap a {@link StitchLogger} with bounded per-kind suppression for `warn` and
 * `error` entries while passing `info` and `debug` through untouched.
 *
 * The kind of an entry is its level, its message with every number as `#`, its data
 * fields with string and boolean values whole and every number as `#` (per-call fields
 * — `id`, `at`, `ts`, `time`, `timestamp`, `stack`, `dimensions` and `*Id`/`*ID` keys —
 * left out), and the reason under `cause` and under `error`: its `name` and `code`, and
 * its number-normalised `message` unless the message names the code, as a system error's
 * (`ENOENT: …, open '/path'`) does. `kindOf` replaces all
 * but the level. Suppressed occurrences are written as
 * `repeatedSinceLastWrite` at the end of their window, with the next entry of the
 * kind if that comes first, and on LRU eviction. A count still waiting when the
 * process ends is lost: the timer that would write it never holds the process. A kind
 * holds the data of its last suppressed entry (a shallow copy) only until that count is
 * written, and nothing of a written entry.
 */
export function repeatLimited(
  logger: StitchLogger,
  options: RepeatLimitOptions = {},
): StitchLogger {
  const windowMs = options.windowMs ?? DEFAULT_REPEAT_WINDOW_MS;
  const maxKinds = options.maxKinds ?? DEFAULT_REPEAT_MAX_KINDS;
  assertTimerMs('windowMs', windowMs);
  assertPositiveSafeInteger('maxKinds', maxKinds);
  const now = options.now ?? Date.now;
  const schedule = options.schedule ?? scheduleUnreferenced;
  const { kindOf } = options;

  const kinds = new Map<string, KindState>();

  // A kind that stops repeating would otherwise keep its count forever: the first
  // suppressed entry of a window books one write of the count for the window's end.
  const flushAtWindowEnd = (state: KindState, current: number): void => {
    if (state.cancelFlush !== undefined) return;
    state.cancelFlush = schedule(
      () => {
        state.cancelFlush = undefined;
        if (state.suppressed <= 0) return;
        const repeated = state.suppressed;
        state.suppressed = 0;
        state.lastWrittenAt = now();
        const lastData = state.lastData;
        state.lastData = undefined;
        try {
          logger[state.level](state.lastMsg, {
            ...lastData,
            repeatedSinceLastWrite: repeated,
          });
        } catch {
          // A sink that fails here must not surface inside a timer nobody awaits.
        }
      },
      Math.max(0, state.lastWrittenAt + windowMs - current),
    );
  };

  const emitLimited = (
    level: LimitedLevel,
    msg: string,
    data?: Record<string, unknown>,
  ): void => {
    const key = kindOf
      ? serializeCanonicalJson({ level, kind: kindOf(level, msg, data) })
      : dedupeKey(level, msg, data);
    const current = now();
    const existing = kinds.get(key);

    if (existing !== undefined) {
      kinds.delete(key);
      kinds.set(key, existing);
      if (current >= existing.lastWrittenAt && current - existing.lastWrittenAt < windowMs) {
        existing.suppressed += 1;
        existing.lastMsg = msg;
        existing.lastData = safeSnapshot(data);
        flushAtWindowEnd(existing, current);
        return;
      }
      existing.cancelFlush?.();
      existing.cancelFlush = undefined;
      const repeated = existing.suppressed;
      if (repeated > 0) {
        logger[level](msg, { ...safeSnapshot(data), repeatedSinceLastWrite: repeated });
      } else {
        logger[level](msg, data);
      }
      existing.lastWrittenAt = current;
      existing.suppressed = 0;
      existing.lastMsg = msg;
      existing.lastData = undefined;
      return;
    }

    if (kinds.size >= maxKinds) {
      const oldestKey = kinds.keys().next().value;
      if (oldestKey !== undefined) {
        const evicted = kinds.get(oldestKey);
        kinds.delete(oldestKey);
        if (evicted !== undefined) flushEvicted(logger, evicted);
      }
    }

    logger[level](msg, data);
    kinds.set(key, { level, lastWrittenAt: current, lastMsg: msg, suppressed: 0 });
  };

  return {
    debug: (msg, data) => logger.debug(msg, data),
    info: (msg, data) => logger.info(msg, data),
    warn: (msg, data) => emitLimited('warn', msg, data),
    error: (msg, data) => emitLimited('error', msg, data),
  };
}
