/**
 * `createErrorHook` — turns a thrown value into one wire envelope, remapping
 * stitchkit's codes to the app's, never leaking an internal message.
 */
import { describe, expect, test } from 'bun:test';
import { z } from 'zod';
import { AppError, type RuntimeContext, type StitchErrorCode } from '../src/contract';
import { createErrorHook, createHandler } from '../src/server';
import type { MethodDef } from '../src/server/types';

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
    FILE_INVALID_PATH: 'bad_request',
    FILE_OUTSIDE_ROOT: 'bad_request',
    FILE_NOT_FOUND: 'not_found',
    FILE_NOT_REGULAR: 'unprocessable',
    FILE_INSPECTION_REJECTED: 'unprocessable',
    FILE_TOO_LARGE: 'too_large',
    FILE_EXISTS: 'conflict',
    REALTIME_CONTRACT_VIOLATION: 'internal',
    INTERNAL_SERVER_ERROR: 'internal',
  } satisfies Record<StitchErrorCode, string>,
  render: (info) => ({ ok: false, error: { code: info.code, message: info.message } }),
});

// The hook only reads `error`; a minimal valid context satisfies the signature.
const ctx: RuntimeContext = { params: undefined, input: undefined, source: 'http' };

const endpoint: MethodDef = {
  key: 'probe',
  serviceName: 'errors',
  method: 'GET',
  path: '/probe',
  desc: 'Probe error handling',
  handler: () => undefined,
};

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

  test('awaits async attribution before rendering and passes the matched endpoint', async () => {
    const order: string[] = [];
    let observedEndpoint: MethodDef | undefined;
    let renderedEndpoint: MethodDef | undefined;
    const enrichedContext: RuntimeContext = {
      params: undefined,
      input: undefined,
      source: 'http',
    };
    const hook = createErrorHook({
      onError: async (_error, _info, ctx, matched) => {
        await Promise.resolve();
        ctx.actorId = 'actor-1';
        observedEndpoint = matched;
        order.push('observe');
      },
      render: async (info, ctx, matched) => {
        await Promise.resolve();
        renderedEndpoint = matched;
        order.push('render');
        return { code: info.code, actorId: ctx.actorId };
      },
    });

    const response = await hook(
      enrichedContext,
      new AppError('FORBIDDEN', 'no', 403),
      endpoint,
    );

    expect(order).toEqual(['observe', 'render']);
    expect(observedEndpoint).toBe(endpoint);
    expect(renderedEndpoint).toBe(endpoint);
    expect(await response?.json()).toEqual({ code: 'FORBIDDEN', actorId: 'actor-1' });
  });

  test('passes an absent endpoint for failures before route resolution', async () => {
    let observed: MethodDef | undefined = endpoint;
    let rendered: MethodDef | undefined = endpoint;
    const hook = createErrorHook({
      onError: (_error, _info, _ctx, matched) => {
        observed = matched;
      },
      render: (info, _ctx, matched) => {
        rendered = matched;
        return { code: info.code };
      },
    });

    await hook(ctx, new Error('unmatched'));

    expect(observed).toBeUndefined();
    expect(rendered).toBeUndefined();
  });

  test('an async observer failure falls back to the original normalized error', async () => {
    const handler = createHandler({
      rawRoutes: [
        {
          method: 'GET',
          path: '/boom',
          handler: () => {
            throw new AppError('NOT_FOUND', 'original', 404);
          },
        },
      ],
      hooks: {
        onError: createErrorHook({
          onError: async () => {
            await Promise.resolve();
            throw new Error('observer failed');
          },
          render: () => ({ shouldNotRender: true }),
        }),
      },
    });

    const response = await handler(new Request('http://local/boom'));

    expect(response.status).toBe(404);
    expect(await response.json()).toEqual({
      error: { code: 'NOT_FOUND', message: 'original' },
    });
  });

  test('an async renderer failure falls back to the original normalized error', async () => {
    const handler = createHandler({
      rawRoutes: [
        {
          method: 'GET',
          path: '/boom',
          handler: () => {
            throw new AppError('CONFLICT', 'original', 409);
          },
        },
      ],
      hooks: {
        onError: createErrorHook({
          render: async () => {
            await Promise.resolve();
            throw new Error('renderer failed');
          },
        }),
      },
    });

    const response = await handler(new Request('http://local/boom'));

    expect(response.status).toBe(409);
    expect(await response.json()).toEqual({
      error: { code: 'CONFLICT', message: 'original' },
    });
  });
  test('a partial code map maps what it lists and passes the rest through as itself', async () => {
    // The framework adds codes in ordinary releases. A map that translates only
    // the codes a project cares about must keep compiling and keep working, or
    // every added code would be a breaking change for anyone who maps at all.
    const handler = createHandler({
      rawRoutes: [
        {
          method: 'GET',
          path: '/mapped',
          handler: () => {
            throw new AppError('CONFLICT', 'thrown', 409);
          },
        },
        {
          method: 'GET',
          path: '/unmapped',
          handler: () => {
            throw new AppError('FILE_TOO_LARGE', 'thrown', 413);
          },
        },
      ],
      hooks: {
        onError: createErrorHook({
          codeMap: { CONFLICT: 'conflict' },
          render: (info) => ({ code: info.code }),
        }),
      },
    });

    const mapped = await handler(new Request('http://local/mapped'));
    const unmapped = await handler(new Request('http://local/unmapped'));

    expect(await mapped.json()).toEqual({ code: 'conflict' });
    expect(await unmapped.json()).toEqual({ code: 'FILE_TOO_LARGE' });
  });

  test('a declarative fallback maps only unmapped stitchkit codes', async () => {
    const hook = createErrorHook({
      codeMap: { CONFLICT: 'conflict' },
      unmappedCode: 'framework_error',
      render: (info) => ({ code: info.code }),
    });

    const mapped = await hook(ctx, new AppError('CONFLICT', 'duplicate', 409));
    const frameworkFallback = await hook(ctx, new AppError('FILE_TOO_LARGE', 'large', 413));
    const projectCode = await hook(ctx, new AppError('SESSION_GONE', 'gone', 404));

    expect(await mapped?.json()).toEqual({ code: 'conflict' });
    expect(await frameworkFallback?.json()).toEqual({ code: 'framework_error' });
    expect(await projectCode?.json()).toEqual({ code: 'SESSION_GONE' });
  });

  test('an unmapped-code resolver receives a narrowed framework code', async () => {
    const seen: StitchErrorCode[] = [];
    const hook = createErrorHook({
      unmappedCode: (code) => {
        seen.push(code);
        return code.startsWith('FILE_') ? 'storage_error' : 'framework_error';
      },
      render: (info) => ({ code: info.code }),
    });

    const response = await hook(ctx, new AppError('FILE_NOT_FOUND', 'gone', 404));

    expect(seen).toEqual(['FILE_NOT_FOUND']);
    expect(await response?.json()).toEqual({ code: 'storage_error' });
  });
});
