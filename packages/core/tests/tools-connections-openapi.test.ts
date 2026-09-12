/**
 * OpenAPI connections: one tool per operation, security-scheme placement and
 * the request host fence, exercised against a real `Bun.serve`.
 */
import { afterEach, describe, expect, test } from 'bun:test';
import { mountAgent } from '../src/tools/agent';
import {
  ConnectionRequestError,
  ConnectionUrlError,
  defineOpenApiConnection,
  mountConnections,
} from '../src/tools/connections';
import {
  ConnectionResponseTooLargeError,
  ConnectionTimeoutError,
} from '../src/tools/connections/errors';
import {
  assertOpenApiOperation,
  resolveOpenApiDocument,
} from '../src/tools/connections/openapi-document';
import type { RuntimeToolDefinition } from '../src/tools/runtime-tool';

test('local references resolve and unsupported transport semantics fail closed', () => {
  const document = {
    components: { schemas: { Value: { type: 'string' } } },
    body: { $ref: '#/components/schemas/Value' },
  };
  expect(resolveOpenApiDocument(document).body).toEqual({ type: 'string' });
  expect(() => resolveOpenApiDocument({ a: { $ref: '#/a' } })).toThrow('recursive references');
  expect(() => resolveOpenApiDocument({ a: { $ref: 'https://example.test/schema' } })).toThrow(
    'external references',
  );
  expect(() => resolveOpenApiDocument({ a: { $ref: '#/missing' } })).toThrow(
    'does not resolve',
  );
  expect(() =>
    assertOpenApiOperation({ security: [{ first: [], second: [] }] }, {}, {}),
  ).toThrow('combined security');
  expect(() =>
    assertOpenApiOperation({}, { requestBody: { content: { 'text/plain': {} } } }, {}),
  ).toThrow('application/json');
});

interface CapturedRequest {
  method: string;
  url: URL;
  headers: Headers;
  body: string;
}

const servers: Array<{ stop: () => Promise<void> | void }> = [];

afterEach(() => {
  for (const server of servers.splice(0)) void server.stop();
});

async function callTool(
  definitions: readonly RuntimeToolDefinition[],
  name: string,
  input: Record<string, unknown>,
): Promise<unknown> {
  const tools = mountAgent([], { runtimeTools: definitions });
  const entry = tools[name];
  if (!entry?.execute) throw new Error(`tool ${name} was not mounted`);
  const execute = entry.execute as unknown as (
    input: Record<string, unknown>,
    options: { toolCallId: string; messages: unknown[] },
  ) => Promise<unknown>;
  return execute(input, { toolCallId: 'test', messages: [] });
}

function callRaw(
  definition: RuntimeToolDefinition,
  input: Record<string, unknown>,
): Promise<unknown> {
  const handler = definition.handler as unknown as (
    context: Record<string, unknown>,
  ) => Promise<unknown>;
  return handler({ input, params: undefined, source: 'agent' });
}

function startApiServer() {
  const requests: CapturedRequest[] = [];
  const server = Bun.serve({
    port: 0,
    fetch: async (request) => {
      const url = new URL(request.url);
      const body =
        request.method === 'GET' || request.method === 'HEAD' ? '' : await request.text();
      requests.push({ method: request.method, url, headers: request.headers, body });
      return new Response(JSON.stringify({ ok: true, path: url.pathname, url: request.url }), {
        headers: { 'content-type': 'application/json' },
      });
    },
  });
  const handle = {
    base: `http://127.0.0.1:${server.port}`,
    host: `127.0.0.1:${server.port}`,
    requests,
    stop: () => server.stop(true),
  };
  servers.push(handle);
  return handle;
}

function buildSpec(base: string, other?: string) {
  return {
    openapi: '3.1.0',
    info: { title: 'Pet API', version: '1' },
    servers: [{ url: `${base}/api` }],
    components: {
      securitySchemes: {
        bearerAuth: { type: 'http', scheme: 'bearer' },
        basicAuth: { type: 'http', scheme: 'basic' },
        headerKey: { type: 'apiKey', in: 'header', name: 'x-api-key' },
        queryKey: { type: 'apiKey', in: 'query', name: 'api_key' },
        oauth: { type: 'oauth2', flows: {} },
      },
    },
    paths: {
      '/pets': {
        get: { operationId: 'listPets', security: [{ bearerAuth: [] }], responses: {} },
        post: {
          operationId: 'createPet',
          requestBody: {
            required: true,
            content: {
              'application/json': {
                schema: {
                  type: 'object',
                  properties: { name: { type: 'string' } },
                  required: ['name'],
                },
              },
            },
          },
          security: [{ headerKey: [] }],
          responses: {},
        },
      },
      '/pets/{id}': {
        get: {
          operationId: 'getPet',
          parameters: [
            { name: 'id', in: 'path', required: true, schema: { type: 'string' } },
            { name: 'verbose', in: 'query', schema: { type: 'boolean' } },
          ],
          security: [{ basicAuth: [] }],
          responses: {},
        },
      },
      '/oauth': {
        get: { operationId: 'oauthCall', security: [{ oauth: [] }], responses: {} },
      },
      '/query-key': {
        get: { operationId: 'queryKeyCall', security: [{ queryKey: [] }], responses: {} },
      },
      '/collide one': { get: { operationId: 'same id', responses: {} } },
      '/collide/two': { get: { operationId: 'same_id', responses: {} } },
      ...(other
        ? {
            '/remote': {
              get: { operationId: 'remoteCall', servers: [{ url: other }], responses: {} },
            },
          }
        : {}),
    },
  };
}

describe('OpenAPI connections', () => {
  test('one tool per operation, qualified and collision-suffixed', async () => {
    const server = startApiServer();
    const tools = await mountConnections([
      defineOpenApiConnection({ name: 'pets', spec: buildSpec(server.base) }),
    ]);
    expect(tools.map((tool) => tool.name).sort()).toEqual([
      'pets__createPet',
      'pets__getPet',
      'pets__listPets',
      'pets__oauthCall',
      'pets__queryKeyCall',
      'pets__same_id',
      'pets__same_id_2',
    ]);
  });

  test('path and query parameters are substituted and a bearer token is placed in the header', async () => {
    const server = startApiServer();
    const tools = await mountConnections([
      defineOpenApiConnection({
        name: 'pets',
        spec: buildSpec(server.base),
        token: () => 'tok-123',
      }),
    ]);
    const result = await callTool(tools, 'pets__listPets', {});
    expect(result).toMatchObject({ ok: true, path: '/api/pets' });
    expect(server.requests[0]?.headers.get('authorization')).toBe('Bearer tok-123');

    await callTool(tools, 'pets__getPet', { id: '42', verbose: true });
    const request = server.requests[1];
    expect(request?.url.pathname).toBe('/api/pets/42');
    expect(request?.url.searchParams.get('verbose')).toBe('true');
  });

  test('apiKey, basic and oauth2 placements resolve to header, basic and bearer', async () => {
    const server = startApiServer();
    const tools = await mountConnections([
      defineOpenApiConnection({
        name: 'pets',
        spec: buildSpec(server.base),
        token: () => 'user:pass',
      }),
    ]);
    await callTool(tools, 'pets__createPet', { name: 'Rex', body: { name: 'Rex' } });
    const create = server.requests.at(-1);
    expect(create?.headers.get('x-api-key')).toBe('user:pass');
    expect(create?.body).toBe(JSON.stringify({ name: 'Rex' }));

    await callTool(tools, 'pets__getPet', { id: '7' });
    expect(server.requests.at(-1)?.headers.get('authorization')).toBe(
      `Basic ${btoa('user:pass')}`,
    );

    await callTool(tools, 'pets__oauthCall', {});
    expect(server.requests.at(-1)?.headers.get('authorization')).toBe('Bearer user:pass');

    await callTool(tools, 'pets__queryKeyCall', {});
    expect(server.requests.at(-1)?.url.searchParams.get('api_key')).toBe('user:pass');
  });

  test('the token never appears in the tool result or the resolved URL', async () => {
    const server = startApiServer();
    const token = 'sekret-token-value';
    const tools = await mountConnections([
      defineOpenApiConnection({
        name: 'pets',
        spec: buildSpec(server.base),
        token: () => token,
      }),
    ]);
    const result = await callTool(tools, 'pets__listPets', {});
    expect(server.requests[0]?.url.toString()).not.toContain(token);
    expect(server.requests[0]?.headers.get('authorization')).toBe(`Bearer ${token}`);
    expect(JSON.stringify(result)).not.toContain(token);
  });

  test('an operation server on another host is refused unless the host is allowed', async () => {
    const main = startApiServer();
    const other = startApiServer();
    const spec = buildSpec(main.base, other.base);

    const refused = await mountConnections([defineOpenApiConnection({ name: 'pets', spec })]);
    const remote = refused.find((tool) => tool.name === 'pets__remoteCall');
    if (!remote) throw new Error('remoteCall was not mounted');
    await expect(callRaw(remote, {})).rejects.toBeInstanceOf(ConnectionUrlError);

    const allowed = await mountConnections([
      defineOpenApiConnection({ name: 'pets', spec, allowHosts: [other.host] }),
    ]);
    const permitted = allowed.find((tool) => tool.name === 'pets__remoteCall');
    if (!permitted) throw new Error('remoteCall was not mounted');
    const result = await callRaw(permitted, {});
    expect(result).toMatchObject({ ok: true, path: '/remote' });
  });

  test('a non-http(s) base URL is refused at definition', () => {
    expect(() =>
      defineOpenApiConnection({
        name: 'bad',
        spec: { openapi: '3.1.0', paths: {} },
        baseUrl: 'file:///etc/hosts',
      }),
    ).toThrow(ConnectionUrlError);
  });

  test('a 403 propagates unchanged from an OpenAPI operation', async () => {
    let issued = 0;
    const forbidden = Bun.serve({
      port: 0,
      fetch: () =>
        new Response(JSON.stringify({ error: 'forbidden' }), {
          status: 403,
          headers: { 'content-type': 'application/json' },
        }),
    });
    servers.push({ stop: () => forbidden.stop(true) });
    const tools = await mountConnections([
      defineOpenApiConnection({
        name: 'pets',
        spec: {
          openapi: '3.1.0',
          paths: { '/x': { get: { operationId: 'x', security: [{ b: [] }] } } },
          components: { securitySchemes: { b: { type: 'http', scheme: 'bearer' } } },
        },
        baseUrl: `http://127.0.0.1:${forbidden.port}`,
        token: () => {
          issued += 1;
          return 'tok';
        },
      }),
    ]);
    const operationTool = tools.find((tool) => tool.name === 'pets__x');
    if (!operationTool) throw new Error('x was not mounted');
    const failure = await callRaw(operationTool, {}).catch((error: unknown) => error);
    expect(failure).toBeInstanceOf(ConnectionRequestError);
    expect((failure as ConnectionRequestError).status).toBe(403);
    expect(issued).toBe(1);
  });

  test('a hung spec URL is aborted by the timeout and surfaces a typed error', async () => {
    const hung = Bun.serve({
      port: 0,
      fetch: async () => {
        await Bun.sleep(10_000);
        return new Response('{}', { headers: { 'content-type': 'application/json' } });
      },
    });
    servers.push({ stop: () => hung.stop(true) });
    const failure = await mountConnections([
      defineOpenApiConnection({
        name: 'hung-spec',
        spec: `http://127.0.0.1:${hung.port}/openapi.json`,
        timeoutMs: 50,
      }),
    ]).catch((error: unknown) => error);
    expect(failure).toBeInstanceOf(ConnectionTimeoutError);
  });

  test('an oversized OpenAPI response body is refused', async () => {
    const big = Bun.serve({
      port: 0,
      fetch: () =>
        new Response(JSON.stringify({ ok: true, blob: 'x'.repeat(4096) }), {
          headers: { 'content-type': 'application/json' },
        }),
    });
    servers.push({ stop: () => big.stop(true) });
    const tools = await mountConnections([
      defineOpenApiConnection({
        name: 'oversized',
        spec: { openapi: '3.1.0', paths: { '/x': { get: { operationId: 'x' } } } },
        baseUrl: `http://127.0.0.1:${big.port}`,
        maxResponseBytes: 64,
      }),
    ]);
    const operationTool = tools.find((tool) => tool.name === 'oversized__x');
    if (!operationTool) throw new Error('x was not mounted');
    const failure = await callRaw(operationTool, {}).catch((error: unknown) => error);
    expect(failure).toBeInstanceOf(ConnectionResponseTooLargeError);
  });
});
