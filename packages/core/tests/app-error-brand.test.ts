import { describe, expect, test } from 'bun:test';
import { AppError, badRequest } from '../src/contract';
import { normalizeError } from '../src/internal/errors';
import { toolResultFromError } from '../src/tools/execute';

const BRAND = Symbol.for('stitchkit.AppError');

describe('AppError.is — brand-based, cross-chunk safe', () => {
  test('recognises a real AppError and a consumer subclass', () => {
    expect(AppError.is(new AppError('X', 'm', 400))).toBe(true);

    class DomainError extends AppError {
      constructor() {
        super('FEATURE_LOCKED', 'locked', 403);
      }
    }
    expect(AppError.is(new DomainError())).toBe(true);
  });

  test('recognises a DUPLICATE class carrying the same brand (the cross-chunk case)', () => {
    // Simulates a second build chunk's `AppError` — a different class identity,
    // the same global brand. `instanceof` (the old check) would miss it.
    const fromOtherChunk = {
      name: 'AppError',
      code: 'FEATURE_LOCKED',
      message: 'locked',
      [BRAND]: true,
    };
    expect(fromOtherChunk instanceof AppError).toBe(false); // the bug, with instanceof
    expect(AppError.is(fromOtherChunk)).toBe(true); // the fix, with the brand
  });

  test('rejects non-AppError values', () => {
    expect(AppError.is(new Error('x'))).toBe(false);
    expect(AppError.is({ code: 'X' })).toBe(false);
    expect(AppError.is(null)).toBe(false);
    expect(AppError.is('FEATURE_LOCKED')).toBe(false);
  });

  test('the brand does not leak into JSON / keys', () => {
    const err = new AppError('X', 'm', 400, { field: 'a' });
    expect(JSON.stringify(err.toJSON())).not.toContain('stitchkit.AppError');
    expect(Object.keys(err)).not.toContain('Symbol(stitchkit.AppError)');
  });

  test('tool-path: a branded error keeps its own code, not INTERNAL_SERVER_ERROR', () => {
    const fromOtherChunk = {
      name: 'AppError',
      code: 'FEATURE_LOCKED',
      message: 'locked',
      [BRAND]: true,
    };
    // normalizeError (HTTP path) and toolResultFromError (tool path) both route
    // through AppError.is — the exact failure the consumer hit on MCP/agent.
    expect(normalizeError(fromOtherChunk).code).toBe('FEATURE_LOCKED');
    expect(toolResultFromError(fromOtherChunk).code).toBe('FEATURE_LOCKED');

    try {
      badRequest('bad', { field: 'x' });
    } catch (e) {
      expect(toolResultFromError(e).code).toBe('BAD_REQUEST');
    }
  });
});
