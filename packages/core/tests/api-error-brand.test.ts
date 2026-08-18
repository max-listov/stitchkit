/**
 * `ApiError.is` is brand-based (Symbol.for('stitchkit.ApiError')), mirroring
 * `AppError` (→ ADR 0032): the published dist carries this class in more than
 * one chunk, and an instance from one chunk is not `instanceof` the other's
 * class. With the old `instanceof` check the `ApiError → AppError` conversion
 * in `implementRemote` was a dead branch — every remote failure flattened to
 * `INTERNAL_SERVER_ERROR`, killing differentiated consumer exit codes.
 * Reported by a consumer CLI; reproduced against the published 0.52.0 dist.
 */
import { describe, expect, test } from 'bun:test';
import { z } from 'zod';
import { ApiError, type HttpClient } from '../src/browser/http';
import { AppError, defineContract, type RuntimeContext } from '../src/contract';
import { implementRemote } from '../src/tools/remote';

const BRAND = Symbol.for('stitchkit.ApiError');

/** An `ApiError` as another build chunk produces it — same brand, foreign class. */
function foreignApiError(): Error {
  const error = Object.assign(new Error('unauthorized'), {
    name: 'ApiError',
    code: 'USER_NOT_AUTHENTICATED',
    status: 401,
    hint: 'renew the key',
    traceId: 'trace-401',
  });
  Object.defineProperty(error, BRAND, { value: true });
  return error;
}

describe('ApiError.is — brand-based, cross-chunk safe', () => {
  test('recognises a real ApiError', () => {
    expect(ApiError.is(new ApiError('X', 400))).toBe(true);
  });

  test('recognises a foreign-chunk ApiError carrying the same brand', () => {
    const foreign = foreignApiError();
    expect(foreign instanceof ApiError).toBe(false); // the bug, with instanceof
    expect(ApiError.is(foreign)).toBe(true); // the fix, with the brand
  });

  test('rejects non-ApiError values', () => {
    expect(ApiError.is(new Error('x'))).toBe(false);
    expect(ApiError.is({ code: 'X', status: 400 })).toBe(false);
    expect(ApiError.is(null)).toBe(false);
  });

  test('the brand does not leak into JSON / keys', () => {
    const error = new ApiError('X', 400);
    expect(Object.keys(error)).not.toContain(BRAND);
    expect(JSON.stringify(error)).not.toContain('stitchkit.ApiError');
  });
});

const contract = defineContract(
  { prefix: 'me' },
  {
    get: {
      method: 'GET',
      path: '/',
      desc: 'Who am I',
      output: z.object({ id: z.string() }),
    },
  },
);

function throwingHttp(error: Error): HttpClient {
  const reject = () => Promise.reject(error);
  return {
    get: reject,
    head: reject,
    post: reject,
    put: reject,
    patch: reject,
    delete: reject,
    setServerContext: () => undefined,
    subscribe: () => () => undefined,
    logout: () => undefined,
    resetLogoutState: () => undefined,
  };
}

const ctx: RuntimeContext = { params: undefined, input: undefined, source: 'TOOL' };

describe('implementRemote error conversion', () => {
  test('a foreign-chunk ApiError converts to AppError with code, status, hint and traceId', async () => {
    const service = implementRemote(contract, throwingHttp(foreignApiError()));
    const handler = service.methods.get?.handler;
    if (!handler) throw new Error('handler missing');

    let thrown: unknown;
    try {
      await handler(ctx);
    } catch (error) {
      thrown = error;
    }
    expect(AppError.is(thrown)).toBe(true);
    if (!AppError.is(thrown)) throw new Error('unreachable');
    expect(thrown.code).toBe('USER_NOT_AUTHENTICATED');
    expect(thrown.status).toBe(401);
    expect(thrown.hint).toBe('renew the key');
    expect(thrown.traceId).toBe('trace-401');
  });

  test('an ApiError thrown by transformArgs converts the same way', async () => {
    const service = implementRemote(contract, throwingHttp(new Error('unused')), {
      transformArgs: () => {
        throw new ApiError('RATE_LIMITED', 429, undefined, 'slow down', 'wait', 'trace-429');
      },
    });
    const handler = service.methods.get?.handler;
    if (!handler) throw new Error('handler missing');

    let thrown: unknown;
    try {
      await handler(ctx);
    } catch (error) {
      thrown = error;
    }
    expect(AppError.is(thrown)).toBe(true);
    if (!AppError.is(thrown)) throw new Error('unreachable');
    expect(thrown.code).toBe('RATE_LIMITED');
    expect(thrown.status).toBe(429);
    expect(thrown.traceId).toBe('trace-429');
  });

  test('a non-ApiError from the call is rethrown untouched', async () => {
    const raw = new Error('boom');
    const service = implementRemote(contract, throwingHttp(raw));
    const handler = service.methods.get?.handler;
    if (!handler) throw new Error('handler missing');
    expect(handler(ctx)).rejects.toBe(raw);
  });
});
