import { describe, expect, test } from 'bun:test';
import { z } from 'zod';
import { AppError, badRequest } from '../src/contract';
import { runWithRequestContext } from '../src/observability/context';
import { createTraceContext } from '../src/observability/trace';
import { errorResponse, parseBody, respondJson } from '../src/server/raw';

describe('respondJson', () => {
  test('serializes data as JSON', async () => {
    const res = respondJson({ ok: true, n: 1 });
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toContain('application/json');
    expect(await res.json()).toEqual({ ok: true, n: 1 });
  });

  test('null → 204 No Content', async () => {
    const res = respondJson(null);
    expect(res.status).toBe(204);
    expect(await res.text()).toBe('');
  });

  test('undefined → 204 No Content', () => {
    expect(respondJson(undefined).status).toBe(204);
  });
});

describe('errorResponse', () => {
  test('AppError → framework envelope + its status', async () => {
    const res = errorResponse(
      new AppError('FORBIDDEN', 'nope', 403, { reason: 'x' }, 'try again'),
    );
    expect(res.status).toBe(403);
    expect(await res.json()).toEqual({
      error: {
        code: 'FORBIDDEN',
        message: 'nope',
        details: { reason: 'x' },
        hint: 'try again',
      },
    });
  });

  test('a thrown helper (badRequest) round-trips through errorResponse', async () => {
    let res: Response | undefined;
    try {
      badRequest('bad input');
    } catch (err) {
      res = errorResponse(err);
    }
    expect(res?.status).toBe(400);
    expect((await res?.json())?.error.code).toBe('BAD_REQUEST');
  });

  test('a generic Error → 500 INTERNAL_SERVER_ERROR (no internal leak)', async () => {
    const res = errorResponse(new Error('db connection string leaked'));
    expect(res.status).toBe(500);
    const body = await res.json();
    expect(body.error.code).toBe('INTERNAL_SERVER_ERROR');
    expect(body.error.message).toBe('Internal server error');
  });

  test('stamps x-request-id with the trace id when in a request context', () => {
    const trace = createTraceContext();
    const res = runWithRequestContext(
      { trace, source: 'http', method: 'GET', path: '/x', startedAt: 0n },
      () => errorResponse(new AppError('CONFLICT', 'dup', 409)),
    );
    expect(res.headers.get('x-request-id')).toBe(trace.traceId);
  });

  test('no x-request-id outside a request context', () => {
    expect(
      errorResponse(new AppError('CONFLICT', 'dup', 409)).headers.get('x-request-id'),
    ).toBeNull();
  });
});

describe('parseBody', () => {
  const schema = z.object({ name: z.string(), age: z.number() });
  const req = (body: string) =>
    new Request('http://x/p', {
      method: 'POST',
      body,
      headers: { 'content-type': 'application/json' },
    });

  test('valid body → typed value', async () => {
    expect(await parseBody(req('{"name":"a","age":3}'), schema)).toEqual({
      name: 'a',
      age: 3,
    });
  });

  test('schema-invalid body → null (no throw)', async () => {
    expect(await parseBody(req('{"name":"a"}'), schema)).toBeNull();
  });

  test('non-JSON body → null (no throw)', async () => {
    expect(await parseBody(req('not json'), schema)).toBeNull();
  });
});
