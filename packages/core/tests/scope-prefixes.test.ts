import { afterAll, describe, expect, test } from 'bun:test';
import { z } from 'zod';
import { defineContract } from '../src/contract';
import { createServer, implement } from '../src/server';

// A tenant-scoped contract and a public one — scope drives where each mounts.
const widgets = defineContract(
  { prefix: 'widgets', scope: 'tenant' },
  { list: { method: 'GET', path: '/', desc: 'List', output: z.array(z.string()) } },
);
const health = defineContract(
  { prefix: 'health', scope: 'public' },
  {
    check: { method: 'GET', path: '/', desc: 'Health', output: z.object({ ok: z.boolean() }) },
  },
);

const widgetsService = implement(widgets, {
  // A group `:param` is spread onto the context as a top-level key.
  list: (ctx) => [String(ctx.tenantId)],
});
const healthService = implement(health, { check: () => ({ ok: true }) });

const server = createServer({
  port: 0,
  services: [widgetsService, healthService],
  scopePrefixes: { tenant: 'tenants/:tenantId' },
});
const base = `http://localhost:${server.port}`;

describe('scopePrefixes — scope drives the mount prefix', () => {
  afterAll(() => server.shutdown({ gracePeriodMs: 0 }));

  test('a tenant-scoped service mounts under its prefix; :param reaches pathParams', async () => {
    const res = await fetch(`${base}/tenants/acme/widgets`);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual(['acme']);
  });

  test('the same service is NOT mounted flat', async () => {
    expect((await fetch(`${base}/widgets`)).status).toBe(404);
  });

  test('an unmapped scope mounts flat', async () => {
    const res = await fetch(`${base}/health`);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true });
  });
});
