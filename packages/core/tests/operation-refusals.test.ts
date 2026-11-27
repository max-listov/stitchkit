/**
 * A contract operation declares the codes it refuses with (`refuses`, factories from
 * `defineErrors`): the server holds its handler to them on every transport, the typed client reads
 * a rejection as one of them with typed `details`, and the operation's descriptor carries them.
 * → ADR 0330
 */
import { describe, expect, test } from 'bun:test';
import { z } from 'zod';
import { ApiError } from '../src/browser/api-error';
import { createHttpClient } from '../src/browser/http';
import { AppError, defineContract, defineErrors, notFound } from '../src/entrypoints/contract';
import { createHandlerTestClient } from '../src/entrypoints/testing';
import { createHandler } from '../src/server/create';
import { implement } from '../src/server/implement';
import { implementRemote } from '../src/tools/remote';

const { errors } = defineErrors({
  NOT_IDLE: { status: 409, message: 'Session is busy' },
  MIN_AWAKE: {
    status: 409,
    details: z.object({ profile: z.string(), minimum: z.number().int() }),
  },
  PROFILE_UNAVAILABLE: { status: 503 },
});

const Mode = z.object({ mode: z.enum(['idle', 'min', 'undeclared', 'framework', 'plain']) });

function sessions(refuses: boolean) {
  return defineContract(
    { prefix: 'session' },
    {
      sleep: {
        method: 'POST',
        path: '/sleep',
        desc: 'Put a session to sleep',
        input: Mode,
        output: z.object({ ok: z.boolean() }),
        ...(refuses && { refuses: [errors.NOT_IDLE, errors.MIN_AWAKE] }),
      },
      wake: {
        method: 'POST',
        path: '/wake',
        desc: 'Wake a session',
        output: z.object({ ok: z.boolean() }),
      },
      watch: {
        method: 'GET',
        path: '/watch',
        desc: 'Watch a session',
        stream: { item: z.object({ n: z.number() }) },
        ...(refuses && { refuses: [errors.NOT_IDLE] }),
      },
    },
  );
}

const declared = defineContract(
  { prefix: 'session' },
  {
    sleep: {
      method: 'POST',
      path: '/sleep',
      desc: 'Put a session to sleep',
      input: Mode,
      output: z.object({ ok: z.boolean() }),
      refuses: [errors.NOT_IDLE, errors.MIN_AWAKE],
    },
    wake: {
      method: 'POST',
      path: '/wake',
      desc: 'Wake a session',
      output: z.object({ ok: z.boolean() }),
    },
    watch: {
      method: 'GET',
      path: '/watch',
      desc: 'Watch a session',
      stream: { item: z.object({ n: z.number() }) },
      refuses: [errors.NOT_IDLE],
    },
  },
);

function handlers() {
  return {
    sleep: ({ input }: { input: z.infer<typeof Mode> }) => {
      if (input.mode === 'idle') throw errors.NOT_IDLE();
      if (input.mode === 'min')
        throw errors.MIN_AWAKE({ details: { profile: 'p', minimum: 1 } });
      if (input.mode === 'undeclared') throw errors.PROFILE_UNAVAILABLE();
      if (input.mode === 'framework') throw notFound('No such session');
      throw new Error('plain failure');
    },
    wake: () => {
      throw errors.PROFILE_UNAVAILABLE();
    },
    watch: () =>
      (async function* () {
        yield { n: 1 };
        throw errors.PROFILE_UNAVAILABLE();
      })(),
  };
}

const service = implement(declared, handlers());
const handler = createHandler({ groups: [{ pathPrefix: 'api', services: [service] }] });
const api = createHandlerTestClient({ contract: declared, handler, pathPrefix: 'api' });

function isStream(value: unknown): value is AsyncIterable<unknown> {
  return typeof value === 'object' && value !== null && Symbol.asyncIterator in value;
}

async function rejection(promise: Promise<unknown>): Promise<unknown> {
  return promise.then(
    () => undefined,
    (error: unknown) => error,
  );
}

describe('a declared refusal', () => {
  test('passes with its status and typed details, and the client narrows it', async () => {
    const idle = await rejection(api.sleep({ mode: 'idle' }));
    expect(idle).toMatchObject({ code: 'NOT_IDLE', status: 409 });
    const min = await rejection(api.sleep({ mode: 'min' }));
    const refusal = api.sleep.refusal(min);
    if (refusal?.code !== 'MIN_AWAKE') throw new Error('expected the MIN_AWAKE refusal');
    // Typed by the code's schema: no cast, no unknown.
    const minimum: number = refusal.details.minimum;
    expect(minimum).toBe(1);
    expect(api.sleep.refusal(idle)?.code).toBe('NOT_IDLE');
  });

  test('a code the handler did not declare becomes INTERNAL_SERVER_ERROR with the original kept as cause', async () => {
    const undeclared = await rejection(api.sleep({ mode: 'undeclared' }));
    expect(undeclared).toMatchObject({ code: 'INTERNAL_SERVER_ERROR', status: 500 });
    expect(JSON.stringify(undeclared)).not.toContain('PROFILE_UNAVAILABLE');
    // In process, the original refusal stays on `cause` for observers.
    const method = service.methods.sleep;
    if (!method) throw new Error('missing sleep');
    const thrown = await rejection(
      Promise.resolve(
        method.handler({ params: undefined, input: { mode: 'undeclared' }, source: 'http' }),
      ),
    );
    expect(thrown).toBeInstanceOf(AppError);
    expect(thrown).toMatchObject({ code: 'INTERNAL_SERVER_ERROR', status: 500 });
    if (!(thrown instanceof AppError)) throw new Error('expected an AppError');
    expect(thrown.cause).toMatchObject({ code: 'PROFILE_UNAVAILABLE' });
  });

  test('framework codes and non-AppError failures keep their own handling', async () => {
    expect(await rejection(api.sleep({ mode: 'framework' }))).toMatchObject({
      code: 'NOT_FOUND',
      status: 404,
    });
    expect(await rejection(api.sleep({ mode: 'plain' }))).toMatchObject({ status: 500 });
  });

  test('an operation that declares nothing passes its codes unchanged, and the client reads none of them', async () => {
    const wake = await rejection(api.wake());
    expect(wake).toMatchObject({ code: 'PROFILE_UNAVAILABLE', status: 503 });
    expect(api.wake.refusal(wake)).toBeUndefined();
    expect(api.wake.refusal(new Error('not an ApiError'))).toBeUndefined();
    expect(
      api.sleep.refusal(new ApiError('MIN_AWAKE', { status: 409, details: { wrong: true } })),
    ).toBeUndefined();
  });

  test('a stream that fails with an undeclared code mid-way ends with INTERNAL_SERVER_ERROR', async () => {
    const method = service.methods.watch;
    if (!method) throw new Error('missing watch');
    const items = await method.handler({
      params: undefined,
      input: undefined,
      source: 'http',
    });
    const seen: unknown[] = [];
    const failure = await rejection(
      (async () => {
        if (!isStream(items)) throw new Error('expected a stream');
        for await (const item of items) seen.push(item);
      })(),
    );
    expect(seen).toEqual([{ n: 1 }]);
    expect(failure).toMatchObject({ code: 'INTERNAL_SERVER_ERROR', status: 500 });
  });

  test('a remote proxy is held to the declaration even when its origin is not', async () => {
    // The origin implements the same routes without declaring refusals.
    const origin = implement(sessions(false), handlers());
    const originHandler = createHandler({
      groups: [{ pathPrefix: 'api', services: [origin] }],
    });
    const http = createHttpClient({
      baseUrl: 'http://origin.test/api',
      fetch: async (input, init) => originHandler(new Request(input, init)),
    });
    const proxy = implementRemote(declared, http);
    const method = proxy.methods.sleep;
    if (!method) throw new Error('missing proxied sleep');
    const thrown = await rejection(
      Promise.resolve(
        method.handler({ params: undefined, input: { mode: 'undeclared' }, source: 'http' }),
      ),
    );
    expect(thrown).toMatchObject({ code: 'INTERNAL_SERVER_ERROR', status: 500 });
    const passed = await rejection(
      Promise.resolve(
        method.handler({ params: undefined, input: { mode: 'idle' }, source: 'http' }),
      ),
    );
    expect(passed).toMatchObject({ code: 'NOT_IDLE', status: 409 });
  });
});

describe('the declaration', () => {
  test('the operation descriptor carries the declared codes, resolved', () => {
    expect(service.methods.sleep?.refuses).toEqual([
      { code: 'NOT_IDLE', status: 409, retryable: false, message: 'Session is busy' },
      expect.objectContaining({
        code: 'MIN_AWAKE',
        status: 409,
        retryable: false,
        details: expect.anything(),
      }),
    ]);
    expect(service.methods.wake?.refuses).toBeUndefined();
  });

  test('defineContract refuses a string or a repeated code in refuses', () => {
    const endpoint = (refuses: unknown) => ({
      x: {
        method: 'POST' as const,
        path: '/x',
        desc: 'x',
        output: z.object({ ok: z.boolean() }),
        refuses,
      },
    });
    const typed = () =>
      defineContract(
        // @ts-expect-error — a bare code is no declaration: list the factory from defineErrors.
        { prefix: 'bad' },
        {
          x: {
            method: 'POST',
            path: '/x',
            desc: 'x',
            output: z.object({ ok: z.boolean() }),
            refuses: ['NOT_IDLE'],
          },
        },
      );
    expect(typed).toThrow(/refuses\[0\]/);
    expect(() => defineContract({ prefix: 'bad' }, endpoint(['NOT_IDLE']) as never)).toThrow(
      /refuses\[0\]/,
    );
    expect(() =>
      defineContract({ prefix: 'bad' }, endpoint([errors.NOT_IDLE, errors.NOT_IDLE]) as never),
    ).toThrow(/twice/);
  });

  test('a switch over refusal()?.code narrows details, as the client guide shows', async () => {
    const read = (error: unknown): number | string | undefined => {
      const refusal = api.sleep.refusal(error);
      switch (refusal?.code) {
        case 'NOT_IDLE':
          return 'busy';
        case 'MIN_AWAKE':
          return refusal.details.minimum;
        case 'REQUEST_TIMEOUT':
          return 'later';
        default:
          return undefined;
      }
    };
    expect(read(await rejection(api.sleep({ mode: 'min' })))).toBe(1);
    expect(read(await rejection(api.sleep({ mode: 'idle' })))).toBe('busy');
    expect(read(new Error('other'))).toBeUndefined();
  });

  test('a refusal code the operation did not declare does not type-check', async () => {
    const refusal = api.sleep.refusal(await rejection(api.sleep({ mode: 'idle' })));
    if (refusal !== undefined) {
      // @ts-expect-error — `sleep` never declared PROFILE_UNAVAILABLE.
      expect(refusal.code === 'PROFILE_UNAVAILABLE').toBe(false);
      // A framework code is part of every operation's refusals.
      expect(refusal.code === 'REQUEST_TIMEOUT').toBe(false);
    }
  });
});
