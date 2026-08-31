import { describe, expect, test } from 'bun:test';
import { AppError, type RuntimeContext } from '../src/contract';
import {
  createHandler,
  type LifecycleHooks,
  type MethodDef,
  type StitchLogger,
} from '../src/server';
import { groupErrorRequest, groupErrorService } from './fixtures/route-group-error';

const original = new AppError('FORBIDDEN', 'denied', 403);
const hookFailure = new Error('private diagnostic: error hook unavailable');
const fail = () => {
  throw original;
};
const noop = () => undefined;

describe('route group error fallback', () => {
  for (const mode of ['absent', 'undefined', 'throw', 'reject']) {
    test(`${mode} group hook falls through to global with the original error`, async () => {
      const seen: Array<{ ctx: RuntimeContext; error: unknown; endpoint?: MethodDef }> = [];
      const diagnostics: Array<Record<string, unknown> | undefined> = [];
      const hooks: LifecycleHooks = { authorize: fail };
      if (mode !== 'absent')
        hooks.onError = (ctx, error, endpoint) => {
          seen.push({ ctx, error, endpoint });
          if (mode === 'throw') throw hookFailure;
          if (mode === 'reject') return Promise.reject(hookFailure);
        };
      const logger: StitchLogger = {
        info: noop,
        debug: noop,
        warn: noop,
        error: (_message, fields) => {
          diagnostics.push(fields);
        },
      };
      const handler = createHandler({
        groups: [{ pathPrefix: '/group', services: [groupErrorService], hooks }],
        logging: { logger },
        hooks: {
          onError: (ctx, error, endpoint) => {
            seen.push({ ctx, error, endpoint });
            return new Response('global refusal', { status: 403 });
          },
        },
      });
      const response = await handler(groupErrorRequest());
      expect(response.status).toBe(403);
      expect(await response.text()).toBe('global refusal');
      expect(seen).toHaveLength(mode === 'absent' ? 1 : 2);
      expect(seen.every((item) => item.error === original)).toBe(true);
      expect(seen[0]?.ctx).toBe(seen.at(-1)?.ctx);
      expect(seen[0]?.endpoint).toBe(seen.at(-1)?.endpoint);
      const failures = diagnostics.filter((fields) => fields?.error === hookFailure);
      expect(failures).toHaveLength(mode === 'throw' || mode === 'reject' ? 1 : 0);
      if (failures.length)
        expect(failures[0]?.traceId).toBe(response.headers.get('x-request-id'));
    });
  }

  for (const mode of ['absent', 'undefined', 'throw', 'reject', 'broken logger']) {
    test(`${mode} global hook falls back to the original standard envelope`, async () => {
      const diagnostics: string[] = [];
      const logger: StitchLogger = {
        info: noop,
        debug: noop,
        warn: noop,
        error: (message) => {
          diagnostics.push(message);
          if (mode === 'broken logger') throw new Error('sink unavailable');
        },
      };
      const global: LifecycleHooks = {};
      if (mode !== 'absent')
        global.onError = (_ctx, error) => {
          expect(error).toBe(original);
          if (mode === 'throw' || mode === 'broken logger') throw hookFailure;
          if (mode === 'reject') return Promise.reject(hookFailure);
        };
      const handler = createHandler({
        groups: [
          {
            pathPrefix: '/group',
            services: [groupErrorService],
            hooks: {
              authorize: fail,
              onError: () => {
                throw hookFailure;
              },
            },
          },
        ],
        hooks: global,
        logging: { logger },
      });
      const response = await handler(groupErrorRequest());
      expect(response.status).toBe(403);
      expect(await response.json()).toEqual({
        error: { code: 'FORBIDDEN', message: 'denied' },
      });
      expect(diagnostics.filter((line) => line.includes('onError failed'))).toEqual(
        mode === 'absent' || mode === 'undefined'
          ? ['[stitchkit] group onError failed']
          : ['[stitchkit] group onError failed', '[stitchkit] global onError failed'],
      );
    });
  }

  test('concurrent groups and an ungrouped route do not share error policy', async () => {
    const handler = createHandler({
      services: [groupErrorService],
      groups: ['first', 'second'].map((name) => ({
        pathPrefix: `/${name}`,
        services: [groupErrorService],
        hooks: {
          onError: async (ctx: RuntimeContext) => {
            await Promise.resolve();
            return new Response(`${name}:${ctx.url?.pathname}`, { status: 403 });
          },
        },
      })),
      hooks: { authorize: fail, onError: () => new Response('global', { status: 403 }) },
    });
    const responses = await Promise.all(
      ['first', 'second', ''].map((name) =>
        handler(
          new Request(`http://localhost/${name ? `${name}/` : ''}items/abc`, {
            method: 'POST',
          }),
        ),
      ),
    );
    expect(await Promise.all(responses.map((response) => response.text()))).toEqual([
      'first:/first/items/abc',
      'second:/second/items/abc',
      'global',
    ]);
  });
});
