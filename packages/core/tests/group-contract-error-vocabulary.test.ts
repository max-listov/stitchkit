import { describe, expect, test } from 'bun:test';
import { AppError } from '../src/contract/errors';
import { defineErrors } from '../src/contract/errors-factory';
import { createErrorHook } from '../src/server/error-hook';

const vocabulary = defineErrors(
  {
    VALIDATION_ERROR: { status: 400, message: 'Invalid request' },
    NOT_FOUND: { status: 404, message: 'Missing' },
    INTERNAL_ERROR: { status: 500, message: 'Internal error' },
    METHOD_BLOCKED: { status: 405 },
  },
  {
    fallback: {
      400: 'VALIDATION_ERROR',
      404: 'NOT_FOUND',
      500: 'INTERNAL_ERROR',
    },
    // An override renames a framework code under its own status; the wire
    // keeps the framework status, so a 405 cannot become a 404 code.
    map: { METHOD_NOT_ALLOWED: 'METHOD_BLOCKED' },
  },
);

function compileTimeExhaustiveness(): void {
  defineErrors(
    { INTERNAL_ERROR: { status: 500 } },
    // @ts-expect-error — exhaustive vocabularies name every framework code.
    { exhaustive: true, map: { INTERNAL_SERVER_ERROR: 'INTERNAL_ERROR' } },
  );
}
void compileTimeExhaustiveness;

describe('defineErrors vocabulary mapping', () => {
  test('uses explicit status fallbacks and lets code overrides win', () => {
    expect(vocabulary.codeMap.BAD_REQUEST).toBe('VALIDATION_ERROR');
    expect(vocabulary.codeMap.FILE_NOT_FOUND).toBe('NOT_FOUND');
    expect(vocabulary.codeMap.METHOD_NOT_ALLOWED).toBe('METHOD_BLOCKED');
    expect(vocabulary.codeMap.INTERNAL_SERVER_ERROR).toBe('INTERNAL_ERROR');
    expect(vocabulary.codeMap.UNAUTHORIZED).toBeUndefined();
  });

  test('fails first when an untyped mapping names an undeclared code', () => {
    expect(() =>
      defineErrors(
        { INTERNAL_ERROR: { status: 500 } },
        JSON.parse('{"fallback":{"500":"UNKNOWN"}}'),
      ),
    ).toThrow('fallback 500 names undeclared code "UNKNOWN"');
  });

  test('rejects a status fallback whose application code has another status', () => {
    expect(() =>
      defineErrors(
        { NOT_FOUND: { status: 404 } },
        JSON.parse('{"fallback":{"500":"NOT_FOUND"}}'),
      ),
    ).toThrow('fallback 500 must name a code with status 500');
  });

  test('composes directly with createErrorHook and keeps branded AppErrors', async () => {
    const error = vocabulary.errors.NOT_FOUND();
    expect(AppError.is(error)).toBe(true);

    const hook = createErrorHook({
      vocabulary,
      render: (info) => ({ error: { code: info.code, message: info.message } }),
    });
    const response = await hook(
      { params: undefined, input: undefined, source: 'http' },
      new AppError('FILE_NOT_FOUND', 'No file', 404),
    );
    if (!(response instanceof Response)) throw new Error('Expected an error response');
    expect(response.status).toBe(404);
    expect(await response.json()).toEqual({
      error: { code: 'NOT_FOUND', message: 'No file' },
    });
  });
  test('a map target declared under another status is refused like a fallback is', () => {
    expect(() =>
      defineErrors({ GONE_APP: { status: 410 } }, { map: { NOT_FOUND: 'GONE_APP' } }),
    ).toThrow('maps "NOT_FOUND" (404) to "GONE_APP", declared with status 410');
    expect(
      defineErrors({ MISSING: { status: 404 } }, { map: { NOT_FOUND: 'MISSING' } }).codeMap
        .NOT_FOUND,
    ).toBe('MISSING');
  });

  test('createErrorHook refuses codeMap or unmappedCode beside a vocabulary at runtime', () => {
    const vocabulary = defineErrors(
      { MISSING: { status: 404 } },
      { map: { NOT_FOUND: 'MISSING' } },
    );
    const render = () => ({});
    // A JavaScript caller can pass what the type forbids; the runtime says so
    // instead of silently preferring one of the two maps.
    const config: Record<string, unknown> = { vocabulary, unmappedCode: 'CATCHALL', render };
    expect(() => createErrorHook(config as never)).toThrow('cannot be combined');
    expect(() => createErrorHook({ vocabulary, render })).not.toThrow();
  });
});
