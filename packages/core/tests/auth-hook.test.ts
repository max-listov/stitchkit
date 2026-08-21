/**
 * `createAuthHook` on both surfaces — HTTP (identity from `ctx.req`) and tool
 * calls (identity from `resolveFromContext`). A scoped tool call must never
 * silently pass: without `resolveFromContext` it fails closed. See ADR 0014.
 */
import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import type { RuntimeContext } from '../src/contract';
import { RUNTIME_CONTEXT_RESERVED_KEYS } from '../src/server/context-contribution';
import { composeAuthHooks, createAuthHook } from '../src/server/middleware/auth';
import type { MethodDef, OperationIdentity } from '../src/server/types';

interface Identity {
  admin: boolean;
}

function endpoint(scope?: string): MethodDef {
  return {
    method: 'POST',
    path: '/',
    serviceName: 'test',
    key: 'test',
    desc: 'test',
    handler: () => undefined,
    scope,
  };
}

function httpCtx(): RuntimeContext {
  return {
    params: {},
    input: {},
    source: 'http',
    req: new Request('http://localhost/'),
  };
}

function toolCtx(extra: Record<string, unknown> = {}): RuntimeContext {
  return { params: {}, input: {}, source: 'mcp', ...extra };
}

/** Run a hook — `true` if it rejected, `false` if it passed. */
async function rejected(p: Promise<unknown>): Promise<boolean> {
  try {
    await p;
    return false;
  } catch {
    return true;
  }
}

describe('createAuthHook — HTTP surface', () => {
  const hook = createAuthHook<Identity>({
    resolve: async () => ({ admin: true }),
    rules: { public: 'public', user: 'authenticated', admin: (i) => i.admin },
  });

  test('public scope passes', async () => {
    expect(await rejected(hook(httpCtx(), endpoint('public')))).toBe(false);
  });

  test('admin scope passes for an admin identity', async () => {
    expect(await rejected(hook(httpCtx(), endpoint('admin')))).toBe(false);
  });

  for (const scope of ['toString', 'constructor', 'valueOf', '__proto__', 'hasOwnProperty']) {
    test(`prototype key ${scope} is not treated as an auth rule`, async () => {
      await expect(hook(httpCtx(), endpoint(scope))).rejects.toThrow(
        `[stitchkit] auth: no rule for scope "${scope}"`,
      );
    });
  }
});

describe('createAuthHook — tool surface', () => {
  test('scoped tool call fails closed when no resolveFromContext', async () => {
    const hook = createAuthHook<Identity>({
      resolve: async () => ({ admin: true }),
      rules: { user: 'authenticated' },
    });
    // No `req`, no `resolveFromContext` → identity is null → rejected.
    expect(await rejected(hook(toolCtx(), endpoint('user')))).toBe(true);
  });

  test('public scope passes on a tool call even without identity', async () => {
    const hook = createAuthHook<Identity>({
      resolve: async () => null,
      rules: { public: 'public' },
    });
    expect(await rejected(hook(toolCtx(), endpoint('public')))).toBe(false);
  });

  test('resolveFromContext supplies identity — scope rule runs', async () => {
    const hook = createAuthHook<Identity>({
      resolve: async () => null,
      resolveFromContext: (ctx) => (ctx.identity ? { admin: true } : null),
      rules: { admin: (i) => i.admin },
    });
    expect(await rejected(hook(toolCtx({ identity: 'present' }), endpoint('admin')))).toBe(
      false,
    );
  });

  test('resolveFromContext returns null — scoped call rejected', async () => {
    const hook = createAuthHook<Identity>({
      resolve: async () => null,
      resolveFromContext: () => null,
      rules: { user: 'authenticated' },
    });
    expect(await rejected(hook(toolCtx(), endpoint('user')))).toBe(true);
  });

  test('resolveFromContext identity present but rule rejects → forbidden', async () => {
    const hook = createAuthHook<Identity>({
      resolve: async () => null,
      resolveFromContext: () => ({ admin: false }),
      rules: { admin: (i) => i.admin },
    });
    expect(await rejected(hook(toolCtx({ identity: 'x' }), endpoint('admin')))).toBe(true);
  });

  test('resolveFromContext may be async', async () => {
    const hook = createAuthHook<Identity>({
      resolve: async () => null,
      resolveFromContext: async () => ({ admin: true }),
      rules: { admin: (i) => i.admin },
    });
    expect(await rejected(hook(toolCtx(), endpoint('admin')))).toBe(false);
  });
});

describe('createAuthHook — scoped rules with typed inject', () => {
  interface User {
    id: string;
    admin: boolean;
  }
  const alice: User = { id: 'u1', admin: false };
  const root: User = { id: 'u0', admin: true };

  function hookFor(identity: User | null) {
    return createAuthHook({
      resolve: async () => identity,
      rules: {
        public: { rule: 'public', inject: (user) => ({ userId: user.id }) },
        user: { rule: 'authenticated', inject: (user) => ({ userId: user.id }) },
        admin: {
          rule: (user) => user.admin,
          inject: (user) => ({ userId: user.id, isAdmin: user.admin }),
        },
        bare: 'authenticated',
      },
    });
  }

  const endpoint = (scope: string): OperationIdentity => ({
    method: 'GET',
    desc: 'scoped',
    serviceName: 'svc',
    key: 'op',
    scope,
  });

  test('a rule inject merges its fields into the context before the handler', async () => {
    const ctx: RuntimeContext = { params: undefined, input: undefined, source: 'http' };
    await hookFor(alice)(ctx, endpoint('user'));
    expect(ctx.userId).toBe('u1');
  });

  test('a public rule injects for a logged-in caller and passes the anonymous one', async () => {
    const loggedIn: RuntimeContext = { params: undefined, input: undefined, source: 'http' };
    await hookFor(alice)(loggedIn, endpoint('public'));
    expect(loggedIn.userId).toBe('u1');

    const anonymous: RuntimeContext = { params: undefined, input: undefined, source: 'http' };
    await hookFor(null)(anonymous, endpoint('public'));
    expect(anonymous.userId).toBeUndefined();
  });

  test('a custom rule still rejects after its inject ran', async () => {
    const ctx: RuntimeContext = { params: undefined, input: undefined, source: 'http' };
    await expect(hookFor(alice)(ctx, endpoint('admin'))).rejects.toThrow();
    // The request died, but the contribution itself is not the gate.
    expect(ctx.userId).toBe('u1');
  });

  test('the admin rule passes an admin and injects its fields', async () => {
    const ctx: RuntimeContext = { params: undefined, input: undefined, source: 'http' };
    await hookFor(root)(ctx, endpoint('admin'));
    expect(ctx.isAdmin).toBe(true);
  });

  test('a bare rule keeps working unchanged next to scoped ones', async () => {
    const ctx: RuntimeContext = { params: undefined, input: undefined, source: 'http' };
    await hookFor(alice)(ctx, endpoint('bare'));
    expect(ctx.userId).toBeUndefined();
  });
});

describe('createAuthHook — scoped rule edges', () => {
  interface User {
    id: string;
  }
  const endpoint = (scope: string): OperationIdentity => ({
    method: 'GET',
    desc: 'edge',
    serviceName: 'svc',
    key: 'op',
    scope,
  });

  test('an async inject from an untyped caller throws instead of merging a Promise', async () => {
    const looseRules: Record<string, unknown> = {
      user: {
        rule: 'authenticated',
        inject: async (user: User) => ({ userId: user.id }),
      },
    };
    const hook = Reflect.apply(createAuthHook, undefined, [
      { resolve: async () => ({ id: 'u1' }), rules: looseRules },
    ]);

    const ctx: RuntimeContext = { params: undefined, input: undefined, source: 'http' };
    await expect(Reflect.apply(hook, undefined, [ctx, endpoint('user')])).rejects.toThrow(
      '[stitchkit] auth: the inject of scope "user" must be synchronous',
    );
    expect(ctx.userId).toBeUndefined();
  });

  test('a union rule that lands on public at runtime skips inject for the anonymous', async () => {
    const flip = false;
    const hook = createAuthHook({
      resolve: async (): Promise<User | null> => null,
      rules: {
        mixed: {
          rule: flip ? ('authenticated' as const) : ('public' as const),
          inject: (user) => ({ userId: user.id }),
        },
      },
    });
    const ctx: RuntimeContext = { params: undefined, input: undefined, source: 'http' };
    await hook(ctx, endpoint('mixed'));
    expect(ctx.userId).toBeUndefined();
  });

  test('an async rule contributes access-derived fields exactly once', async () => {
    let calls = 0;
    const hook = createAuthHook({
      resolve: async () => ({ id: 'u1' }),
      rules: {
        resource: {
          inject: (user) => ({ userId: user.id, role: 'stale' }),
          rule: async () => {
            calls += 1;
            return { resourceId: 'canonical', role: 'owner' };
          },
        },
      },
    });
    const ctx: RuntimeContext = { params: undefined, input: undefined, source: 'http' };

    await hook(ctx, endpoint('resource'));

    expect(calls).toBe(1);
    expect(ctx).toMatchObject({
      userId: 'u1',
      resourceId: 'canonical',
      role: 'owner',
      source: 'http',
    });
  });

  test('the same rule contribution is available on the tool path', async () => {
    const hook = createAuthHook({
      resolve: async () => null,
      resolveFromContext: () => ({ id: 'u1' }),
      rules: { resource: async () => ({ resourceId: 'canonical' }) },
    });
    const ctx = toolCtx();

    await hook(ctx, endpoint('resource'));

    expect(ctx.resourceId).toBe('canonical');
  });

  test('false and a thrown domain error never merge rule-returned fields', async () => {
    const denied = createAuthHook({
      resolve: async () => ({ id: 'u1' }),
      rules: { resource: () => false },
    });
    const deniedCtx: RuntimeContext = {
      params: undefined,
      input: undefined,
      source: 'http',
    };
    await expect(denied(deniedCtx, endpoint('resource'))).rejects.toThrow();
    expect(deniedCtx.resourceId).toBeUndefined();

    const failed = createAuthHook({
      resolve: async () => ({ id: 'u1' }),
      rules: {
        resource: (): never => {
          throw new Error('domain failure');
        },
      },
    });
    const failedCtx: RuntimeContext = {
      params: undefined,
      input: undefined,
      source: 'http',
    };
    await expect(failed(failedCtx, endpoint('resource'))).rejects.toThrow('domain failure');
    expect(failedCtx.resourceId).toBeUndefined();
  });

  for (const invalid of [undefined, null, 0, '', [], new Date()]) {
    test(`invalid rule contribution ${String(invalid)} fails closed`, async () => {
      const looseRules: Record<string, unknown> = { resource: () => invalid };
      const hook = Reflect.apply(createAuthHook, undefined, [
        { resolve: async () => ({ id: 'u1' }), rules: looseRules },
      ]);
      const ctx: RuntimeContext = { params: undefined, input: undefined, source: 'http' };

      await expect(
        Reflect.apply(hook, undefined, [ctx, endpoint('resource')]),
      ).rejects.toThrow('[stitchkit] auth: invalid context contribution');
      expect(ctx.source).toBe('http');
    });
  }

  test('reserved keys reject the complete contribution before any merge', async () => {
    const hook = createAuthHook({
      resolve: async () => ({ id: 'u1' }),
      rules: { resource: () => ({ accepted: true, source: 'mcp' }) },
    });
    const ctx: RuntimeContext = { params: undefined, input: undefined, source: 'http' };

    await expect(hook(ctx, endpoint('resource'))).rejects.toThrow('reserved key "source"');
    expect(ctx.accepted).toBeUndefined();
    expect(ctx.source).toBe('http');
  });

  test('reserved context keys exactly match the declared RuntimeContext fields', () => {
    const source = readFileSync(`${import.meta.dir}/../src/contract/define.ts`, 'utf8');
    const body = source.match(/export interface RuntimeContext \{([\s\S]*?)\n\}/)?.[1];
    if (!body) throw new Error('RuntimeContext declaration not found');
    const declared = [...body.matchAll(/^\s{2}([A-Za-z][A-Za-z0-9]*)\??:/gm)]
      .map((match) => match[1])
      .filter((key) => key !== undefined)
      .sort();

    expect([...RUNTIME_CONTEXT_RESERVED_KEYS].sort()).toEqual(declared);
  });

  test('unsafe, symbol and accessor keys fail without invoking a getter', async () => {
    let getterCalls = 0;
    const unsafe: Record<string, unknown> = Object.create(null);
    Object.defineProperty(unsafe, '__proto__', { enumerable: true, value: 'pollute' });
    Object.defineProperty(unsafe, 'derived', {
      enumerable: true,
      get: () => {
        getterCalls += 1;
        return 'secret';
      },
    });
    const marker = Symbol('marker');
    Object.defineProperty(unsafe, marker, { enumerable: true, value: true });
    const hook = createAuthHook({
      resolve: async () => ({ id: 'u1' }),
      rules: { resource: () => unsafe },
    });
    const ctx: RuntimeContext = { params: undefined, input: undefined, source: 'http' };

    await expect(hook(ctx, endpoint('resource'))).rejects.toThrow('unsafe key');
    expect(getterCalls).toBe(0);
    expect(Object.getPrototypeOf(ctx)).toBe(Object.prototype);
  });

  test('a hostile proxy produces a stable inspection error', async () => {
    const contribution = new Proxy(
      {},
      {
        getPrototypeOf: () => {
          throw new Error('secret trap');
        },
      },
    );
    const hook = createAuthHook({
      resolve: async () => ({ id: 'u1' }),
      rules: { resource: () => contribution },
    });
    const ctx: RuntimeContext = { params: undefined, input: undefined, source: 'http' };

    await expect(hook(ctx, endpoint('resource'))).rejects.toThrow('record inspection failed');
  });
});

describe('composeAuthHooks', () => {
  test('dispatches only the owner of a disjoint scope on HTTP and tool contexts', async () => {
    const calls: string[] = [];
    const users = createAuthHook({
      resolve: async () => {
        calls.push('user:http');
        return { id: 'http-user' };
      },
      resolveFromContext: () => {
        calls.push('user:tool');
        return { id: 'tool-user' };
      },
      rules: { user: (identity) => ({ userId: identity.id }) },
    });
    const services = createAuthHook({
      resolve: async () => {
        calls.push('service:http');
        return { id: 'http-service' };
      },
      resolveFromContext: () => {
        calls.push('service:tool');
        return { id: 'tool-service' };
      },
      rules: { service: (identity) => ({ serviceId: identity.id }) },
    });
    const auth = composeAuthHooks({ hooks: [users, services] });

    const http = httpCtx();
    await auth(http, endpoint('user'));
    expect(http.userId).toBe('http-user');
    expect(calls).toEqual(['user:http']);

    const tool = toolCtx();
    await auth(tool, endpoint('service'));
    expect(tool.serviceId).toBe('tool-service');
    expect(calls).toEqual(['user:http', 'service:tool']);
  });

  test('runs every owner of a shared scope in declaration order and commits once', async () => {
    const calls: string[] = [];
    const identity = createAuthHook({
      resolve: async () => ({ id: 'u1' }),
      rules: {
        shared: async (user) => {
          calls.push('identity');
          return { userId: user.id };
        },
      },
    });
    const membership = createAuthHook({
      resolve: async () => ({ tenantId: 't1' }),
      rules: {
        shared: async (tenant) => {
          calls.push('membership');
          return { tenantId: tenant.tenantId };
        },
      },
    });
    const auth = composeAuthHooks({ hooks: [identity, membership] });
    const ctx = httpCtx();

    await auth(ctx, endpoint('shared'));

    expect(calls).toEqual(['identity', 'membership']);
    expect(ctx).toMatchObject({ userId: 'u1', tenantId: 't1', source: 'http' });
  });

  test('fails closed for zero owners, anonymous callers and forbidden owners', async () => {
    let foreignResolverCalls = 0;
    const anonymous = createAuthHook({
      resolve: async () => null,
      rules: { user: 'authenticated' },
    });
    const denied = createAuthHook({
      resolve: async () => ({ allowed: false }),
      rules: { shared: (identity) => identity.allowed },
    });
    const passing = createAuthHook({
      resolve: async () => {
        foreignResolverCalls += 1;
        return { id: 'u1' };
      },
      rules: { shared: () => ({ userId: 'u1' }) },
    });
    const auth = composeAuthHooks({ hooks: [anonymous, passing, denied] });

    await expect(auth(httpCtx(), endpoint('foreign'))).rejects.toThrow(
      'no rule for scope "foreign"',
    );
    expect(foreignResolverCalls).toBe(0);
    await expect(auth(httpCtx(), endpoint('user'))).rejects.toThrow();
    await expect(auth(httpCtx(), endpoint('shared'))).rejects.toThrow();
  });

  test('uses only the explicit composite default and validates child defaults', async () => {
    const first = createAuthHook({
      resolve: async () => ({ id: 'u1' }),
      rules: { shared: () => ({ userId: 'u1' }) },
      defaultScope: 'shared',
    });
    const second = createAuthHook({
      resolve: async () => ({ id: 't1' }),
      rules: { shared: () => ({ tenantId: 't1' }) },
      defaultScope: 'shared',
    });
    const auth = composeAuthHooks({ hooks: [second, first], defaultScope: 'shared' });
    const ctx = httpCtx();

    await auth(ctx, endpoint());
    expect(ctx).toMatchObject({ userId: 'u1', tenantId: 't1' });

    expect(() => composeAuthHooks({ hooks: [first] })).toThrow(
      'child default scope "shared" must match the composite default scope',
    );
  });

  test('rejects cross-owner collisions before committing any owner fields', async () => {
    const first = createAuthHook({
      resolve: async () => ({ id: 'first' }),
      rules: { shared: (identity) => ({ actorId: identity.id, first: true }) },
    });
    const second = createAuthHook({
      resolve: async () => ({ id: 'second' }),
      rules: { shared: (identity) => ({ actorId: identity.id, second: true }) },
    });
    const auth = composeAuthHooks({ hooks: [first, second] });
    const ctx = httpCtx();

    await expect(auth(ctx, endpoint('shared'))).rejects.toThrow(
      'multiple owners contributed context key "actorId"',
    );
    expect(ctx.actorId).toBeUndefined();
    expect(ctx.first).toBeUndefined();
    expect(ctx.second).toBeUndefined();
  });

  test('discards staged fields when a later owner rejects', async () => {
    const first = createAuthHook({
      resolve: async () => ({ id: 'u1' }),
      rules: { shared: () => ({ userId: 'u1' }) },
    });
    const second = createAuthHook({
      resolve: async () => ({ allowed: false }),
      rules: { shared: (identity) => identity.allowed },
    });
    const auth = composeAuthHooks({ hooks: [first, second] });
    const ctx = httpCtx();

    await expect(auth(ctx, endpoint('shared'))).rejects.toThrow();
    expect(ctx.userId).toBeUndefined();
  });

  test('validates shared inject writes as contributions on the shadow context', async () => {
    const hook = createAuthHook({
      resolve: async () => ({ id: 'u1' }),
      rules: { user: 'authenticated' },
      inject: (ctx) => {
        ctx.accepted = true;
        ctx.source = 'mcp';
      },
    });
    const auth = composeAuthHooks({ hooks: [hook] });
    const ctx = httpCtx();

    await expect(auth(ctx, endpoint('user'))).rejects.toThrow('reserved key "source"');
    expect(ctx.source).toBe('http');
    expect(ctx.accepted).toBeUndefined();
  });

  test('rejects an accessor staged by an owner without invoking it', async () => {
    let getterCalls = 0;
    const hook = createAuthHook({
      resolve: async () => ({ id: 'u1' }),
      rules: { user: 'authenticated' },
      inject: (ctx) => {
        Object.defineProperty(ctx, 'derived', {
          enumerable: true,
          get: () => {
            getterCalls += 1;
            return 'secret';
          },
        });
      },
    });
    const auth = composeAuthHooks({ hooks: [hook] });
    const ctx = httpCtx();

    await expect(auth(ctx, endpoint('user'))).rejects.toThrow(
      'key "derived" must be enumerable data',
    );
    expect(getterCalls).toBe(0);
    expect(ctx.derived).toBeUndefined();
  });

  test('checks cancellation between owners and drops the completed owner delta', async () => {
    const abort = new AbortController();
    let secondCalls = 0;
    const first = createAuthHook({
      resolve: async () => ({ id: 'u1' }),
      rules: {
        shared: () => {
          abort.abort(new Error('cancelled between owners'));
          return { userId: 'u1' };
        },
      },
    });
    const second = createAuthHook({
      resolve: async () => ({ id: 't1' }),
      rules: {
        shared: () => {
          secondCalls += 1;
          return { tenantId: 't1' };
        },
      },
    });
    const auth = composeAuthHooks({ hooks: [first, second] });
    const ctx: RuntimeContext = { ...httpCtx(), signal: abort.signal };

    await expect(auth(ctx, endpoint('shared'))).rejects.toThrow('cancelled between owners');
    expect(secondCalls).toBe(0);
    expect(ctx.userId).toBeUndefined();
  });

  test('rejects a non-canonical hook from an untyped caller', () => {
    const foreign = async (): Promise<void> => undefined;
    expect(() => Reflect.apply(composeAuthHooks, undefined, [{ hooks: [foreign] }])).toThrow(
      'accepts only hooks created by createAuthHook or composeAuthHooks',
    );
  });
});
