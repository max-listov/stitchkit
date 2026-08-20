import { describe, expect, test } from 'bun:test';
import type { RuntimeContext } from '../src/contract';
import { composeLifecycleHooks } from '../src/server/lifecycle';
import type {
  AuthorizationContext,
  LifecycleHooks,
  MethodDef,
  OperationIdentity,
} from '../src/server/types';
import { composeToolLifecycle } from '../src/tools/lifecycle';

const method: MethodDef = {
  method: 'GET',
  path: '/',
  serviceName: 'lifecycle',
  key: 'read',
  desc: 'Read',
  handler: () => ({ ok: true }),
};

const operation: OperationIdentity = method;

function context(signal?: AbortSignal): RuntimeContext {
  return { params: undefined, input: undefined, source: 'http', signal };
}

function authorizationContext(): AuthorizationContext {
  return { params: undefined, input: undefined, source: 'http' };
}

describe('composeLifecycleHooks', () => {
  test('runs request/authorize/before phases in declaration order', async () => {
    const order: string[] = [];
    const first: LifecycleHooks = {
      onRequest: () => {
        order.push('request:first');
      },
      authorize: () => {
        order.push('authorize:first');
      },
      beforeHandle: () => {
        order.push('before:first');
      },
    };
    const second: LifecycleHooks = {
      onRequest: async () => {
        order.push('request:second');
      },
      authorize: async () => {
        order.push('authorize:second');
      },
      beforeHandle: async () => {
        order.push('before:second');
      },
    };
    const lifecycle = composeLifecycleHooks(first, undefined, second);
    const ctx = context();

    await lifecycle.onRequest?.(new Request('http://localhost/'));
    await lifecycle.authorize?.(authorizationContext(), method);
    await lifecycle.beforeHandle?.(ctx, method);

    expect(order).toEqual([
      'request:first',
      'request:second',
      'authorize:first',
      'authorize:second',
      'before:first',
      'before:second',
    ]);
  });

  test('the first Response short-circuits onRequest', async () => {
    const order: string[] = [];
    const lifecycle = composeLifecycleHooks(
      { onRequest: () => void order.push('first') },
      {
        onRequest: () => {
          order.push('response');
          return new Response('closed', { status: 503 });
        },
      },
      { onRequest: () => void order.push('unreachable') },
    );

    const response = await lifecycle.onRequest?.(new Request('http://localhost/'));

    expect(response?.status).toBe(503);
    expect(order).toEqual(['first', 'response']);
  });

  test('undefined afterHandle preserves the current result', async () => {
    const lifecycle = composeLifecycleHooks(
      { afterHandle: (_ctx, result) => ({ value: Number(result) + 1 }) },
      { afterHandle: () => undefined },
      {
        afterHandle: (_ctx, result) => {
          if (typeof result !== 'object' || result === null || !('value' in result)) {
            throw new Error('unexpected result');
          }
          return Number(result.value) * 2;
        },
      },
    );

    expect(await lifecycle.afterHandle?.(context(), 2, method)).toBe(6);
  });

  test('onError falls through undefined and stops at the first Response', async () => {
    const order: string[] = [];
    const lifecycle = composeLifecycleHooks(
      { onError: () => void order.push('observe') },
      {
        onError: () => {
          order.push('render');
          return new Response('handled', { status: 418 });
        },
      },
      { onError: () => new Response('unreachable') },
    );

    const response = await lifecycle.onError?.(context(), new Error('boom'), method);

    expect(response?.status).toBe(418);
    expect(order).toEqual(['observe', 'render']);
  });

  test('a thrown component stops the remaining phase and preserves signal identity', async () => {
    const controller = new AbortController();
    const seen: AbortSignal[] = [];
    const lifecycle = composeLifecycleHooks(
      { beforeHandle: (ctx) => void (ctx.signal && seen.push(ctx.signal)) },
      {
        beforeHandle: () => {
          throw new Error('policy failed');
        },
      },
      { beforeHandle: () => void seen.push(new AbortController().signal) },
    );

    await expect(lifecycle.beforeHandle?.(context(controller.signal), method)).rejects.toThrow(
      'policy failed',
    );
    expect(seen).toEqual([controller.signal]);
  });
});

describe('composeToolLifecycle', () => {
  test('uses the same ordered transform semantics without HTTP phases', async () => {
    const order: string[] = [];
    const lifecycle = composeToolLifecycle(
      {
        beforeHandle: () => void order.push('first'),
        afterHandle: (_ctx, result) => `${String(result)}:first`,
      },
      undefined,
      {
        beforeHandle: async () => void order.push('second'),
        afterHandle: () => undefined,
      },
      { afterHandle: (_ctx, result) => `${String(result)}:last` },
    );

    await lifecycle.beforeHandle?.(context(), operation);
    const result = await lifecycle.afterHandle?.(context(), 'value', operation);

    expect(order).toEqual(['first', 'second']);
    expect(result).toBe('value:first:last');
  });

  test('a thrown tool policy skips the remaining components', async () => {
    const order: string[] = [];
    const lifecycle = composeToolLifecycle(
      { beforeHandle: () => void order.push('first') },
      {
        beforeHandle: () => {
          throw new Error('denied');
        },
      },
      { beforeHandle: () => void order.push('unreachable') },
    );

    await expect(lifecycle.beforeHandle?.(context(), operation)).rejects.toThrow('denied');
    expect(order).toEqual(['first']);
  });
});
