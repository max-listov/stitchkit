import { afterAll, describe, expect, test } from 'bun:test';
import { z } from 'zod';
import { createClient, createHttpClient, defineContract } from '../src';
import { createHandler, implement, respondJson } from '../src/server';
import { serveNode } from '../src/server/node';

const NullableResultSchema = z.object({ value: z.string() }).nullable();

const contract = defineContract(
  { prefix: 'output-semantics' },
  {
    nullable: {
      method: 'GET',
      path: '/nullable',
      desc: 'Return a nullable JSON value',
      output: NullableResultSchema,
    },
    object: {
      method: 'GET',
      path: '/object',
      desc: 'Return an object through the same nullable schema',
      output: NullableResultSchema,
    },
    missing: {
      method: 'GET',
      path: '/missing',
      desc: 'Reject undefined for a declared output',
      output: z.unknown(),
    },
    empty: {
      method: 'POST',
      path: '/empty',
      desc: 'Return the default empty response',
    },
    emptyNull: {
      method: 'POST',
      path: '/empty-null',
      desc: 'Accept null as an empty return without an output contract',
    },
    leaked: {
      method: 'POST',
      path: '/leaked',
      desc: 'Reject undeclared response data',
    },
    emptyOk: {
      method: 'POST',
      path: '/empty-ok',
      desc: 'Return an explicit bodyless 200',
      responseMeta: { status: 200 },
    },
    reset: {
      method: 'POST',
      path: '/reset',
      desc: 'Return an explicit bodyless 205',
      responseMeta: { status: 205 },
    },
  },
);

const service = implement(contract, {
  nullable: () => null,
  object: () => ({ value: 'object' }),
  missing: () => undefined,
  empty: () => undefined,
  emptyNull: () => undefined,
  leaked: () => undefined,
  emptyOk: () => undefined,
  reset: () => undefined,
});

const emptyNull = service.methods.emptyNull;
const leaked = service.methods.leaked;
if (!emptyNull || !leaked) throw new Error('Expected output semantics methods');
emptyNull.handler = () => null;
leaked.handler = () => ({ leaked: true });

const handler = createHandler({ services: [service] });
const bunServer = Bun.serve({ port: 0, fetch: handler });
const bunBase = `http://localhost:${bunServer.port}`;
const nodeServer = await serveNode({ services: [service], port: 0 });
const malformedContract = defineContract(
  { prefix: 'malformed-output' },
  {
    missingBody: {
      method: 'GET',
      path: '/missing-body',
      desc: 'Expect a declared JSON body',
      output: z.string(),
    },
    unexpectedBody: {
      method: 'GET',
      path: '/unexpected-body',
      desc: 'Expect no response body',
      responseMeta: { status: 200 },
    },
  },
);
const malformedServer = Bun.serve({
  port: 0,
  fetch(req) {
    return new URL(req.url).pathname.endsWith('/missing-body')
      ? new Response(null, { status: 200 })
      : Response.json({ leaked: true });
  },
});
const malformedBase = `http://localhost:${malformedServer.port}`;

afterAll(async () => {
  bunServer.stop(true);
  malformedServer.stop(true);
  await nodeServer.close(true);
});

async function response(baseUrl: string, path: string, method = 'GET'): Promise<Response> {
  return fetch(`${baseUrl}/output-semantics/${path}`, { method });
}

describe('contract-owned output semantics', () => {
  test('serializes nullable output as JSON null with status 200 on Bun and Node', async () => {
    for (const baseUrl of [bunBase, nodeServer.url]) {
      const nullable = await response(baseUrl, 'nullable');
      expect(nullable.status).toBe(200);
      expect(nullable.headers.get('content-type')).toContain('application/json');
      expect(await nullable.text()).toBe('null');

      const object = await response(baseUrl, 'object');
      expect(object.status).toBe(200);
      expect(await object.json()).toEqual({ value: 'object' });
    }
  });

  test('rejects undefined declared output and undeclared non-empty data', async () => {
    for (const baseUrl of [bunBase, nodeServer.url]) {
      const missing = await response(baseUrl, 'missing');
      expect(missing.status).toBe(500);
      expect(await missing.json()).toMatchObject({
        error: { code: 'INTERNAL_SERVER_ERROR' },
      });

      const leaked = await response(baseUrl, 'leaked', 'POST');
      expect(leaked.status).toBe(500);
      expect(await leaked.json()).toMatchObject({
        error: { code: 'INTERNAL_SERVER_ERROR' },
      });
    }
  });

  test('keeps no-output returns bodyless and contract-owned', async () => {
    for (const baseUrl of [bunBase, nodeServer.url]) {
      const empty = await response(baseUrl, 'empty', 'POST');
      expect(empty.status).toBe(204);
      expect(await empty.text()).toBe('');

      const emptyNullResponse = await response(baseUrl, 'empty-null', 'POST');
      expect(emptyNullResponse.status).toBe(204);
      expect(await emptyNullResponse.text()).toBe('');

      const emptyOk = await response(baseUrl, 'empty-ok', 'POST');
      expect(emptyOk.status).toBe(200);
      expect(await emptyOk.text()).toBe('');

      const reset = await response(baseUrl, 'reset', 'POST');
      expect(reset.status).toBe(205);
      expect(await reset.text()).toBe('');
    }
  });

  test('configured and Fetch clients distinguish null from every bodyless status', async () => {
    for (const baseUrl of [bunBase, nodeServer.url]) {
      const configured = createClient(contract, createHttpClient({ baseUrl }));
      const fetchClient = createClient(contract, { baseUrl });

      const configuredNull: { value: string } | null = await configured.nullable();
      const fetchNull: { value: string } | null = await fetchClient.nullable();
      expect(configuredNull).toBeNull();
      expect(fetchNull).toBeNull();

      const configuredEmpty: undefined = await configured.empty();
      const fetchEmpty: undefined = await fetchClient.empty();
      const configuredOk: undefined = await configured.emptyOk();
      const fetchOk: undefined = await fetchClient.emptyOk();
      const configuredReset: undefined = await configured.reset();
      const fetchReset: undefined = await fetchClient.reset();
      expect([
        configuredEmpty,
        fetchEmpty,
        configuredOk,
        fetchOk,
        configuredReset,
        fetchReset,
      ]).toEqual([undefined, undefined, undefined, undefined, undefined, undefined]);
    }
  });

  test('both clients reject a response whose body presence violates the contract', async () => {
    const configured = createClient(
      malformedContract,
      createHttpClient({ baseUrl: malformedBase, retry: { limit: 0 } }),
    );
    const fetchClient = createClient(malformedContract, { baseUrl: malformedBase });

    await expect(configured.missingBody()).rejects.toThrow();
    await expect(fetchClient.missingBody()).rejects.toThrow();
    await expect(configured.unexpectedBody()).rejects.toThrow();
    await expect(fetchClient.unexpectedBody()).rejects.toThrow();
  });

  test('keeps the low-level respondJson nullish convention unchanged', async () => {
    for (const value of [null, undefined]) {
      const result = respondJson(value);
      expect(result.status).toBe(204);
      expect(await result.text()).toBe('');
    }
  });
});
