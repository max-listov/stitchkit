import { describe, expect, test } from 'bun:test';
import type { StitchLogger } from '../src/logger';
import { createBoundedLogger } from '../src/observability/bounded-logger';
import { runWithRequestContext } from '../src/observability/context';
import { createTraceContext } from '../src/observability/trace';

function capturingSink(rows: unknown[][]): StitchLogger {
  const push = (level: string) => (message: string, data?: Record<string, unknown>) => {
    rows.push([level, message, data]);
  };
  return {
    info: push('info'),
    warn: push('warn'),
    error: push('error'),
    debug: push('debug'),
  };
}

describe('bounded logger', () => {
  test('redacts message, nested data and Error before applying bounds', () => {
    const rows: unknown[][] = [];
    const logger = createBoundedLogger({
      sink: capturingSink(rows),
      sensitiveUrlPatterns: [/\/verify\/[^\s]+/g],
      bounds: { stringLength: 40, collectionLength: 3, depth: 4 },
    });
    logger.error('failed /verify/top-secret', {
      nested: { token: 'secret' },
      error: new Error('bad /verify/error-secret'),
      list: [1, 2, 3, 4],
    });
    const serialized = JSON.stringify(rows);
    expect(serialized).not.toContain('top-secret');
    expect(serialized).not.toContain('error-secret');
    expect(serialized).not.toContain('"secret"');
    expect(serialized).toContain('[redacted]');
    expect(serialized).toContain('[truncated 1 items]');
  });

  test('reserved request context wins over caller data', () => {
    const rows: unknown[][] = [];
    const trace = createTraceContext();
    const logger = createBoundedLogger({ sink: capturingSink(rows) });
    runWithRequestContext(
      {
        trace,
        source: 'http',
        method: 'GET',
        path: '/',
        startedAt: 0n,
        userId: 'real-user',
        dimensions: { project: 'real-project' },
      },
      () =>
        logger.info('ok', {
          traceId: 'fake',
          userId: 'fake',
          dimensions: { project: 'fake' },
        }),
    );
    expect(rows[0]?.[2]).toMatchObject({
      traceId: trace.traceId,
      spanId: trace.spanId,
      userId: 'real-user',
      dimensions: { project: 'real-project' },
    });
  });

  test('cycles, BigInt, throwing getters and sink failure never escape', () => {
    const data: Record<string, unknown> = { amount: 1n };
    data.self = data;
    Object.defineProperty(data, 'broken', {
      enumerable: true,
      get: () => {
        throw new Error('getter');
      },
    });
    const logger = createBoundedLogger({
      sink: {
        info: () => {
          throw new Error('sink');
        },
        warn: () => {
          throw new Error('sink');
        },
        error: () => {
          throw new Error('sink');
        },
        debug: () => {
          throw new Error('sink');
        },
      },
    });
    expect(() => logger.info('safe', data)).not.toThrow();
  });

  test('preserves an explicit marker and preview when the whole entry is bounded', () => {
    const rows: unknown[][] = [];
    const logger = createBoundedLogger({
      sink: {
        info: (...args: unknown[]) => rows.push(args),
        warn: () => undefined,
        error: () => undefined,
        debug: () => undefined,
      },
      bounds: { entryBytes: 128 },
    });
    logger.info('large', { value: 'x'.repeat(1_000) });
    const row = rows[0];
    if (!row) throw new Error('logger sink row was not written');
    expect(row[0]).toBe('[truncated log entry]');
    expect(row[1]).toMatchObject({ _truncated: true });
    expect((row[1] as { preview?: string }).preview).toContain('larg');
    expect(
      new TextEncoder().encode(JSON.stringify({ message: row[0], data: row[1] })).byteLength,
    ).toBeLessThanOrEqual(128);
  });
});
