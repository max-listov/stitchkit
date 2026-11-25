/**
 * Request context isolation on Bun/Node (via `process.getBuiltinModule('async_hooks')`),
 * loud failure on Node/Bun runtimes lacking `getBuiltinModule`, explicit context
 * isolation in RN 0.88 realm without AsyncLocalStorage, and malformed `%` query
 * handling on Bun/Node (items 5 and 8).
 */
import { describe, expect, test } from 'bun:test';
import { join } from 'node:path';
import { z } from 'zod';
import { defineContract } from '../src/entrypoints/contract';
import { createHandler, implement } from '../src/entrypoints/handler';
import {
  getRequestContext,
  getTraceId,
  getUserId,
  setRequestUser,
} from '../src/entrypoints/observability';
import { bundleBrowserIife, CORE_SRC, createRnRealm, ZOD_ENTRY } from './rn-realm/rn-realm';

function deferred(): { promise: Promise<void>; resolve: () => void } {
  let resolve: () => void = () => undefined;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

describe('request context isolation', () => {
  test('two concurrent requests interleaving across await keep distinct getTraceId() and getUserId()', async () => {
    const aEntered = deferred();
    const bEntered = deferred();
    const releaseA = deferred();
    const releaseB = deferred();

    const contract = defineContract(
      { prefix: 'iso' },
      {
        work: {
          method: 'GET',
          path: '/:slot',
          desc: 'Interleaved work',
          params: z.object({ slot: z.enum(['a', 'b']) }),
          output: z.object({
            slot: z.string(),
            traceBefore: z.string().optional(),
            traceAfter: z.string().optional(),
            userAfter: z.string().optional(),
            action: z.string().optional(),
          }),
        },
      },
    );

    const completed: Array<{ traceId: string; userId?: string; action?: string }> = [];
    const handler = createHandler({
      services: [
        implement(contract, {
          work: async ({ params }) => {
            const traceBefore = getTraceId();
            setRequestUser(`user-${params.slot}`);
            if (params.slot === 'a') {
              aEntered.resolve();
              await bEntered.promise;
              releaseB.resolve();
              await releaseA.promise;
            } else {
              bEntered.resolve();
              await releaseB.promise;
              releaseA.resolve();
            }
            return {
              slot: params.slot,
              traceBefore,
              traceAfter: getTraceId(),
              userAfter: getUserId(),
              action: getRequestContext()?.action,
            };
          },
        }),
      ],
      observability: {
        includePayload: false,
        complete: (event) => {
          completed.push({
            traceId: event.context.trace.traceId,
            userId: event.context.userId,
            action: event.context.action,
          });
        },
      },
    });

    const traceA = 'a'.repeat(32);
    const traceB = 'b'.repeat(32);
    const [resA, resB] = await Promise.all([
      handler(
        new Request('http://localhost/iso/a', {
          headers: { traceparent: `00-${traceA}-1111111111111111-01` },
        }),
      ),
      handler(
        new Request('http://localhost/iso/b', {
          headers: { traceparent: `00-${traceB}-2222222222222222-01` },
        }),
      ),
    ]);

    expect(await resA.json()).toEqual({
      slot: 'a',
      traceBefore: traceA,
      traceAfter: traceA,
      userAfter: 'user-a',
      action: 'work',
    });
    expect(await resB.json()).toEqual({
      slot: 'b',
      traceBefore: traceB,
      traceAfter: traceB,
      userAfter: 'user-b',
      action: 'work',
    });
    expect(completed).toContainEqual({ traceId: traceA, userId: 'user-a', action: 'work' });
    expect(completed).toContainEqual({ traceId: traceB, userId: 'user-b', action: 'work' });
  });

  test('Node/Bun runtime without process.getBuiltinModule fails loudly instead of silently dropping ALS', async () => {
    const contextMod = join(CORE_SRC, 'observability/context.ts');
    const bundle = await bundleBrowserIife(`
      import { getRequestContext } from ${JSON.stringify(contextMod)};
      globalThis.__getCtx = getRequestContext;
    `);
    const realm = createRnRealm({
      process: { env: {}, versions: { bun: '1.2.0' } },
    });
    realm.evaluate(bundle, 'ctx-missing-builtin.iife.js');

    const errorMessage = realm.evaluate<string>(`(() => {
      try {
        globalThis.__getCtx();
        return 'no-error';
      } catch (e) {
        return e.message;
      }
    })()`);
    expect(errorMessage).toContain('process.getBuiltinModule("async_hooks")');
  });

  test('RN realm without ALS still keeps concurrent observability records isolated via RequestState.context', async () => {
    const handlerEntry = join(CORE_SRC, 'entrypoints/handler.ts');
    const contractEntry = join(CORE_SRC, 'entrypoints/contract.ts');
    const bundle = await bundleBrowserIife(`
      import * as h from ${JSON.stringify(handlerEntry)};
      import * as c from ${JSON.stringify(contractEntry)};
      import { z } from ${JSON.stringify(ZOD_ENTRY)};
      globalThis.__mod = { ...h, ...c, z };
    `);
    const realm = createRnRealm();
    realm.evaluate(bundle, 'rn-concurrent-obs.iife.js');

    const eventsJson = await realm.evaluate<Promise<string>>(`(async () => {
      const { createHandler, defineContract, implement, badRequest, z } = globalThis.__mod;
      const recorded = [];
      const svc = defineContract(
        { prefix: 'jobs' },
        {
          ok: { method: 'GET', path: '/ok', desc: 'Ok', output: z.object({ ok: z.boolean() }) },
          fail: { method: 'GET', path: '/fail', desc: 'Fail', output: z.object({ ok: z.boolean() }) },
        },
      );
      let releaseOk;
      const okGate = new Promise((r) => { releaseOk = r; });
      const handler = createHandler({
        services: [
          implement(svc, {
            ok: async () => {
              await okGate;
              return { ok: true };
            },
            fail: async () => {
              releaseOk();
              return badRequest('nope');
            },
          }),
        ],
        observability: {
          complete: (entry) => {
            recorded.push({
              traceId: entry.context.trace.traceId,
              serviceName: entry.context.serviceName,
              action: entry.context.action,
              errorCode: entry.context.error?.code,
            });
          },
        },
      });
      const traceOk = '1'.repeat(32);
      const traceFail = '2'.repeat(32);
      await Promise.all([
        handler(
          new Request('http://bridge.invalid/jobs/ok', {
            headers: { traceparent: '00-' + traceOk + '-1111111111111111-01' },
          }),
        ),
        handler(
          new Request('http://bridge.invalid/jobs/fail', {
            headers: { traceparent: '00-' + traceFail + '-2222222222222222-01' },
          }),
        ),
      ]);
      return JSON.stringify(recorded);
    })()`);

    const parsed: unknown = JSON.parse(eventsJson);
    expect(parsed).toContainEqual({
      traceId: '1'.repeat(32),
      serviceName: 'jobs',
      action: 'ok',
    });
    expect(parsed).toContainEqual({
      traceId: '2'.repeat(32),
      serviceName: 'jobs',
      action: 'fail',
      errorCode: 'BAD_REQUEST',
    });
  });

  test('malformed percent-escape in query string returns 400 BAD_REQUEST on Bun/Node path too', async () => {
    const contract = defineContract(
      { prefix: 'search' },
      {
        find: {
          method: 'GET',
          path: '/',
          desc: 'Search',
          input: z.object({ q: z.string().optional() }),
          output: z.object({ q: z.string().optional() }),
        },
      },
    );
    const handler = createHandler({
      services: [implement(contract, { find: ({ input }) => ({ q: input.q }) })],
    });

    const badUtf8 = await handler(new Request('http://localhost/search?q=%E0%A4%A'));
    expect(badUtf8.status).toBe(400);
    expect((await badUtf8.json()).error.code).toBe('BAD_REQUEST');

    const badHex = await handler(new Request('http://localhost/search?q=%ZZ'));
    expect(badHex.status).toBe(400);
    expect((await badHex.json()).error.code).toBe('BAD_REQUEST');
  });
});
