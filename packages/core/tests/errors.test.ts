import { describe, expect, test } from 'bun:test';
import { z } from 'zod';
import {
  ApiError,
  zodIssues as barrelZodIssues,
  createClient,
  createHttpClient,
  type ZodIssueSummary,
} from '../src';
import {
  AppError,
  appError,
  defineContract,
  isStitchErrorCode,
  STITCH_ERROR_STATUS,
} from '../src/contract';
import { formatZodError, normalizeError, zodIssues } from '../src/internal/errors';
import { createServer, implement } from '../src/server';

describe('stitch error registry', () => {
  test('STITCH_ERROR_STATUS maps codes → status (incl. METHOD_NOT_ALLOWED 405)', () => {
    expect(STITCH_ERROR_STATUS.METHOD_NOT_ALLOWED).toBe(405);
    expect(STITCH_ERROR_STATUS.NOT_FOUND).toBe(404);
    expect(STITCH_ERROR_STATUS.VALIDATION_ERROR).toBe(400);
    expect(STITCH_ERROR_STATUS.INTERNAL_SERVER_ERROR).toBe(500);
  });

  test('isStitchErrorCode guards framework vs app codes', () => {
    expect(isStitchErrorCode('NOT_FOUND')).toBe(true);
    expect(isStitchErrorCode('METHOD_NOT_ALLOWED')).toBe(true);
    expect(isStitchErrorCode('BOT_NOT_FOUND')).toBe(false);
    for (const code of ['toString', 'constructor', 'valueOf', '__proto__', 'hasOwnProperty']) {
      expect(isStitchErrorCode(code)).toBe(false);
    }
  });

  test('prototype keys remain application errors with a valid 500 status', () => {
    for (const code of ['toString', 'constructor', 'valueOf', '__proto__']) {
      let error: unknown;
      try {
        appError(code);
      } catch (caught) {
        error = caught;
      }
      expect(AppError.is(error) && error.status).toBe(500);
      if (!AppError.is(error)) throw new Error('Expected AppError');
      expect(() => Response.json(error.toJSON(), { status: error.status })).not.toThrow();
    }
  });

  test('appError maps a stitch code to its status, an app code to 500', () => {
    let mna: unknown;
    try {
      appError('METHOD_NOT_ALLOWED', 'nope');
    } catch (e) {
      mna = e;
    }
    expect(AppError.is(mna) && mna.status).toBe(405);

    let app: unknown;
    try {
      appError('BOT_NOT_FOUND');
    } catch (e) {
      app = e;
    }
    expect(AppError.is(app) && app.status).toBe(500);
  });
});

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

  test('ZodError carries structured field issues in details', () => {
    const schema = z.object({ name: z.string(), age: z.number() });
    const result = schema.safeParse({ name: 123, age: 'x' });
    if (result.success) throw new Error('Expected failure');

    const appErr = normalizeError(result.error);
    // Machine clients match on fields, not the text message.
    expect(appErr.details?.issues).toEqual([
      { path: 'name', code: 'invalid_type', message: expect.any(String) },
      { path: 'age', code: 'invalid_type', message: expect.any(String) },
    ]);
    // And the details survive the envelope.
    expect(appErr.toJSON().error.details).toBeDefined();
  });

  test('a realtime contract violation is scrubbed before it reaches the caller', async () => {
    const { realtimeContractViolation } = await import('../src/realtime/rejection');
    const parsed = z.object({ roomId: z.string() }).safeParse({ roomId: 42 });
    if (parsed.success) throw new Error('fixture must fail validation');
    const { error } = realtimeContractViolation({
      event: 'order:updated',
      direction: 'server-outbound',
      phase: 'arguments',
      reason: 'invalid-arguments',
      fault: 'local',
      cause: parsed.error,
    });
    const scrubbed = normalizeError(error);
    // The code and status survive (a server fault), but the event name, field
    // paths and fault attribution are internal shape and must not cross out.
    expect(scrubbed.code).toBe('REALTIME_CONTRACT_VIOLATION');
    expect(scrubbed.status).toBe(500);
    expect(scrubbed.message).toBe('Realtime contract violation');
    expect(scrubbed.message).not.toContain('order:updated');
    expect(scrubbed.details).toBeUndefined();
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

describe('zodIssues', () => {
  test('projects every issue to { path, code, message }', () => {
    const schema = z.object({ user: z.object({ name: z.string() }) });
    const result = schema.safeParse({ user: { name: 5 } });
    if (result.success) throw new Error('Expected failure');

    expect(zodIssues(result.error)).toEqual([
      { path: 'user.name', code: 'invalid_type', message: expect.any(String) },
    ]);
  });

  test('a root-level issue reports (root)', () => {
    const result = z.string().safeParse(123);
    if (result.success) throw new Error('Expected failure');
    expect(zodIssues(result.error)[0]?.path).toBe('(root)');
  });
});

/*
 * One projection, both sides — and reached through the door a browser may open.
 *
 * `zodIssues` is what a `VALIDATION_ERROR` already travels in, and until now the only entry that
 * exported it was `stitchkit/server`, which pulls `Bun.serve`. So a caller rendering
 * `ApiError.details.issues` had to hand-write the shape, and every consumer wrote its own — the
 * "N shapes of one thing" a contract-first framework exists to prevent, produced by the framework.
 *
 * The import below is deliberately from `../src` and not from `../src/internal/errors`: the barrel
 * IS the thing under test, and an import of the internal path would stay green with the export
 * removed. The comparison against a live server is the other half — an export that agreed with
 * nothing would be decoration.
 */
describe('the issue projection is reachable from the browser entry and equals the wire', () => {
  const contract = defineContract(
    { prefix: 'issues' },
    {
      create: {
        method: 'POST',
        path: '/create',
        desc: 'Create',
        input: z.object({ name: z.string().min(3), age: z.number().int() }),
        output: z.object({ ok: z.boolean() }),
      },
    },
  );

  test('a server refusal carries exactly what the barrel projects locally', async () => {
    const server = createServer({
      port: 0,
      services: [implement(contract, { create: () => ({ ok: true }) })],
    });
    try {
      const api = createClient(
        contract,
        createHttpClient({ baseUrl: server.url, retry: { limit: 0 } }),
      );
      const bad = { name: 'ab', age: 'old' };
      const settled = await (
        api as unknown as Record<string, (a: unknown) => Promise<unknown>>
      )
        .create?.(bad)
        .then(
          () => undefined,
          (error: unknown) => error,
        );
      if (!ApiError.is(settled))
        throw new Error(`expected an ApiError, got ${String(settled)}`);

      // The denominator: a comparison of two empty lists would pass while proving nothing.
      // Typed through the exported type, which is half of what the export is for: a caller
      // reading `details.issues` had no public name for its element.
      const wire = (settled.details as { issues: ZodIssueSummary[] }).issues;
      expect(wire.length).toBeGreaterThan(1);

      const parsed = contract.endpoints.create.input.safeParse(bad);
      if (parsed.success) throw new Error('the probe value was supposed to be invalid');
      expect(barrelZodIssues(parsed.error)).toEqual(wire);
    } finally {
      await server.shutdown({ gracePeriodMs: 500 });
    }
  });
});
