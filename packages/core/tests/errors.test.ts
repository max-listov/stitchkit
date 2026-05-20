import { describe, expect, test } from 'bun:test';
import { z } from 'zod';
import { AppError } from '../src/contract';
import { formatZodError, normalizeError } from '../src/internal/errors';

describe('AppError', () => {
  test('hint field', () => {
    const err = new AppError(
      'NOT_FOUND',
      'missing',
      404,
      undefined,
      'Try list endpoint first',
    );
    expect(err.hint).toBe('Try list endpoint first');
    expect(err.code).toBe('NOT_FOUND');
    expect(err.status).toBe(404);
  });

  test('toJSON nests the public error payload', () => {
    const err = new AppError('ERR', 'msg', 500, { key: 'val' }, 'hint');
    const json = err.toJSON();
    expect(json.error.code).toBe('ERR');
    expect(json.error.message).toBe('msg');
    expect(json.error.details).toEqual({ key: 'val' });
    expect(json.error.hint).toBe('hint');
  });
});

describe('normalizeError', () => {
  test('AppError passthrough', () => {
    const err = new AppError('MY_ERROR', 'test', 422);
    expect(normalizeError(err)).toBe(err);
  });

  test('ZodError → VALIDATION_ERROR', () => {
    const schema = z.object({ name: z.string() });
    const result = schema.safeParse({ name: 123 });
    if (result.success) throw new Error('Expected failure');

    const appErr = normalizeError(result.error);
    expect(appErr.code).toBe('VALIDATION_ERROR');
    expect(appErr.status).toBe(400);
    expect(appErr.message).toContain('name');
  });

  test('generic Error → INTERNAL_SERVER_ERROR with a generic message', () => {
    const err = normalizeError(new Error('Something broke'));
    expect(err.code).toBe('INTERNAL_SERVER_ERROR');
    expect(err.status).toBe(500);
    // The raw message is logged server-side, never sent to the client.
    expect(err.message).toBe('Internal server error');
  });

  test('string error → generic message', () => {
    const err = normalizeError('raw string');
    expect(err.code).toBe('INTERNAL_SERVER_ERROR');
    expect(err.message).toBe('Internal server error');
  });

  test('an internal message never leaks into the envelope', () => {
    const secret = `db://user:${'x'.repeat(300)}@host`;
    const err = normalizeError(new Error(secret));
    expect(err.message).toBe('Internal server error');
    expect(err.message).not.toContain('db://');
  });
});

describe('formatZodError', () => {
  test('formats path + message', () => {
    const schema = z.object({
      name: z.string(),
      age: z.number(),
    });
    const result = schema.safeParse({ name: 123, age: 'old' });
    if (result.success) throw new Error('Expected failure');

    const formatted = formatZodError(result.error);
    expect(formatted).toContain('name');
    expect(formatted).toContain('age');
  });

  test('max 5 issues + suffix', () => {
    const schema = z.object({
      a: z.string(),
      b: z.string(),
      c: z.string(),
      d: z.string(),
      e: z.string(),
      f: z.string(),
      g: z.string(),
    });
    const result = schema.safeParse({});
    if (result.success) throw new Error('Expected failure');

    const formatted = formatZodError(result.error);
    const lines = formatted.split('\n').filter(Boolean);
    expect(lines.length).toBeLessThanOrEqual(6);
    expect(formatted).toContain('more issues');
  });
});
