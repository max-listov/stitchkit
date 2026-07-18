/**
 * `createErrorHook` — turns a thrown value into one wire envelope, remapping
 * stitchkit's codes to the app's, never leaking an internal message.
 */
import { describe, expect, test } from 'bun:test';
import { z } from 'zod';
import { AppError, type RuntimeContext, type StitchErrorCode } from '../src/contract';
import { createErrorHook } from '../src/server';

const onError = createErrorHook({
  codeMap: {
    BAD_REQUEST: 'bad_request',
    VALIDATION_ERROR: 'bad_request',
    UNAUTHORIZED: 'unauthenticated',
    FORBIDDEN: 'forbidden',
    NOT_FOUND: 'not_found',
    METHOD_NOT_ALLOWED: 'not_found',
    CONFLICT: 'conflict',
    RATE_LIMITED: 'rate_limited',
    INTERNAL_SERVER_ERROR: 'internal',
  } satisfies Record<StitchErrorCode, string>,
  render: (info) => ({ ok: false, error: { code: info.code, message: info.message } }),
});

// The hook only reads `error`; a minimal valid context satisfies the signature.
const ctx: RuntimeContext = { params: undefined, input: undefined, source: 'http' };

describe('createErrorHook', () => {
  test('remaps a stitchkit code to the app wire code and keeps the status', async () => {
    const res = await onError(ctx, new AppError('NOT_FOUND', 'nope', 404));
    expect(res?.status).toBe(404);
    expect(await res?.json()).toEqual({
      ok: false,
      error: { code: 'not_found', message: 'nope' },
    });
  });

  test("an app's own code passes through unmapped", async () => {
    const res = await onError(ctx, new AppError('SESSION_NOT_FOUND', 'gone', 404));
    expect(await res?.json()).toEqual({
      ok: false,
      error: { code: 'SESSION_NOT_FOUND', message: 'gone' },
    });
  });

  test('a raw (non-AppError) throw becomes a generic 500 — no message leak', async () => {
    const res = await onError(ctx, new Error('db://user:pw@host connection failed'));
    expect(res?.status).toBe(500);
    expect(await res?.json()).toEqual({
      ok: false,
      error: { code: 'internal', message: 'Internal server error' },
    });
  });

  test('a ZodError (invalid input) is an honest 400, not a 500', async () => {
    // The regression this locks: a validation failure used to reach `render` as
    // a raw non-AppError and be dressed as a 500. Normalising first makes it a
    // VALIDATION_ERROR 400 — remapped through `codeMap` like any stitch code.
    const zodError = z.object({ name: z.string() }).safeParse({ name: 42 }).error;
    const res = await onError(ctx, zodError);
    expect(res?.status).toBe(400);
    const body = await res?.json();
    expect(body.error.code).toBe('bad_request'); // VALIDATION_ERROR → codeMap
    expect(body.error.message).toContain('name'); // the offending field surfaces
  });

  test('the onError observer sees the raw error and resolved info', async () => {
    const seen: Array<{ raw: unknown; code: string }> = [];
    const hook = createErrorHook({
      render: (info) => ({ code: info.code }),
      onError: (raw, info) => seen.push({ raw, code: info.code }),
    });
    const thrown = new AppError('CONFLICT', 'dupe', 409);
    await hook(ctx, thrown);
    expect(seen).toHaveLength(1);
    expect(seen[0]?.raw).toBe(thrown);
    // No codeMap → the stitch code passes through unremapped.
    expect(seen[0]?.code).toBe('CONFLICT');
  });
});
