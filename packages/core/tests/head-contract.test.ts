import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { z } from 'zod';
import { createClient, createHttpClient, createUrlBuilder } from '../src';
import { defineContract, type EndpointDef } from '../src/contract';
import { createHandler, implement, serveFile } from '../src/server';
import { generateOpenApiDocument } from '../src/server/openapi';

const filePath = join(tmpdir(), `stitchkit-head-contract-${process.pid}.txt`);
const missingPath = join(tmpdir(), `stitchkit-head-contract-missing-${process.pid}.txt`);
const AssetParams = z.object({ name: z.string() });
const TreeParams = z.object({ filePath: z.string() });

const assets = defineContract(
  { prefix: 'assets' },
  {
    get: {
      method: 'GET',
      path: '/:name',
      desc: 'Get asset',
      params: AssetParams,
      rawResponse: true,
      contentType: 'text/plain',
    },
    head: {
      method: 'HEAD',
      path: '/:name',
      desc: 'Inspect asset',
      params: AssetParams,
      rawResponse: true,
      contentType: 'text/plain',
    },
    mistakenBody: {
      method: 'HEAD',
      path: '/mistaken/body',
      desc: 'Return mistaken body',
      rawResponse: true,
    },
    headOnly: {
      method: 'HEAD',
      path: '/only/head',
      desc: 'HEAD only',
      rawResponse: true,
    },
    getOnly: {
      method: 'GET',
      path: '/only/get',
      desc: 'GET only',
      rawResponse: true,
    },
    treeHead: {
      method: 'HEAD',
      path: '/tree/*filePath',
      desc: 'Inspect a nested asset',
      params: TreeParams,
      rawResponse: true,
    },
  },
);

const lifecycle: string[] = [];
const service = implement(assets, {
  get: () => new Response('GET body', { headers: { 'x-operation': 'get' } }),
  head: ({ req, params }) =>
    serveFile(req, { path: params.name === 'missing' ? missingPath : filePath }),
  mistakenBody: () =>
    new Response('must disappear', {
      status: 206,
      headers: { 'content-range': 'bytes 0-3/10', 'x-operation': 'head' },
    }),
  headOnly: () => new Response(null, { headers: { 'x-operation': 'head-only' } }),
  getOnly: () => new Response('get-only'),
  treeHead: ({ params, req }) =>
    new Response(null, {
      headers: {
        'x-file-path': params.filePath,
        'x-download': new URL(req.url).searchParams.get('download') ?? 'unset',
      },
    }),
});
const handler = createHandler({
  services: [service],
  cors: { origin: 'https://app.example.com' },
  hooks: {
    beforeHandle: (_ctx, endpoint) => {
      lifecycle.push(endpoint.key);
    },
  },
});

beforeAll(async () => {
  await Bun.write(filePath, 'abcdefghij');
});
afterAll(async () => {
  await rm(filePath, { force: true });
});

describe('contract HEAD endpoints', () => {
  test('HEAD and GET coexist without implicit aliases', async () => {
    const head = await handler(
      new Request('http://local/assets/file.txt', { method: 'HEAD' }),
    );
    expect(head.status).toBe(200);
    expect(head.headers.get('content-length')).toBe('10');
    expect(head.headers.get('access-control-allow-origin')).toBe('https://app.example.com');
    expect(await head.text()).toBe('');

    const get = await handler(new Request('http://local/assets/file.txt'));
    expect(await get.text()).toBe('GET body');
    expect(lifecycle).toEqual(['head', 'get']);
  });

  test('named params, terminal wildcard and the raw query remain available', async () => {
    const response = await handler(
      new Request('http://local/assets/tree/avatars/users/a.webp?download=1', {
        method: 'HEAD',
      }),
    );
    expect(response.status).toBe(200);
    expect(response.headers.get('x-file-path')).toBe('avatars/users/a.webp');
    expect(response.headers.get('x-download')).toBe('1');
    expect(await response.text()).toBe('');
  });

  test('strips an accidental handler body while preserving status and headers', async () => {
    const response = await handler(
      new Request('http://local/assets/mistaken/body', { method: 'HEAD' }),
    );
    expect(response.status).toBe(206);
    expect(response.headers.get('content-range')).toBe('bytes 0-3/10');
    expect(response.headers.get('x-operation')).toBe('head');
    expect(await response.text()).toBe('');
  });

  test('serveFile preserves conditional/range statuses and always returns no body', async () => {
    const initial = await handler(
      new Request('http://local/assets/file.txt', { method: 'HEAD' }),
    );
    const etag = initial.headers.get('etag');
    expect(etag).toBeTruthy();

    const fresh = await handler(
      new Request('http://local/assets/file.txt', {
        method: 'HEAD',
        headers: { 'if-none-match': etag ?? '' },
      }),
    );
    expect(fresh.status).toBe(304);
    expect(await fresh.text()).toBe('');

    const range = await handler(
      new Request('http://local/assets/file.txt', {
        method: 'HEAD',
        headers: { range: 'bytes=0-3' },
      }),
    );
    expect(range.status).toBe(206);
    expect(range.headers.get('content-range')).toBe('bytes 0-3/10');
    expect(await range.text()).toBe('');

    const unsatisfiable = await handler(
      new Request('http://local/assets/file.txt', {
        method: 'HEAD',
        headers: { range: 'bytes=20-30' },
      }),
    );
    expect(unsatisfiable.status).toBe(416);
    expect(await unsatisfiable.text()).toBe('');

    const missing = await handler(
      new Request('http://local/assets/missing', { method: 'HEAD' }),
    );
    expect(missing.status).toBe(404);
    expect(await missing.text()).toBe('');
  });

  test('405 Allow reflects only explicitly declared methods', async () => {
    const post = await handler(
      new Request('http://local/assets/file.txt', { method: 'POST' }),
    );
    expect(post.status).toBe(405);
    expect(post.headers.get('allow')).toBe('GET, HEAD');

    const getHeadOnly = await handler(new Request('http://local/assets/only/head'));
    expect(getHeadOnly.status).toBe(405);
    expect(getHeadOnly.headers.get('allow')).toBe('HEAD');

    const headGetOnly = await handler(
      new Request('http://local/assets/only/get', { method: 'HEAD' }),
    );
    expect(headGetOnly.status).toBe(405);
    expect(headGetOnly.headers.get('allow')).toBe('GET');
  });

  test('typed client and URL builder expose the HEAD operation', async () => {
    const server = Bun.serve({ port: 0, fetch: handler });
    const baseUrl = `http://localhost:${server.port}`;
    try {
      const http = createHttpClient({ baseUrl });
      const client = createClient(assets, http);
      const urls = createUrlBuilder(assets, http);
      expect(urls.head({ name: 'file.txt' })).toBe(`${baseUrl}/assets/file.txt`);
      const response = await client.head({ name: 'file.txt' });
      expect(response).toBeInstanceOf(Response);
      expect(response.headers.get('content-length')).toBe('10');
      expect(await response.text()).toBe('');
    } finally {
      server.stop(true);
    }
  });

  test('OpenAPI publishes HEAD without a response body schema', () => {
    const document = generateOpenApiDocument({
      services: [service],
      info: { title: 'Assets', version: '1.0.0' },
    });
    const operation = document.paths['/assets/{name}']?.head;
    expect(operation).toBeDefined();
    const serialized = JSON.stringify(operation);
    expect(serialized).toContain('"200":{"description":"Headers only"}');
    expect(serialized).not.toContain('application/octet-stream');
    expect(serialized).not.toContain('"format":"binary"');
  });
});

function _typeChecks() {
  // @ts-expect-error HEAD must be rawResponse and cannot publish typed output
  const output: EndpointDef = {
    method: 'HEAD',
    path: '/',
    desc: 'Invalid',
    output: z.object({}),
  };
  // @ts-expect-error HEAD cannot accept request input
  const input: EndpointDef = {
    method: 'HEAD',
    path: '/',
    desc: 'Invalid',
    rawResponse: true,
    input: z.object({ q: z.string() }),
  };
  void output;
  void input;
}
void _typeChecks;
