import { expect, test } from 'bun:test';
import { hasFunctions } from '../src/internal/darwin-binding';
import { DarwinBackendError, darwinNativeCode } from '../src/internal/darwin-binding-error';

test('backend JSON preserves bounded diagnostic identity and keeps the live cause private', () => {
  const native = Object.assign(new Error('/private/author/path contains secret-value'), {
    code: 'MODULE_NOT_FOUND',
  });
  const cause = new Error('loader context contains secret-value', { cause: native });
  const error = new DarwinBackendError('resolve', cause);
  expect(error).toBeInstanceOf(Error);
  expect(error.cause).toBe(cause);
  expect(cause.cause).toBe(native);
  const serialized = JSON.stringify({ state: 'unavailable', cause: error });
  expect(JSON.parse(serialized)).toEqual({
    state: 'unavailable',
    cause: {
      name: 'DarwinBackendError',
      code: 'DARWIN_BACKEND_UNAVAILABLE',
      stage: 'resolve',
      architecture: process.arch,
      message: 'The packaged Darwin backend is missing',
      nativeCode: 'MODULE_NOT_FOUND',
    },
  });
  expect(serialized).not.toContain('secret-value');
  expect(serialized).not.toContain('/private');
  expect(serialized).not.toContain('stack');
});

test('unknown native codes and cyclic cause chains cannot expose arbitrary text or recurse', () => {
  const error = Object.assign(new Error('secret-value'), { code: 'SECRET_VALUE' });
  Object.defineProperty(error, 'cause', { value: error });
  expect(darwinNativeCode(error)).toBeUndefined();
  expect(JSON.stringify(new DarwinBackendError('load', error))).not.toContain('SECRET');
  expect(darwinNativeCode({ code: 'MODULE_NOT_FOUND' })).toBeUndefined();
  expect(darwinNativeCode(new Error('ENOENT by inference'))).toBeUndefined();
});

test('invalid addon callable surface refuses instead of blessing a partial backend', () => {
  expect(
    hasFunctions({ processIdentity: () => undefined }, ['processIdentity', 'openFileAt']),
  ).toBe(false);
  expect(hasFunctions({ processIdentity: 'callable by name' }, ['processIdentity'])).toBe(
    false,
  );
  expect(hasFunctions(null, ['processIdentity'])).toBe(false);
  expect(hasFunctions({ processIdentity: () => undefined }, ['processIdentity'])).toBe(true);
});
