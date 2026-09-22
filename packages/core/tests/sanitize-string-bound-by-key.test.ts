import { describe, expect, test } from 'bun:test';
import type { StitchLogger } from '../src/logger';
import { createBoundedLogger, redact, sanitizePayload } from '../src/observability';

/*
 * One string bound for the whole record cuts an error's stack from the bottom — which is
 * exactly where the consumer's own frames are. The frames at the top belong to the framework
 * and the runtime; the ones that say what the application was doing are the ones that fall
 * off. The fix is a ceiling for `stack` alone, keyed by name rather than path: the stack is at
 * the top of one record and under `errorDetail` in the next, and its ceiling is the same in
 * both places.
 */

const stack = [
  'Error: boom',
  ...Array.from({ length: 40 }, (_, i) => `    at frame${i} (app.ts:${i})`),
].join('\n');

describe('a string bound can be raised for one key without touching the rest', () => {
  test('the keyed bound wins for that key, wherever it sits', () => {
    const out = redact(
      { stack, note: 'x'.repeat(200), errorDetail: { stack } },
      { maxStringLength: 50, maxStringLengthByKey: { stack: 10_000 } },
    ) as Record<string, unknown>;
    expect(out.stack).toBe(stack);
    expect((out.errorDetail as Record<string, unknown>).stack).toBe(stack);
    // Everything else keeps the record-wide bound.
    expect(out.note).toBe(`${'x'.repeat(50)}…[truncated]`);
  });

  test('an Error value honours the keyed bound for its own stack', () => {
    const error = new Error('boom');
    error.stack = stack;
    const out = redact(
      { error },
      { maxStringLength: 50, maxStringLengthByKey: { stack: 10_000 } },
    ) as {
      error: { stack: string; message: string };
    };
    expect(out.error.stack).toBe(stack);
    expect(out.error.message).toBe('boom');
  });

  test('without the option the record-wide bound applies exactly as before', () => {
    const out = redact({ stack }, { maxStringLength: 50 }) as { stack: string };
    expect(out.stack).toBe(`${stack.slice(0, 50)}…[truncated]`);
  });

  test('a keyed bound never means "no bound": the record ceiling still has the last word', () => {
    // `redact` shapes values; `sanitizePayload` is where `maxBytes` is enforced. A raised
    // ceiling for one key does not exempt the record from that — it did not fit, so it
    // collapsed, and the decision was made for the record rather than by cutting the field
    // short in advance.
    const out = sanitizePayload(
      { stack: 'y'.repeat(100_000) },
      { maxStringLength: 50, maxStringLengthByKey: { stack: 1_000_000 }, maxBytes: 1_024 },
    );
    expect(JSON.stringify(out).length).toBeLessThan(2_000);
  });

  test('createBoundedLogger accepts the same bound through `bounds`', () => {
    const lines: unknown[] = [];
    const push = (message: string, data?: Record<string, unknown>) => {
      lines.push([message, data]);
    };
    const sink: StitchLogger = { debug: push, info: push, warn: push, error: push };
    const logger = createBoundedLogger({
      sink,
      bounds: { stringLength: 50, stringLengthByKey: { stack: 10_000 } },
    });
    logger.error('failed', { stack, note: 'x'.repeat(200) });
    const serialized = JSON.stringify(lines);
    expect(serialized).toContain('frame39');
    expect(serialized).toContain('…[truncated]');
  });
});
