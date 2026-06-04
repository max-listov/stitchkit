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
    toolOnly: {
      method: 'POST',
      path: '/tool',
      desc: 'MCP-only tool',
      toolName: 'tool_thing',
      expose: ['MCP'],
      input: z.object({ x: z.number() }),
    },
  },
);

const service = implement(contract, {
  list: () => ({ items: [] }),
  create: () => ({ id: '1' }),
  get: (ctx) => ({ id: ctx.params.id }),
  toolOnly: () => undefined,
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

  test('builds paths for HTTP methods and skips tool-only ones', () => {
    expect(Object.keys(doc.paths).sort()).toEqual(['/api/items', '/api/items/{id}']);
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

  test('non-GET input becomes a JSON request body', () => {
    const schema =
      spec.paths['/api/items'].post.requestBody.content['application/json'].schema;
    expect(schema.type).toBe('object');
    expect(schema.properties.name).toBeDefined();
  });

  test('a scoped contract carries 401/403 error responses', () => {
    const responses = spec.paths['/api/items'].get.responses;
    expect(responses['200']).toBeDefined();
    expect(responses['401']).toBeDefined();
    expect(responses['403']).toBeDefined();
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
