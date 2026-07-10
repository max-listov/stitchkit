/**
 * `defineErrors` — typed domain-error throwers + a code table. The thrower
 * carries the declared HTTP status; the codes match on the client with
 * autocomplete instead of a magic `message` string.
 */
import { describe, expect, test } from 'bun:test';
import { AppError, defineErrors } from '../src/contract';

const { errors, codes, isCode } = defineErrors({
  SESSION_NOT_FOUND: 404,
  QUOTA_EXCEEDED: 429,
});

describe('defineErrors', () => {
  test('a thrower throws an AppError with the declared code and status', () => {
    try {
      errors.SESSION_NOT_FOUND('no such session', { sessionId: 's1' }, 'log back in');
      throw new Error('should have thrown');
    } catch (err) {
      expect(AppError.is(err)).toBe(true);
      if (AppError.is(err)) {
        expect(err.code).toBe('SESSION_NOT_FOUND');
        expect(err.status).toBe(404);
        expect(err.message).toBe('no such session');
        expect(err.details).toEqual({ sessionId: 's1' });
        expect(err.hint).toBe('log back in');
      }
    }
  });

  test('status follows each code', () => {
    try {
      errors.QUOTA_EXCEEDED();
    } catch (err) {
      expect(AppError.is(err) && err.status).toBe(429);
    }
  });

  test('codes are their own literals — for client-side matching', () => {
    expect(codes.SESSION_NOT_FOUND).toBe('SESSION_NOT_FOUND');
    expect(codes.QUOTA_EXCEEDED).toBe('QUOTA_EXCEEDED');
  });

  test('isCode narrows to the declared set', () => {
    expect(isCode('SESSION_NOT_FOUND')).toBe(true);
    expect(isCode('SOMETHING_ELSE')).toBe(false);
  });

  test('the thrown AppError serialises the code into the envelope', () => {
    try {
      errors.SESSION_NOT_FOUND('gone');
    } catch (err) {
      if (AppError.is(err)) {
        expect(err.toJSON()).toEqual({
          error: { code: 'SESSION_NOT_FOUND', message: 'gone' },
        });
      }
    }
  });
});
