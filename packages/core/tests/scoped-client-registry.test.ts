import { describe, expect, test } from 'bun:test';
import { z } from 'zod';
import { createScopedClients } from '../src/browser/client';
import { createHttpClient } from '../src/browser/http';
import { defineContract } from '../src/contract';

const OkSchema = z.object({ ok: z.boolean() });
const publicAuth = defineContract(
  { prefix: 'auth', scope: 'public' },
  { login: { method: 'POST', path: '/login', desc: 'Login', output: OkSchema } },
);
const privateAuth = defineContract(
  { prefix: 'auth', scope: 'client' },
  { me: { method: 'GET', path: '/me', desc: 'Current user', output: OkSchema } },
);
const widgets = defineContract(
  { prefix: 'widgets', scope: 'tenant' },
  {
    list: { method: 'GET', path: '/', desc: 'List widgets', output: OkSchema },
    create: {
      method: 'POST',
      path: '/',
      desc: 'Create widget',
      input: z.object({ name: z.string() }),
      output: OkSchema,
    },
  },
);

describe('createScopedClients', () => {
  test('routes by scope and composes namespaces', async () => {
    const seen: Array<{ path: string; body: unknown }> = [];
    const server = Bun.serve({
      port: 0,
      async fetch(req) {
        seen.push({
          path: new URL(req.url).pathname,
          body: req.method === 'POST' ? await req.json().catch(() => undefined) : undefined,
        });
        return Response.json({ ok: true });
      },
    });
    try {
      const api = createScopedClients(
        { auth: [publicAuth, privateAuth], widgets },
        createHttpClient({ baseUrl: `http://localhost:${server.port}` }),
        {
          public: {},
          client: {},
          tenant: {
            stripPrefixKeys: ['tenantId'],
            pathPrefix: ({ tenantId }) => `tenants/${tenantId}`,
          },
        },
      );
      await api.auth.login();
      await api.auth.me();
      await api.widgets.create({ tenantId: 't1', name: 'A' });
      expect(seen).toEqual([
        { path: '/auth/login', body: undefined },
        { path: '/auth/me', body: undefined },
        { path: '/tenants/t1/widgets', body: { name: 'A' } },
      ]);
    } finally {
      server.stop(true);
    }
  });

  test('fails first on missing scope config and duplicate method', () => {
    const http = createHttpClient({ baseUrl: 'http://localhost' });
    expect(() =>
      createScopedClients({ auth: [publicAuth, publicAuth] }, http, { public: {} }),
    ).toThrow('Client namespace "auth" has duplicate method: login');
  });
});

function _typeChecks(): void {
  const api = createScopedClients(
    { auth: [publicAuth, privateAuth], widgets },
    createHttpClient({ baseUrl: 'http://localhost' }),
    {
      public: {},
      client: {},
      tenant: {
        stripPrefixKeys: ['tenantId'],
        pathPrefix: ({ tenantId }) => `tenants/${tenantId}`,
      },
    },
  );
  void api.auth.login();
  void api.auth.me();
  void api.widgets.list({ tenantId: 't1' });
  void api.widgets.create({ tenantId: 't1', name: 'A' });
  // @ts-expect-error tenant key is required
  void api.widgets.list();
  // @ts-expect-error body remains exact
  void api.widgets.create({ tenantId: 't1' });
}
void _typeChecks;
