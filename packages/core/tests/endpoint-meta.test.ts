/**
 * `EndpointDef.meta` — opaque per-endpoint metadata rides through to
 * `MethodDef.meta`, readable in lifecycle hooks and on tool mounts, and is
 * never serialized into the OpenAPI document. → ADR 0021.
 */
import { describe, expect, test } from 'bun:test';
import { z } from 'zod';
import { defineContract } from '../src/contract';
import { createHandler, implement } from '../src/server';
import { generateOpenApiDocument } from '../src/server/openapi';
import type { MethodDef } from '../src/server/types';
import { collectTools } from '../src/tools/mount';

const GATED_META = { requiredFeature: 'broadcasts', rateTier: 2 } as const;

const contract = defineContract(
  { prefix: 'meta', scope: 'public' },
  {
    gated: {
      method: 'POST',
      path: '/gated',
      desc: 'Feature-gated endpoint',
      output: z.object({ ok: z.boolean() }),
      meta: GATED_META,
    },
    plain: {
      method: 'GET',
      path: '/plain',
      desc: 'Endpoint with no meta',
      output: z.object({ ok: z.boolean() }),
    },
  },
);

const service = implement(contract, {
  gated: () => ({ ok: true }),
  plain: () => ({ ok: true }),
});

describe('EndpointDef.meta passthrough', () => {
  test('meta round-trips contract → implement → MethodDef.meta', () => {
    expect(service.methods.gated?.meta).toEqual(GATED_META);
  });

  test('an endpoint without meta yields MethodDef.meta === undefined (not {})', () => {
    expect(service.methods.plain?.meta).toBeUndefined();
  });

  test('beforeHandle sees endpoint.meta on the HTTP path', async () => {
    let seen: Record<string, unknown> | undefined;
    const handler = createHandler({
      services: [service],
      hooks: {
        beforeHandle: (_ctx, endpoint: MethodDef) => {
          seen = endpoint.meta;
        },
      },
    });

    const res = await handler(new Request('http://localhost/meta/gated', { method: 'POST' }));

    expect(res.status).toBe(200);
    expect(seen).toEqual(GATED_META);
  });

  test('meta survives onto a tool mount (MCP)', () => {
    const tools = collectTools(service, 'MCP');
    const withMeta = tools.filter((t) => t.method.meta !== undefined);
    expect(withMeta).toHaveLength(1);
    expect(withMeta[0]?.method.meta).toEqual(GATED_META);
  });

  test('meta never appears in the OpenAPI document', () => {
    const doc = generateOpenApiDocument({
      info: { title: 'Meta API', version: '1.0.0' },
      services: [service],
    });
    // The gated path is present, but the private meta marker is not.
    const json = JSON.stringify(doc);
    expect(json).toContain('/meta/gated');
    expect(json).not.toContain('broadcasts');
    expect(json).not.toContain('rateTier');
  });
});
