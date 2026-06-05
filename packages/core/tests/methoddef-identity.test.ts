/**
 * `MethodDef.serviceName` / `MethodDef.key` — stable (service, action) identity
 * for hooks / audit, populated by `implement` and `implementRemote`. → ADR 0022.
 * Also covers the `implementRemote` `meta` passthrough (was dropped). → ADR 0021.
 */
import { describe, expect, test } from 'bun:test';
import { z } from 'zod';
import { createHttpClient } from '../src/browser/http';
import { defineContract } from '../src/contract';
import { createHandler, implement } from '../src/server';
import type { MethodDef } from '../src/server/types';
import { implementRemote } from '../src/tools/remote';

const GATED_META = { requiredFeature: 'broadcasts' } as const;

const contract = defineContract(
  { prefix: 'widgets', scope: 'public' },
  {
    list: {
      method: 'GET',
      path: '/',
      desc: 'List widgets',
      output: z.object({ ok: z.boolean() }),
    },
    gated: {
      method: 'POST',
      path: '/gated',
      desc: 'Gated',
      output: z.object({ ok: z.boolean() }),
      meta: GATED_META,
    },
  },
);

const service = implement(contract, {
  list: () => ({ ok: true }),
  gated: () => ({ ok: true }),
});

describe('MethodDef (service, action) identity', () => {
  test('implement stamps serviceName (= prefix) and key (= endpoint key)', () => {
    expect(service.methods.list?.serviceName).toBe('widgets');
    expect(service.methods.list?.key).toBe('list');
    expect(service.methods.gated?.serviceName).toBe('widgets');
    expect(service.methods.gated?.key).toBe('gated');
  });

  test('afterHandle reads endpoint.serviceName / endpoint.key', async () => {
    let seen: { serviceName: string; key: string } | undefined;
    const handler = createHandler({
      services: [service],
      hooks: {
        afterHandle: (_ctx, result, endpoint: MethodDef) => {
          seen = { serviceName: endpoint.serviceName, key: endpoint.key };
          return result;
        },
      },
    });

    const res = await handler(new Request('http://localhost/widgets', { method: 'GET' }));
    expect(res.status).toBe(200);
    expect(seen).toEqual({ serviceName: 'widgets', key: 'list' });
  });

  test('implementRemote stamps identity and passes meta through', () => {
    // The handlers are never invoked here — we inspect the built ServiceDef only.
    const remote = implementRemote(
      contract,
      createHttpClient({ baseUrl: 'http://localhost' }),
    );
    expect(remote.methods.gated?.serviceName).toBe('widgets');
    expect(remote.methods.gated?.key).toBe('gated');
    expect(remote.methods.gated?.meta).toEqual(GATED_META);
    expect(remote.methods.list?.meta).toBeUndefined();
  });
});
