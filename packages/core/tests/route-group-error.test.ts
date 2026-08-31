import { describe, expect, test } from 'bun:test';
import { AppError, type RuntimeContext, unauthorized } from '../src/contract';
import { createHandler, implement, type LifecycleHooks, type MethodDef } from '../src/server';
import {
  groupErrorContract,
  groupErrorRequest,
  groupErrorService,
} from './fixtures/route-group-error';

describe('matched route group error dispatch', () => {
  test('group authorize failure uses group onError before the global hook', async () => {
    const order: string[] = [];
    const handler = createHandler({
      groups: [
        {
          pathPrefix: '/group',
          services: [groupErrorService],
          hooks: {
            authorize: () => unauthorized(),
            onError: () => {
              order.push('group');
              return new Response('group refusal', {
                status: 401,
                headers: { 'cache-control': 'no-store' },
              });
            },
          },
        },
      ],
      hooks: {
        onError: () => {
          order.push('global');
          return new Response('global', { status: 401 });
        },
      },
    });
    const response = await handler(groupErrorRequest());
    expect(response.status).toBe(401);
    expect(response.headers.get('cache-control')).toBe('no-store');
    expect(await response.text()).toBe('group refusal');
    expect(order).toEqual(['group']);
  });

  const fail = () => {
    throw new AppError('FORBIDDEN', 'denied', 403);
  };
  const cases: Array<{
    name: string;
    group?: LifecycleHooks;
    global?: LifecycleHooks;
    request?: () => Request;
    handlerFailure?: boolean;
  }> = [
    { name: 'path validation', request: () => groupErrorRequest('x') },
    { name: 'payload validation', request: () => groupErrorRequest('abc', {}) },
    { name: 'global authorize', global: { authorize: fail } },
    { name: 'global beforeHandle', global: { beforeHandle: fail } },
    { name: 'group beforeHandle', group: { beforeHandle: fail } },
    { name: 'group afterHandle', group: { afterHandle: fail } },
    { name: 'global afterHandle', global: { afterHandle: fail } },
    { name: 'handler', handlerFailure: true },
  ];
  for (const entry of cases) {
    test(`${entry.name} failure retains matched context and endpoint`, async () => {
      const seen: Array<{ ctx: RuntimeContext; error: unknown; endpoint?: MethodDef }> = [];
      let globalCalls = 0;
      const handler = createHandler({
        groups: [
          {
            pathPrefix: '/group',
            services: [
              implement(groupErrorContract, {
                save: () => (entry.handlerFailure ? fail() : { ok: true }),
              }),
            ],
            hooks: {
              ...entry.group,
              onError: async (ctx, error, endpoint) => {
                seen.push({ ctx, error, endpoint });
                return new Response('handled', { status: 418 });
              },
            },
          },
        ],
        hooks: {
          ...entry.global,
          onError: () => {
            globalCalls++;
          },
        },
      });
      const req = entry.request?.() ?? groupErrorRequest();
      expect((await handler(req)).status).toBe(418);
      expect(seen).toHaveLength(1);
      expect(globalCalls).toBe(0);
      expect(seen[0]?.ctx.req).toBe(req);
      expect(seen[0]?.ctx.params).toEqual({
        id: entry.name === 'path validation' ? 'x' : 'abc',
      });
      expect(seen[0]?.endpoint?.serviceName).toBe('items');
      expect(seen[0]?.endpoint?.key).toBe('save');
      expect(seen[0]?.error).toBeInstanceOf(Error);
    });
  }

  test('raw routes, 404, 405 and pre-route failures cannot select a group by prefix', async () => {
    const seen: Array<MethodDef | undefined> = [];
    let groupCalls = 0;
    const handler = createHandler({
      groups: [
        {
          pathPrefix: '/group',
          services: [groupErrorService],
          hooks: {
            onError: () => {
              groupCalls++;
            },
          },
        },
      ],
      rawRoutes: [{ method: 'GET', path: '/group/raw', handler: fail }],
      hooks: {
        onRequest: (req) => {
          if (req.headers.has('x-fail')) fail();
        },
        onError: (_ctx, _error, endpoint) => {
          seen.push(endpoint);
        },
      },
    });
    for (const [req, expected] of [
      [new Request('http://localhost/group/raw'), 403],
      [new Request('http://localhost/group/missing'), 404],
      [new Request('http://localhost/group/items/abc'), 405],
      [new Request(groupErrorRequest(), { headers: { 'x-fail': 'yes' } }), 403],
    ] satisfies Array<[Request, number]>)
      expect((await handler(req)).status).toBe(expected);
    expect(groupCalls).toBe(0);
    expect(seen).toEqual([undefined, undefined, undefined, undefined]);
  });

  test('confirmed cancellation bypasses both group and global error hooks', async () => {
    const abort = new AbortController();
    let calls = 0;
    const handler = createHandler({
      groups: [
        {
          pathPrefix: '/group',
          services: [groupErrorService],
          hooks: {
            authorize: () => {
              abort.abort();
              throw abort.signal.reason;
            },
            onError: () => {
              calls++;
            },
          },
        },
      ],
      hooks: {
        onError: () => {
          calls++;
        },
      },
    });
    const response = await handler(new Request(groupErrorRequest(), { signal: abort.signal }));
    expect(response.status).toBe(499);
    expect(calls).toBe(0);
  });
});
