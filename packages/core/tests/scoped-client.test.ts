import { afterAll, describe, expect, test } from 'bun:test';
import { z } from 'zod';
import { createClient, createClients } from '../src/browser/client';
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
    upload: {
      method: 'POST',
      path: '/upload',
      desc: 'Upload',
      multipart: { files: { file: {} } },
      input: z.object({ title: z.string() }),
      output: z.object({ title: z.string(), bytes: z.number() }),
    },
    download: {
      method: 'GET',
      path: '/download',
      desc: 'Download',
      rawResponse: true,
      contentType: 'text/plain',
    },
    hidden: {
      method: 'GET',
      path: '/hidden',
      desc: 'Tool only',
      expose: ['MCP'],
      output: z.object({ ok: z.boolean() }),
    },
  },
);

const service = implement(widgets, {
  list: () => ['w'],
  create: (ctx) => ({ id: '1', name: ctx.input.name }),
  upload: (ctx) => {
    return { title: ctx.input.title, bytes: ctx.files.file.size };
  },
  download: () => new Response('downloaded', { headers: { 'Content-Type': 'text/plain' } }),
  hidden: () => ({ ok: true }),
});

// Mount the contract under a resource-scoped prefix — the scoped client must
// build `tenants/:tenantId/widgets` for the request to land here at all.
const server = createServer({
  port: 0,
  groups: [{ pathPrefix: 'tenants/:tenantId', services: [service] }],
});
const baseUrl = `http://localhost:${server.port}`;

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

  test('batch clients reuse scoped JSON, query, multipart and raw-response paths', async () => {
    const http = createHttpClient({ baseUrl });
    const api = createClients({ widgets }, http, {
      pathPrefix: ({ tenantId }) => `tenants/${tenantId}`,
      stripPrefixKeys: ['tenantId'],
    });

    expect(await api.widgets.list({ tenantId: 't1' })).toEqual(['w']);
    expect(await api.widgets.create({ tenantId: 't1', name: 'batch' })).toEqual({
      id: '1',
      name: 'batch',
    });
    expect(
      await api.widgets.upload({
        tenantId: 't1',
        title: 'asset',
        file: new File(['abc'], 'asset.txt', { type: 'text/plain' }),
      }),
    ).toEqual({ title: 'asset', bytes: 3 });
    const response = await api.widgets.download({ tenantId: 't1' });
    expect(await response.text()).toBe('downloaded');
  });

  test('batch clients support the bare ClientConfig transport', async () => {
    const api = createClients(
      { widgets },
      { baseUrl },
      {
        stripPrefixKeys: ['tenantId'],
        pathPrefix: ({ tenantId }) => `tenants/${tenantId}`,
      },
    );
    expect(await api.widgets.list({ tenantId: 't1' })).toEqual(['w']);
  });

  test('an untyped caller missing a dynamic prefix key fails before dispatch', async () => {
    const api = createClients(
      { widgets },
      { baseUrl },
      {
        stripPrefixKeys: ['tenantId'],
        pathPrefix: ({ tenantId }) => `tenants/${tenantId}`,
      },
    );
    const loose: { widgets: { list(args: Record<string, unknown>): Promise<unknown> } } = api;
    await expect(loose.widgets.list({})).rejects.toThrow('Missing path prefix key: tenantId');
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

  const batchPrefixFirst = createClients({ widgets }, http, {
    pathPrefix: ({ tenantId }) => `tenants/${tenantId}`,
    stripPrefixKeys: ['tenantId'],
  });
  const batchKeysFirst = createClients({ widgets }, http, {
    stripPrefixKeys: ['tenantId'],
    pathPrefix: ({ tenantId }) => `tenants/${tenantId}`,
  });
  void batchPrefixFirst.widgets.list({ tenantId: 't1' });
  void batchKeysFirst.widgets.create({ tenantId: 't1', name: 'w' });
  void batchKeysFirst.widgets.upload({
    tenantId: 't1',
    title: 'file',
    file: { uri: 'file:///x', name: 'x', type: 'text/plain' },
  });
  const rawResult: Promise<Response> = batchKeysFirst.widgets.download({ tenantId: 't1' });
  void rawResult;
  // @ts-expect-error tool-only endpoints are absent from HTTP clients
  void batchKeysFirst.widgets.hidden;
  // @ts-expect-error tenantId is required on every batch method
  void batchKeysFirst.widgets.list();
  // @ts-expect-error scoped keys are strings
  void batchKeysFirst.widgets.list({ tenantId: 1 });
}
void _typeChecks;
