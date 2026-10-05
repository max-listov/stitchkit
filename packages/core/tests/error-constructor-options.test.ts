import { expect, test } from 'bun:test';
import { ApiError } from '../src/browser/api-error';
import { AppError } from '../src/contract/errors';

test('AppError takes its code first and every other field by name', () => {
  const bare = new AppError('NOT_FOUND');
  expect(bare).toMatchObject({ code: 'NOT_FOUND', message: 'NOT_FOUND', status: 500 });
  expect('cause' in bare).toBe(false);
  const cause = new Error('upstream');
  const full = new AppError('CONFLICT', {
    message: 'stale',
    status: 409,
    details: { revision: 7 },
    hint: 'reload',
    traceId: 'trace-1',
    retryable: false,
    cause,
  });
  expect(full).toMatchObject({
    code: 'CONFLICT',
    message: 'stale',
    status: 409,
    details: { revision: 7 },
    hint: 'reload',
    traceId: 'trace-1',
    retryable: false,
  });
  expect(full.cause).toBe(cause);
  expect(full.toJSON()).toEqual({
    error: {
      code: 'CONFLICT',
      message: 'stale',
      details: { revision: 7 },
      hint: 'reload',
      retryable: false,
    },
  });
});

test('ApiError takes its code first and every other field by name', () => {
  const bare = new ApiError('NETWORK');
  expect(bare).toMatchObject({
    code: 'NETWORK',
    status: 0,
    message: 'NETWORK (no message supplied)',
  });
  expect('cause' in bare).toBe(false);
  const cause = new Error('socket');
  const full = new ApiError('RATE_LIMITED', {
    status: 429,
    details: { retryAfter: 3 },
    message: 'slow down',
    hint: 'wait',
    traceId: 'trace-429',
    retryable: true,
    cause,
  });
  expect(full).toMatchObject({
    status: 429,
    details: { retryAfter: 3 },
    message: 'slow down',
    hint: 'wait',
    traceId: 'trace-429',
    retryable: true,
  });
  expect(full.cause).toBe(cause);
  expect(ApiError.is(full)).toBe(true);
  expect(Object.keys(full)).not.toContain('Symbol(stitchkit.ApiError)');
});

test('an empty message still reads as unsupplied', () => {
  expect(new ApiError('X', { message: '' }).message).toBe('X (no message supplied)');
});
