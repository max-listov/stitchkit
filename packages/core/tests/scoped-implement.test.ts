import { describe, expect, test } from 'bun:test';
import { z } from 'zod';
import { defineContract } from '../src/contract';
import { createScopedImplement } from '../src/server/implement';

const implementFor = createScopedImplement<{
  public: object;
  user: { userId: string };
  admin: { userId: string; isAdmin: boolean };
}>();

const output = z.object({ ok: z.boolean() });

const mixed = defineContract(
  { prefix: 'posts', scope: 'user' },
  {
    list: { method: 'GET', path: '/', desc: 'List posts', output },
    purge: { method: 'DELETE', path: '/all', desc: 'Purge posts', scope: 'admin', output },
    ping: { method: 'GET', path: '/ping', desc: 'Ping', scope: 'public', output },
  },
);

const unscoped = defineContract(
  { prefix: 'posts-lite' },
  { read: { method: 'GET', path: '/', desc: 'Read', output } },
);

describe('createScopedImplement', () => {
  test('mounts a contract whose endpoints declare different scopes', () => {
    const service = implementFor(mixed, {
      list: (ctx) => ({ ok: ctx.userId.length > 0 }),
      purge: (ctx) => ({ ok: ctx.isAdmin }),
      ping: () => ({ ok: true }),
    });

    expect(service.scope).toBe('user');
    expect(service.methods.list?.scope).toBe('user');
    expect(service.methods.purge?.scope).toBe('admin');
    expect(service.methods.ping?.scope).toBe('public');
  });

  test('a contract without a scope resolves to public on every endpoint', () => {
    const service = implementFor(unscoped, { read: () => ({ ok: true }) });

    expect(service.scope).toBe('public');
    expect(service.methods.read?.scope).toBe('public');
  });

  test('runs the handler with the mounted context, unchanged by scoped typing', async () => {
    const service = implementFor(mixed, {
      list: (ctx) => ({ ok: ctx.userId === 'u1' }),
      purge: () => ({ ok: false }),
      ping: () => ({ ok: true }),
    });

    const result = await service.methods.list?.handler({
      params: undefined,
      input: undefined,
      source: 'http',
      userId: 'u1',
    });

    expect(result).toEqual({ ok: true });
  });

  test('keeps the same construction-time completeness check as implement', () => {
    expect(() => Reflect.apply(implementFor, undefined, [mixed, {}])).toThrow(
      '[stitchkit] implement: missing handler for "posts.list"',
    );
  });
});
