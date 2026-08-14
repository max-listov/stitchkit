/**
 * OpenAPI 3.1 generation — paths, path/query parameters, request bodies and
 * responses are derived from the contract; HTTP-only methods are included and
 * tool-only methods are skipped, matching the router's route-building rule.
 */
import { describe, expect, test } from 'bun:test';
import { z } from 'zod';
import { defineContract } from '../src/contract';
import { implement } from '../src/server';
import { generateOpenApiDocument, openApiRoute } from '../src/server/openapi';

const contract = defineContract(
  { prefix: 'api', scope: 'authed' },
  {
    list: {
      method: 'GET',
      path: '/items',
      desc: 'List items',
      input: z.object({ q: z.string().optional() }),
      output: z.object({ items: z.array(z.string()) }),
    },
    create: {
      method: 'POST',
      path: '/items',
      desc: 'Create an item',
      input: z.object({ name: z.string() }),
      output: z.object({ id: z.string() }),
    },
    get: {
      method: 'GET',
      path: '/items/:id',
      desc: 'Get an item',
      params: z.strictObject({ id: z.string() }),
      output: z.object({ id: z.string() }),
    },
    appFallback: {
      method: 'GET',
      path: '/apps/:slug/*filePath',
      desc: 'Serve an app deep link',
      params: z.object({ slug: z.string(), filePath: z.string().describe('Nested path') }),
      output: z.object({ ok: z.boolean() }),
    },
    toolOnly: {
      method: 'POST',
      path: '/tool',
      desc: 'MCP-only tool',
      toolName: 'tool_thing',
      expose: ['MCP'],
      input: z.object({ x: z.number() }),
    },
    accepted: {
      method: 'POST',
      path: '/accepted',
      desc: 'Return typed data with a declared success status',
      output: z.object({ queued: z.boolean() }),
      responseMeta: { status: 202 },
    },
    nullable: {
      method: 'GET',
      path: '/nullable',
      desc: 'Return nullable typed data',
      output: z.object({ value: z.string() }).nullable(),
    },
    empty: {
      method: 'POST',
      path: '/empty',
      desc: 'Return the default empty response',
    },
    reset: {
      method: 'POST',
      path: '/reset',
      desc: 'Return an explicit empty success status',
      responseMeta: { status: 205 },
    },
    upload: {
      method: 'POST',
      path: '/upload',
      desc: 'Upload typed files',
      input: z.object({ title: z.string() }),
      multipart: {
        files: {
          cover: { required: false, maxBytes: 1024, contentTypes: ['image/*'] },
          attachments: {
            multiple: true,
            maxFiles: 2,
            maxBytes: 2048,
            contentTypes: ['application/pdf'],
          },
        },
      },
      output: z.object({ count: z.number() }),
    },
  },
);

const service = implement(contract, {
  list: () => ({ items: [] }),
  create: () => ({ id: '1' }),
  get: (ctx) => ({ id: ctx.params.id }),
  appFallback: () => ({ ok: true }),
  toolOnly: () => undefined,
  accepted: ({ response }) => {
    response.headers.set('x-queued', 'true');
    return { queued: true };
  },
  nullable: () => null,
  empty: () => undefined,
  reset: () => undefined,
  upload: ({ files }) => ({ count: files.attachments.length }),
});

const doc = generateOpenApiDocument({
  info: { title: 'API', version: '1.0.0' },
  services: [service],
});

// A JSON round-trip view for deep field assertions — reading the spec the way a
// consumer would, without threading the document's narrow types through `as`.
const spec = JSON.parse(JSON.stringify(doc));

describe('generateOpenApiDocument', () => {
  test('emits a 3.1.0 document with the contract info', () => {
    expect(doc.openapi).toBe('3.1.0');
    expect(doc.info.title).toBe('API');
  });

  test('exposes contract metadata used by surface conformance', () => {
    expect(spec.paths['/api/items'].get).toMatchObject({
      'x-stitchkit-scope': 'authed',
      'x-stitchkit-has-input': true,
      'x-stitchkit-has-output': true,
    });
  });

  test('builds paths for HTTP methods and skips tool-only ones', () => {
    expect(Object.keys(doc.paths).sort()).toEqual([
      '/api/accepted',
      '/api/apps/{slug}/*filePath',
      '/api/empty',
      '/api/items',
      '/api/items/{id}',
      '/api/nullable',
      '/api/reset',
      '/api/upload',
    ]);
    expect(doc.paths['/api/tool']).toBeUndefined();
  });

  test('GET input becomes query parameters', () => {
    const q = spec.paths['/api/items'].get.parameters.find(
      (p: { name: string }) => p.name === 'q',
    );
    expect(q.in).toBe('query');
    expect(q.required).toBe(false);
  });

  test('path params are required and in:path', () => {
    const id = spec.paths['/api/items/{id}'].get.parameters.find(
      (p: { name: string }) => p.name === 'id',
    );
    expect(id.in).toBe('path');
    expect(id.required).toBe(true);
  });

  test('marks a trailing wildcard honestly without an invalid OpenAPI path param', () => {
    const operation = spec.paths['/api/apps/{slug}/*filePath'].get;
    expect(operation.parameters.map((parameter: { name: string }) => parameter.name)).toEqual([
      'slug',
    ]);
    expect(operation['x-stitchkit-trailing-wildcard']).toEqual({
      parameter: 'filePath',
      required: true,
      schema: { type: 'string', description: 'Nested path' },
      description:
        "Matches zero or more trailing path segments and exposes their '/'-joined remainder as params.filePath.",
    });
  });

  test('non-GET input becomes a JSON request body', () => {
    const schema =
      spec.paths['/api/items'].post.requestBody.content['application/json'].schema;
    expect(schema.type).toBe('object');
    expect(schema.properties.name).toBeDefined();
  });

  test('multipart descriptors preserve cardinality, required fields and file policy', () => {
    const requestBody = spec.paths['/api/upload'].post.requestBody;
    const schema = requestBody.content['multipart/form-data'].schema;
    expect(requestBody.required).toBe(true);
    expect(schema.required).toEqual(['title', 'attachments']);
    expect(schema.properties.cover).toEqual({
      type: 'string',
      format: 'binary',
      maxLength: 1024,
      'x-accepted-content-types': ['image/*'],
    });
    expect(schema.properties.attachments).toEqual({
      type: 'array',
      items: {
        type: 'string',
        format: 'binary',
        maxLength: 2048,
        'x-accepted-content-types': ['application/pdf'],
      },
      minItems: 1,
      maxItems: 2,
    });
  });

  test('a scoped contract carries 401/403 error responses', () => {
    const responses = spec.paths['/api/items'].get.responses;
    expect(responses['200']).toBeDefined();
    expect(responses['401']).toBeDefined();
    expect(responses['403']).toBeDefined();
  });

  test('uses the declared success status for typed and empty metadata endpoints', () => {
    expect(spec.paths['/api/accepted'].post.responses['202']).toBeDefined();
    expect(spec.paths['/api/accepted'].post.responses['200']).toBeUndefined();
    expect(spec.paths['/api/reset'].post.responses['205']).toEqual({
      description: 'No content',
    });
  });

  test('derives default success responses from the output contract', () => {
    const nullable = spec.paths['/api/nullable'].get.responses;
    const empty = spec.paths['/api/empty'].post.responses;
    expect(nullable['200'].content['application/json'].schema.anyOf).toBeDefined();
    expect(nullable['204']).toBeUndefined();
    expect(empty['204']).toEqual({ description: 'No content' });
    expect(empty['200']).toBeUndefined();
  });
});

describe('openApiRoute', () => {
  test('serves the document as JSON', async () => {
    const route = openApiRoute('/openapi.json', doc);
    expect(route.method).toBe('GET');
    expect(route.path).toBe('/openapi.json');
    const res = await route.handler(new Request('http://localhost/openapi.json'), {
      params: {},
    });
    expect(res.headers.get('content-type')).toContain('application/json');
    const body = await res.json();
    expect(body.openapi).toBe('3.1.0');
  });
});

// ─── Curated subset — includeMethod + the meta.public allowlist ───────────────

const curatedContract = defineContract(
  { prefix: 'acct', scope: 'account' },
  {
    // Advertised to external clients — flagged declaratively via `meta`.
    balance: {
      method: 'GET',
      path: '/balance',
      desc: 'Get account balance',
      meta: { public: true },
      output: z.object({ publicBalanceField: z.number() }),
    },
    // Internal — no flag; must not appear (nor its schema shape) in a public spec.
    rotateKeys: {
      method: 'POST',
      path: '/rotate-keys',
      desc: 'Rotate API keys',
      input: z.object({ internalSecretField: z.string() }),
      output: z.object({ ok: z.boolean() }),
    },
  },
);

const curatedService = implement(curatedContract, {
  balance: () => ({ publicBalanceField: 0 }),
  rotateKeys: () => ({ ok: true }),
});

describe('generateOpenApiDocument — includeMethod', () => {
  const publicDoc = generateOpenApiDocument({
    info: { title: 'Public API', version: '1.0.0' },
    services: [curatedService],
    includeMethod: (m) => m.meta?.public === true,
  });
  const publicJson = JSON.stringify(publicDoc);

  test('emits only the flagged methods', () => {
    expect(Object.keys(publicDoc.paths)).toEqual(['/acct/balance']);
    expect(publicDoc.paths['/acct/rotate-keys']).toBeUndefined();
  });

  test("a hidden method's inlined schema shape does not leak anywhere", () => {
    // Schemas are inlined per-operation (no shared components) — an excluded
    // method's shape must be absent from the whole document, not just its path.
    expect(publicJson).toContain('publicBalanceField');
    expect(publicJson).not.toContain('internalSecretField');
    expect(publicJson).not.toContain('rotate-keys');
  });

  test('without the predicate every HTTP method is still included (default unchanged)', () => {
    const full = generateOpenApiDocument({
      info: { title: 'Internal API', version: '1.0.0' },
      services: [curatedService],
    });
    expect(Object.keys(full.paths).sort()).toEqual(['/acct/balance', '/acct/rotate-keys']);
  });
});
