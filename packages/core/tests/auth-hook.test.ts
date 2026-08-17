/**
 * `createAuthHook` on both surfaces — HTTP (identity from `ctx.req`) and tool
 * calls (identity from `resolveFromContext`). A scoped tool call must never
 * silently pass: without `resolveFromContext` it fails closed. See ADR 0014.
 */
import { describe, expect, test } from 'bun:test';
import type { RuntimeContext } from '../src/contract';
import { createAuthHook } from '../src/server/middleware/auth';
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
});
