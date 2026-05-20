/**
 * `createAuthHook` on both surfaces — HTTP (identity from `ctx.req`) and tool
 * calls (identity from `resolveFromContext`). A scoped tool call must never
 * silently pass: without `resolveFromContext` it fails closed. See ADR 0014.
 */
import { describe, expect, test } from 'bun:test';
import type { RuntimeContext } from '../src/contract';
import { createAuthHook } from '../src/server/middleware/auth';
import type { MethodDef } from '../src/server/types';

interface Identity {
  admin: boolean;
}

function endpoint(scope?: string): MethodDef {
  return { method: 'POST', path: '/', desc: 'test', handler: () => undefined, scope };
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
