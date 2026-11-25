import { describe, expect, test } from 'bun:test';
import { AppError } from '../src/entrypoints/contract';
import type { StitchLogger } from '../src/entrypoints/index';
import {
  createBoundedLogger,
  createJsonLogger,
  DEFAULT_REPEAT_MAX_KINDS,
  DEFAULT_REPEAT_WINDOW_MS,
  measureSize,
  repeatLimited,
} from '../src/entrypoints/observability';
import { expectTimerRefusal } from './support/timer-refusal';

interface CapturedEntry {
  level: keyof StitchLogger;
  msg: string;
  data?: Record<string, unknown>;
}

function createSink(): { sink: StitchLogger; entries: CapturedEntry[] } {
  const entries: CapturedEntry[] = [];
  const push =
    (level: keyof StitchLogger) =>
    (msg: string, data?: Record<string, unknown>): void => {
      entries.push({ level, msg, ...(data !== undefined && { data }) });
    };
  return {
    entries,
    sink: {
      debug: push('debug'),
      info: push('info'),
      warn: push('warn'),
      error: push('error'),
    },
  };
}

describe('repeatLimited', () => {
  test('passes info and debug through without suppression', () => {
    expect(DEFAULT_REPEAT_WINDOW_MS).toBe(60_000);
    expect(DEFAULT_REPEAT_MAX_KINDS).toBe(256);

    const { sink, entries } = createSink();
    const logger = repeatLimited(sink, { windowMs: 60_000, now: () => 1_000 });

    logger.info('heartbeat', { tick: 1 });
    logger.info('heartbeat', { tick: 1 });
    logger.debug('trace step', { step: 'a' });
    logger.debug('trace step', { step: 'a' });

    expect(entries).toHaveLength(4);
    expect(entries.map((e) => e.level)).toEqual(['info', 'info', 'debug', 'debug']);
  });

  test('suppresses repeated warn and error within window and emits repeatedSinceLastWrite on release', () => {
    let time = 10_000;
    const { sink, entries } = createSink();
    const logger = repeatLimited(sink, { windowMs: 5_000, now: () => time });

    logger.error('upstream timeout', { op: 'sync' });
    time += 1_000;
    logger.error('upstream timeout', { op: 'sync' });
    time += 1_000;
    logger.error('upstream timeout', { op: 'sync' });
    time += 1_000;
    logger.error('upstream timeout', { op: 'sync' });

    // Only the first emission occurred within the 5s window
    expect(entries).toEqual([
      { level: 'error', msg: 'upstream timeout', data: { op: 'sync' } },
    ]);

    // Advance past window -> releases with repeatedSinceLastWrite = 3
    time = 15_000;
    logger.error('upstream timeout', { op: 'sync' });
    expect(entries[1]).toEqual({
      level: 'error',
      msg: 'upstream timeout',
      data: { op: 'sync', repeatedSinceLastWrite: 3 },
    });

    // Another call after a quiet window (0 suppressed) omits repeatedSinceLastWrite
    time = 20_000;
    logger.error('upstream timeout', { op: 'sync' });
    expect(entries).toHaveLength(3);
    expect(entries[2]).toEqual({
      level: 'error',
      msg: 'upstream timeout',
      data: { op: 'sync' },
    });
  });

  test('groups warn and error separately and normalizes numbers in message', () => {
    let time = 1_000;
    const { sink, entries } = createSink();
    const logger = repeatLimited(sink, { windowMs: 60_000, now: () => time });

    logger.warn('connect failed on port 5001 after 12.5ms', { target: 'primary' });
    time += 100;
    logger.warn('connect failed on port 5002 after 84ms', { target: 'primary' });
    // Same message under error is a distinct kind
    logger.error('connect failed on port 5003 after 99ms', { target: 'primary' });

    expect(entries).toHaveLength(2);
    expect(entries.map((e) => e.level)).toEqual(['warn', 'error']);

    time += 60_000;
    logger.warn('connect failed on port 5009 after 10ms', { target: 'primary' });
    expect(entries).toHaveLength(3);
    expect(entries[2]?.data?.repeatedSinceLastWrite).toBe(1);
  });

  test('excludes per-call fields and *Id/*ID fields while keeping stable data fields', () => {
    let time = 1_000;
    const { sink, entries } = createSink();
    const logger = repeatLimited(sink, { windowMs: 60_000, now: () => time });
    const perCall = (n: number) => ({
      queue: 'email',
      id: `${n}`,
      at: `2026-01-01T00:00:0${n}Z`,
      ts: n,
      time: n,
      timestamp: n,
      stack: `Error: ${n}\n  at fn:${n}`,
      error: `transient-${n}`,
      dimensions: { attempt: n },
      requestId: `req-${n}`,
      traceId: `trace-${n}`,
      spanId: `span-${n}`,
      userId: `user-${n}`,
      sessionID: `sess-${n}`,
    });

    logger.error('job failed', perCall(1));
    time += 500;
    logger.error('job failed', perCall(2));
    // Different stable field creates a distinct kind
    logger.error('job failed', { queue: 'billing', requestId: 'req-3' });

    expect(entries).toHaveLength(2);
    expect(entries[0]?.data?.queue).toBe('email');
    expect(entries[1]?.data?.queue).toBe('billing');
  });

  test('distinguishes kinds by cause code, name, and normalized message', () => {
    const time = 1_000;
    const { sink, entries } = createSink();
    const logger = repeatLimited(sink, { windowMs: 60_000, now: () => time });

    const refused1 = Object.assign(new Error('connect ECONNREFUSED 127.0.0.1:5001'), {
      code: 'ECONNREFUSED',
    });
    const refused2 = Object.assign(new Error('connect ECONNREFUSED 127.0.0.1:5002'), {
      code: 'ECONNREFUSED',
    });
    const timedOut = Object.assign(new Error('connect ETIMEDOUT 127.0.0.1:5001'), {
      code: 'ETIMEDOUT',
    });
    const typeErr = new TypeError('connect ECONNREFUSED 127.0.0.1:5001');

    logger.error('dial failed', { cause: refused1 });
    logger.error('dial failed', { cause: refused2 }); // suppressed (same code/name/normalized msg)
    logger.error('dial failed', { cause: timedOut }); // distinct cause
    logger.error('dial failed', { cause: typeErr }); // distinct cause name

    expect(entries).toHaveLength(3);
  });

  test('entries that carry different reasons under `error` are different kinds', () => {
    // This framework writes the reason as `logger.error(message, { error })`. One message
    // with three reasons is three failures, and each of them is worth its own line.
    const { sink, entries } = createSink();
    const logger = repeatLimited(sink, {
      windowMs: 60_000,
      now: () => 1_000,
      schedule: () => () => undefined,
    });
    const refused = Object.assign(new Error('connect ECONNRESET'), { code: 'ECONNRESET' });
    const denied = Object.assign(new Error('permission denied'), { code: 'EACCES' });

    logger.error('Realtime connection handler failed', { error: refused });
    logger.error('Realtime connection handler failed', { error: denied });
    logger.error('Realtime connection handler failed', {
      error: new TypeError('x is not a function'),
    });
    // The same reason again, as a fresh object with its own stack, is the same kind.
    logger.error('Realtime connection handler failed', {
      error: Object.assign(new Error('connect ECONNRESET'), { code: 'ECONNRESET' }),
    });

    const reasons = entries.map((entry) => {
      const reason = entry.data?.error;
      return reason instanceof Error ? reason.message : undefined;
    });
    expect(reasons).toEqual([
      'connect ECONNRESET',
      'permission denied',
      'x is not a function',
    ]);
  });

  test('a kind that stops repeating still gets its count written when its window ends', () => {
    const { sink, entries } = createSink();
    let clock = 1_000;
    const timers: Array<{ run: () => void; delayMs: number; cancelled: boolean }> = [];
    const logger = repeatLimited(sink, {
      windowMs: 60_000,
      now: () => clock,
      schedule: (run, delayMs) => {
        const timer = { run, delayMs, cancelled: false };
        timers.push(timer);
        return () => {
          timer.cancelled = true;
        };
      },
    });

    logger.warn('disk nearly full', { mount: '/data' });
    clock = 11_000;
    logger.warn('disk nearly full', { mount: '/data' });
    logger.warn('disk nearly full', { mount: '/data' });
    // One write is booked for the end of the window the first entry opened, not one per entry.
    expect(timers).toHaveLength(1);
    expect(timers[0]?.delayMs).toBe(50_000);
    expect(entries).toHaveLength(1);

    clock = 61_000;
    timers[0]?.run();
    expect(entries).toHaveLength(2);
    expect(entries[1]).toMatchObject({
      level: 'warn',
      msg: 'disk nearly full',
      data: { mount: '/data', repeatedSinceLastWrite: 2 },
    });

    // The next entry of the kind, in a new window, opens a new count from zero.
    clock = 62_000;
    logger.warn('disk nearly full', { mount: '/data' });
    expect(timers).toHaveLength(2);
    clock = 200_000;
    logger.warn('disk nearly full', { mount: '/data' });
    // It arrived before the booked write ran, so it carries the count and the booking is dropped.
    expect(timers[1]?.cancelled).toBe(true);
    expect(entries[2]?.data).toEqual({ mount: '/data', repeatedSinceLastWrite: 1 });
  });

  test('flushes accumulated repeatedSinceLastWrite on LRU eviction when maxKinds is exceeded', () => {
    let time = 1_000;
    const { sink, entries } = createSink();
    const logger = repeatLimited(sink, { windowMs: 60_000, maxKinds: 2, now: () => time });

    // Kind A emitted once, then suppressed 3 times
    logger.error('kind-a', { op: 'a' });
    time += 100;
    logger.error('kind-a', { op: 'a', requestId: 'a1' });
    logger.error('kind-a', { op: 'a', requestId: 'a2' });
    logger.error('kind-a', { op: 'a', requestId: 'a3' });

    // Kind B emitted once, then suppressed 1 time
    time += 100;
    logger.warn('kind-b', { op: 'b' });
    logger.warn('kind-b', { op: 'b', requestId: 'b1' });

    expect(entries).toHaveLength(2);

    // Kind C arrives -> maxKinds (2) exceeded -> LRU (kind-a) MUST be flushed with repeatedSinceLastWrite: 3
    time += 100;
    logger.error('kind-c', { op: 'c' });

    expect(entries).toHaveLength(4);
    expect(entries[2]).toEqual({
      level: 'error',
      msg: 'kind-a',
      data: { op: 'a', requestId: 'a3', repeatedSinceLastWrite: 3 },
    });
    expect(entries[3]).toEqual({ level: 'error', msg: 'kind-c', data: { op: 'c' } });

    // Touch kind-b so kind-c becomes LRU (kind-c has 0 suppressed -> evicted silently)
    time += 100;
    logger.warn('kind-b', { op: 'b', requestId: 'b2' });
    logger.error('kind-d', { op: 'd' });

    // kind-c had 0 suppressed -> no flush entry, only kind-d emitted
    expect(entries).toHaveLength(5);
    expect(entries[4]).toEqual({ level: 'error', msg: 'kind-d', data: { op: 'd' } });

    // Now kind-b is LRU with 2 suppressed -> kind-e evicts and flushes kind-b
    logger.error('kind-e', { op: 'e' });
    expect(entries).toHaveLength(7);
    expect(entries[5]).toEqual({
      level: 'warn',
      msg: 'kind-b',
      data: { op: 'b', requestId: 'b2', repeatedSinceLastWrite: 2 },
    });
    expect(entries[6]).toEqual({ level: 'error', msg: 'kind-e', data: { op: 'e' } });
  });

  test('handles circular references, BigInt values, and rejects invalid options', () => {
    const { sink, entries } = createSink();
    const logger = repeatLimited(sink, { windowMs: 60_000, now: () => 1_000 });

    const cyclic: Record<string, unknown> = { big: 42n };
    cyclic.self = cyclic;

    logger.error('cyclic payload', cyclic);
    logger.error('cyclic payload', cyclic);
    expect(entries).toHaveLength(1);

    expect(() => repeatLimited(sink, { windowMs: 0 })).toThrow(RangeError);
    expect(() => repeatLimited(sink, { windowMs: -10 })).toThrow(RangeError);
    // Past the timer ceiling the window's flush would fire at once.
    expectTimerRefusal(() => repeatLimited(sink, { windowMs: 2 ** 31 }), 'windowMs', 2 ** 31);
    expect(() => repeatLimited(sink, { maxKinds: 0 })).toThrow(TypeError);
    expect(() => repeatLimited(sink, { maxKinds: 1.5 })).toThrow(TypeError);
  });

  test('integrates with createBoundedLogger and createJsonLogger via repeat option', () => {
    let time = 1_000;
    const { sink, entries } = createSink();
    const bounded = createBoundedLogger({
      sink,
      repeat: { windowMs: 10_000, maxKinds: 2, now: () => time },
    });

    bounded.error('auth failed 1', { password: 'secret-value-a', op: 'login' });
    bounded.error('auth failed 2', { password: 'secret-value-b', op: 'login' });
    bounded.info('always logged');
    bounded.info('always logged');

    expect(entries).toHaveLength(3);
    expect(entries[0]?.data?.password).toBe('[redacted]');

    time += 10_000;
    bounded.error('auth failed 3', { password: 'secret-value-c', op: 'login' });
    expect(entries).toHaveLength(4);
    expect(entries[3]?.data?.repeatedSinceLastWrite).toBe(1);
    expect(entries[3]?.data?.password).toBe('[redacted]');

    // createJsonLogger forwards its `now` clock into `repeat`
    let jsonTime = 5_000;
    const lines: string[] = [];
    const jsonLogger = createJsonLogger({
      now: () => jsonTime,
      write: (line) => lines.push(line),
      repeat: { windowMs: 2_000 },
    });

    jsonLogger.warn('retry 1', { op: 'poll' });
    jsonTime += 500;
    jsonLogger.warn('retry 2', { op: 'poll' });
    jsonTime += 2_000;
    jsonLogger.warn('retry 3', { op: 'poll' });

    const records = lines.map((line) => JSON.parse(line));
    expect(records).toHaveLength(2);
    expect(records[0]).toMatchObject({ level: 40, msg: 'retry 1', time: 5_000 });
    expect(records[1]).toMatchObject({
      level: 40,
      msg: 'retry 3',
      time: 7_500,
      repeatedSinceLastWrite: 1,
    });
  });

  test('enforces entryBytes bound in createBoundedLogger even after repeatedSinceLastWrite injection', () => {
    let time = 1_000;
    const { sink, entries } = createSink();
    const bounded = createBoundedLogger({
      sink,
      bounds: { entryBytes: 128 },
      repeat: { windowMs: 1_000, maxKinds: 4, now: () => time },
    });

    const msg = 'a'.repeat(90);
    bounded.error(msg, { op: 'sync' });
    time += 100;
    bounded.error(msg, { op: 'sync' });
    time += 1_000;
    bounded.error(msg, { op: 'sync' });

    expect(entries).toHaveLength(2);
    for (const entry of entries) {
      expect(
        measureSize({ message: entry.msg, data: entry.data }).responseBytes,
      ).toBeLessThanOrEqual(128);
    }
  });

  test('preserves counts and writes new log when sink throws synchronously', () => {
    let time = 1_000;
    let shouldThrow: 'none' | 'eviction' | 'release' | 'first' = 'first';
    const recorded: CapturedEntry[] = [];
    const flakySink: StitchLogger = {
      debug: () => undefined,
      info: () => undefined,
      warn: (msg, data) => {
        if (shouldThrow === 'eviction' && msg === 'kind-a') {
          throw new Error('eviction write failed');
        }
        recorded.push({ level: 'warn', msg, ...(data !== undefined && { data }) });
      },
      error: (msg, data) => {
        if (shouldThrow === 'first') throw new Error('first write failed');
        if (shouldThrow === 'release') throw new Error('release write failed');
        if (shouldThrow === 'eviction' && msg === 'kind-a') {
          throw new Error('eviction write failed');
        }
        recorded.push({ level: 'error', msg, ...(data !== undefined && { data }) });
      },
    };
    const logger = repeatLimited(flakySink, { windowMs: 5_000, maxKinds: 2, now: () => time });

    // First write throws -> kind must NOT be recorded as written
    expect(() => logger.error('kind-a', { op: 'a' })).toThrow('first write failed');
    shouldThrow = 'none';
    logger.error('kind-a', { op: 'a' });
    expect(recorded).toHaveLength(1);

    // Suppress 2 occurrences, then throw on window release -> count must be preserved
    time += 1_000;
    logger.error('kind-a', { op: 'a' });
    logger.error('kind-a', { op: 'a' });
    time += 5_000;
    shouldThrow = 'release';
    expect(() => logger.error('kind-a', { op: 'a' })).toThrow('release write failed');

    shouldThrow = 'none';
    logger.error('kind-a', { op: 'a' });
    expect(recorded).toHaveLength(2);
    expect(recorded[1]?.data?.repeatedSinceLastWrite).toBe(2);

    // Build up suppressed count on kind-a, fill kind-b, then throw on kind-a eviction -> kind-c still writes!
    time += 100;
    logger.error('kind-a', { op: 'a' });
    logger.warn('kind-b', { op: 'b' });
    shouldThrow = 'eviction';
    logger.error('kind-c', { op: 'c' });
    expect(recorded.at(-1)).toEqual({ level: 'error', msg: 'kind-c', data: { op: 'c' } });
  });

  test('survives throwing getters in data and cause without crashing', () => {
    let time = 1_000;
    const { sink, entries } = createSink();
    const logger = repeatLimited(sink, { windowMs: 5_000, now: () => time });

    const makeBad = (): Record<string, unknown> => {
      const badCause = {};
      Object.defineProperty(badCause, 'message', {
        enumerable: true,
        get() {
          throw new Error('cause getter failed');
        },
      });
      const payload: Record<string, unknown> = { op: 'sync', cause: badCause };
      Object.defineProperty(payload, 'boom', {
        enumerable: true,
        get() {
          throw new Error('data getter failed');
        },
      });
      return payload;
    };

    logger.error('getter test', makeBad());
    time += 100;
    logger.error('getter test', makeBad());
    expect(entries).toHaveLength(1);

    time += 5_000;
    logger.error('getter test', makeBad());
    expect(entries).toHaveLength(2);
    expect(entries[1]?.data).toMatchObject({
      op: 'sync',
      boom: '[unreadable]',
      repeatedSinceLastWrite: 1,
    });
  });

  test('releases immediately when system clock steps backwards (NTP step-back)', () => {
    let time = 100_000;
    const { sink, entries } = createSink();
    const logger = repeatLimited(sink, { windowMs: 60_000, now: () => time });

    logger.error('clock test', { op: 'tick' });
    time += 1_000;
    logger.error('clock test', { op: 'tick' });
    expect(entries).toHaveLength(1);

    // Clock steps backwards before lastWrittenAt -> must not stay suppressed
    time = 50_000;
    logger.error('clock test', { op: 'tick' });
    expect(entries).toHaveLength(2);
    expect(entries[1]?.data?.repeatedSinceLastWrite).toBe(1);

    // Subsequent call within window from the new baseline is suppressed again
    time = 51_000;
    logger.error('clock test', { op: 'tick' });
    expect(entries).toHaveLength(2);
  });

  test('unifies missing data and per-call-only data into the same kind', () => {
    let time = 1_000;
    const { sink, entries } = createSink();
    const logger = repeatLimited(sink, { windowMs: 10_000, now: () => time });

    logger.error('boom');
    time += 100;
    logger.error('boom', { requestId: '1', traceId: 't-1', ts: 123 });
    time += 100;
    logger.error('boom', {});
    expect(entries).toHaveLength(1);

    time += 10_000;
    logger.error('boom', { requestId: '2' });
    expect(entries).toHaveLength(2);
    expect(entries[1]?.data?.repeatedSinceLastWrite).toBe(2);
  });

  test('keeps distinct URL and RegExp values separate and groups sanitized errors in createBoundedLogger', () => {
    const time = 1_000;
    const { sink, entries } = createSink();
    const logger = repeatLimited(sink, { windowMs: 60_000, now: () => time });

    logger.error('fetch failed', { url: new URL('https://a.example/x') });
    logger.error('fetch failed', { url: new URL('https://b.example/y') });
    logger.error('match failed', { pattern: /foo/i });
    logger.error('match failed', { pattern: /bar/g });
    expect(entries).toHaveLength(4);

    // Through createBoundedLogger, Error in non-cause field (`err`) becomes `{ _type: 'error', ... }`
    const { sink: boundedSink, entries: boundedEntries } = createSink();
    const bounded = createBoundedLogger({
      sink: boundedSink,
      repeat: { windowMs: 10_000, maxKinds: 2, now: () => time },
    });

    bounded.error('dial failed', { err: new Error('connect 127.0.0.1:5001 failed') });
    bounded.error('dial failed', { err: new Error('connect 127.0.0.1:5002 failed') });
    expect(boundedEntries).toHaveLength(1);

    // LRU eviction on createBoundedLogger must never leak unredacted secrets
    bounded.error('secret-kind-1', { password: 'top-secret-alpha', op: 'a' });
    bounded.error('secret-kind-1', { password: 'top-secret-beta', op: 'a' });
    bounded.error('secret-kind-2', { password: 'top-secret-gamma', op: 'b' });
    // Now dial failed was evicted (after 1 suppressed), trigger eviction of secret-kind-1
    bounded.error('secret-kind-3', { op: 'c' });

    const serialized = JSON.stringify(boundedEntries);
    expect(serialized).not.toContain('top-secret-alpha');
    expect(serialized).not.toContain('top-secret-beta');
    expect(serialized).not.toContain('top-secret-gamma');
    const flushedSecretKind = boundedEntries.find(
      (e) => e.msg === 'secret-kind-1' && e.data?.repeatedSinceLastWrite === 1,
    );
    expect(flushedSecretKind?.data?.password).toBe('[redacted]');
  });

  test('createJsonLogger uses its own now clock when repeat.now is explicitly undefined', () => {
    let clock = 20_000;
    const lines: string[] = [];
    const logger = createJsonLogger({
      now: () => clock,
      write: (line) => lines.push(line),
      repeat: { windowMs: 1_000, now: undefined },
    });

    logger.error('tick', { op: 'poll' });
    clock += 200;
    logger.error('tick', { op: 'poll' });
    clock += 1_000;
    logger.error('tick', { op: 'poll' });

    const records = lines.map((line) => JSON.parse(line));
    expect(records).toHaveLength(2);
    expect(records[1]).toMatchObject({ time: 21_200, repeatedSinceLastWrite: 1 });
  });
});

describe('repeatLimited kind of an entry', () => {
  function written(body: (logger: StitchLogger) => void, options = {}): CapturedEntry[] {
    const { sink, entries } = createSink();
    body(
      repeatLimited(sink, { now: () => 1_000, schedule: () => () => undefined, ...options }),
    );
    return entries;
  }

  test('a per-call number in data and a path inside a coded reason do not make new kinds', () => {
    const perCall = written((log) => {
      for (let call = 0; call < 100; call++)
        log.error('[rpc:service] stream failed', {
          service: 'owner.window',
          streamId: `s-${call}`,
          spanId: `sp-${call}`,
          userId: `u-${call}`,
          dimensions: { call },
          attempt: call,
          error: { code: 'EPIPE', message: 'EPIPE' },
        });
    });
    const idsOnly = written((log) => {
      for (let call = 0; call < 100; call++)
        log.error('[rpc:service] stream failed', {
          service: 'owner.window',
          streamId: `s-${call}`,
          error: { code: 'EPIPE', message: 'EPIPE' },
        });
    });
    const pathInMessage = written((log) => {
      for (let call = 0; call < 10; call++)
        log.error('[rpc] owner I/O failed', {
          service: 'x',
          error: {
            name: 'Error',
            code: 'ENOENT',
            message: `ENOENT lstat '/run/owner-${String.fromCharCode(97 + call)}.sock'`,
          },
        });
    });
    const duration = written((log) => {
      for (let call = 0; call < 10; call++) log.warn('slow', { durationMs: 100 + call });
    });
    expect(perCall).toHaveLength(1);
    expect(idsOnly).toHaveLength(1);
    expect(pathInMessage).toHaveLength(1);
    expect(duration).toHaveLength(1);
  });

  test('a different code, a different name, a different number field or a reason without code stay apart', () => {
    const entries = written((log) => {
      log.error('x', { error: { code: 'EPIPE' } });
      log.error('x', { error: { code: 'ECONNRESET' } });
      log.error('x', { error: Object.assign(new TypeError('EPIPE'), { code: 'EPIPE' }) });
      log.error('x', { status: 500 });
      log.error('x', { attempts: 500 });
      log.error('x', { error: new Error('open /a failed') });
      log.error('x', { error: new Error('open /b failed') });
      log.error('x', { ok: true });
      log.error('x', { ok: false });
    });
    expect(entries.map((entry) => entry.data)).toHaveLength(9);
  });

  test('a category code with different messages is different kinds; a system error naming its code is one', () => {
    const categories = written((log) => {
      log.error('[stitchkit] global onError failed', {
        error: new AppError('INTERNAL_ERROR', { message: 'database connection refused' }),
      });
      log.error('[stitchkit] global onError failed', {
        error: new AppError('INTERNAL_ERROR', {
          message: 'cannot read properties of undefined',
        }),
      });
      for (const message of [
        'open /etc/app/a.json EACCES',
        'launchctl bootstrap failed: plist invalid',
        'systemctl restart failed (exit 1)',
      ])
        log.error('service apply failed', {
          error: Object.assign(new Error(message), { code: 'COMMAND_FAILED' }),
        });
    });
    expect(categories.map((entry) => entry.data?.error)).toHaveLength(5);
    const system = written((log) => {
      for (const path of ['/run/a.sock', '/run/b.sock', '/run/c.sock'])
        log.error('connect failed', {
          error: Object.assign(new Error(`connect ENOENT ${path}`), { code: 'ENOENT' }),
        });
    });
    expect(system).toHaveLength(1);
  });

  test('a numeric code, which nearly every message holds as a word, never stands for the message', () => {
    const entries = written((log) => {
      // `execFile` names the exit status `code`; its message carries the command and stderr.
      for (const stderr of ['config line 1: bad value', 'disk 1 is full'])
        log.error('backup step failed', {
          error: Object.assign(new Error(`Command failed: /bin/sh -c step\n${stderr}`), {
            code: 1,
          }),
        });
      for (const reason of ['database down', 'disk full'])
        log.error('upstream failed', {
          error: Object.assign(new Error(`HTTP 500: ${reason}`), { code: 500 }),
        });
      // A number spelled as a string is a number too.
      for (const reason of ['quota', 'timeout'])
        log.error('remote failed', {
          error: Object.assign(new Error(`429 ${reason}`), { code: '429' }),
        });
    });
    expect(entries).toHaveLength(6);
  });

  test('kindOf names the kind, and kinds of different levels never merge', () => {
    const seen: unknown[][] = [];
    const entries = written(
      (log) => {
        for (const path of ['/etc/app/a.json', '/etc/app/b.json', '/etc/app/c.json'])
          log.warn('read failed', { path });
        log.error('read failed', { path: '/etc/app/a.json' });
        log.warn('other', { path: '/x' });
      },
      {
        kindOf: (level: string, message: string, data?: Record<string, unknown>) => {
          seen.push([level, message, data?.path]);
          return message;
        },
      },
    );
    expect(entries.map((entry) => [entry.level, entry.msg, entry.data?.path])).toEqual([
      ['warn', 'read failed', '/etc/app/a.json'],
      ['error', 'read failed', '/etc/app/a.json'],
      ['warn', 'other', '/x'],
    ]);
    expect(seen[1]).toEqual(['warn', 'read failed', '/etc/app/b.json']);
    // Without kindOf the three paths are three kinds: a string field is part of the kind.
    const defaults = written((log) => {
      for (const path of ['/etc/app/a.json', '/etc/app/b.json'])
        log.warn('read failed', { path });
    });
    expect(defaults).toHaveLength(2);
  });

  test('createJsonLogger and createBoundedLogger pass kindOf and the kind rule through repeat', () => {
    const lines: string[] = [];
    const json = createJsonLogger({
      now: () => 1_000,
      write: (line) => lines.push(line),
      repeat: { schedule: () => () => undefined },
    });
    for (let call = 0; call < 5; call++)
      json.error('retry failed', {
        attempt: call,
        error: { code: 'EPIPE', message: `EPIPE ${call}` },
      });
    expect(lines).toHaveLength(1);

    const { sink, entries } = createSink();
    const bounded = createBoundedLogger({
      sink,
      repeat: {
        now: () => 1_000,
        schedule: () => () => undefined,
        kindOf: (_level, message) => message,
      },
    });
    bounded.warn('read failed', { path: '/a' });
    bounded.warn('read failed', { path: '/b' });
    expect(entries).toHaveLength(1);
  });
});

describe('repeatLimited holds no data it has written', () => {
  test('a written entry, and a suppressed one once its count is written, keep no reference to the caller data', async () => {
    let flush: (() => void) | undefined;
    // The sink keeps nothing either: what stays reachable is only what repeat holds.
    const drop = () => undefined;
    const log = repeatLimited(
      { debug: drop, info: drop, warn: drop, error: drop },
      {
        now: () => 1_000,
        schedule: (run) => {
          flush = run;
          return () => undefined;
        },
      },
    );
    const refs: WeakRef<object>[] = [];
    const entry = (payload: object) => {
      refs.push(new WeakRef(payload));
      log.error('stream failed', { payload: [payload] });
    };
    entry({ written: 'first' });
    entry({ suppressed: 'second' });
    flush?.();
    // A WeakRef keeps its target alive until the job that made it ends.
    await Bun.sleep(0);
    Bun.gc(true);
    expect(refs.map((ref) => ref.deref())).toEqual([undefined, undefined]);
  });
});
