import { afterAll, describe, expect, test } from 'bun:test';
import { z } from 'zod';
import { createClient } from '../src/browser/client';
import { createHttpClient } from '../src/browser/http';
import { defineContract } from '../src/contract';
import { createServer, implement } from '../src/server';

const widgets = defineContract(
  { prefix: 'widgets' },
  {
    list: { method: 'GET', path: '/', desc: 'List', output: z.array(z.string()) },
    create: {
      method: 'POST',
      path: '/',
      desc: 'Create',
      input: z.object({ name: z.string() }),
      output: z.object({ id: z.string(), name: z.string() }),
    },
  },
);

const service = implement(widgets, {
  list: () => ['w'],
  create: (ctx) => ({ id: '1', name: ctx.input.name }),
});

// Mount the contract under a resource-scoped prefix — the scoped client must
// build `tenants/:tenantId/widgets` for the request to land here at all.
const PORT = 9899;
const baseUrl = `http://localhost:${PORT}`;
const server = createServer({
  port: PORT,
  groups: [{ pathPrefix: 'tenants/:tenantId', services: [service] }],
});

describe('scoped client (stripPrefixKeys) — runtime', () => {
  afterAll(() => server.stop(true));

  test('the consumed key drives the URL prefix → request reaches the scoped route', async () => {
    const http = createHttpClient({ baseUrl });
    const api = createClient(widgets, http, {
      pathPrefix: (a) => `tenants/${String(a.tenantId)}/`,
      stripPrefixKeys: ['tenantId'],
    });

    // tenantId is consumed by the prefix (URL), name goes in the body.
    const created = await api.create({ tenantId: 't1', name: 'w' });
    expect(created).toEqual({ id: '1', name: 'w' });
    expect(await api.list({ tenantId: 't1' })).toEqual(['w']);
  });

  test('without the prefix the same path 404s (proves the prefix was applied)', async () => {
    const http = createHttpClient({ baseUrl });
    const plain = createClient(widgets, http); // hits `/widgets`, not under a tenant
    await expect(plain.list()).rejects.toThrow();
  });

  test('the bare-fetch client (ClientConfig) also applies pathPrefix + strips keys', async () => {
    // No HttpClient — a plain { baseUrl } config. The scoped config must still
    // take effect on this branch (it was previously ignored here).
    const api = createClient(
      widgets,
      { baseUrl },
      {
        pathPrefix: (a) => `tenants/${String(a.tenantId)}/`,
        stripPrefixKeys: ['tenantId'],
      },
    );

    expect(await api.create({ tenantId: 't1', name: 'w' })).toEqual({ id: '1', name: 'w' });
    expect(await api.list({ tenantId: 't1' })).toEqual(['w']);
  });
});

// ─── Type-level: consumed keys are required, typed args (checked by tsc) ──────
// Never executed — the `check` step (`tsc --noEmit`) validates these.
function _typeChecks() {
  const http = createHttpClient({ baseUrl });
  const api = createClient(widgets, http, { stripPrefixKeys: ['tenantId'] });

  // tenantId is now a required arg on every method — no hand-written wrapper.
  void api.list({ tenantId: 't1' });
  void api.create({ tenantId: 't1', name: 'w' });

  // @ts-expect-error tenantId is required (consumed by the scope)
  void api.create({ name: 'w' });

  // A plain client (no stripPrefixKeys) keeps the original arg types.
  const plain = createClient(widgets, http);
  void plain.list();
  // @ts-expect-error a plain client has no tenantId arg
  void plain.list({ tenantId: 't1' });
}
void _typeChecks;
