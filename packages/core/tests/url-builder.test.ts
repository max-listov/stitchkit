import { afterAll, describe, expect, test } from 'bun:test';
import { z } from 'zod';
import {
  type ContractClientConfig,
  createClient,
  createUrlBuilder,
  createUrlBuilders,
} from '../src/browser/client';
import { createHttpClient } from '../src/browser/http';
import { defineContract } from '../src/contract';

const UrlEchoSchema = z.object({ url: z.string() });
const LinkParamsSchema = z.object({ fileId: z.string(), '*': z.string() });
const LinkQuerySchema = z.object({
  thumbnail: z.boolean().optional(),
  page: z.number().optional(),
  tags: z.array(z.string()).optional(),
});

const media = defineContract(
  { prefix: 'media' },
  {
    root: {
      method: 'GET',
      path: '/',
      desc: 'Media root',
      output: UrlEchoSchema,
    },
    file: {
      method: 'GET',
      path: '/:fileId/*',
      desc: 'Media file',
      params: LinkParamsSchema,
      input: LinkQuerySchema,
      output: UrlEchoSchema,
    },
    download: {
      method: 'GET',
      path: '/download/:fileId',
      desc: 'Raw download',
      params: z.object({ fileId: z.string() }),
      rawResponse: true,
      contentType: 'application/octet-stream',
    },
    mutate: {
      method: 'POST',
      path: '/',
      desc: 'Mutate media',
      input: z.object({ name: z.string() }),
      output: z.object({ ok: z.boolean() }),
    },
    toolOnly: {
      method: 'GET',
      path: '/tool',
      desc: 'Tool only',
      expose: ['MCP'],
      output: z.object({ ok: z.boolean() }),
    },
  },
);

const echoServer = Bun.serve({
  port: 0,
  fetch(req) {
    const url = new URL(req.url);
    return Response.json({ url: `${url.pathname}${url.search}` });
  },
});
const baseUrl = `http://localhost:${echoServer.port}`;
const http = createHttpClient({ baseUrl });
const scope: ContractClientConfig<'tenantId'> = {
  stripPrefixKeys: ['tenantId'],
  pathPrefix: ({ tenantId }: { tenantId: string }) => `tenants/${tenantId}`,
};

afterAll(() => echoServer.stop(true));

describe('contract URL builders', () => {
  const urls = createUrlBuilder(media, http, scope);
  const args = {
    tenantId: 't1',
    fileId: 'folder one',
    '*': 'leaf#two/ü',
    thumbnail: true,
    page: 2,
    tags: ['a', 'b'],
  };

  test('builds an absolute encoded URL without issuing a request', () => {
    expect(urls.file(args)).toBe(
      `${baseUrl}/tenants/t1/media/folder%20one/leaf%23two/%C3%BC?thumbnail=true&page=2&tags=a&tags=b`,
    );
  });

  test('matches the URL observed from both executing client transports', async () => {
    const expected = new URL(urls.file(args));
    const expectedPath = `${expected.pathname}${expected.search}`;

    const kyClient = createClient(media, http, scope);
    const fetchClient = createClient(media, { baseUrl }, scope);
    expect((await kyClient.file(args)).url).toBe(expectedPath);
    expect((await fetchClient.file(args)).url).toBe(expectedPath);
  });

  test('supports batch builders, raw GET links and a relative base URL', () => {
    const registry = createUrlBuilders({ media }, { baseUrl: '/api/' }, scope);
    expect(registry.media.download({ tenantId: 't1', fileId: 'a b' })).toBe(
      '/api/tenants/t1/media/download/a%20b',
    );
  });

  test('supports zero-arg endpoints and an empty wildcard remainder', () => {
    const plain = createUrlBuilder(media, { baseUrl: '' });
    expect(plain.root()).toBe('/media');
    expect(urls.file({ tenantId: 't1', fileId: 'file', '*': '', tags: [], page: 0 })).toBe(
      `${baseUrl}/tenants/t1/media/file?page=0`,
    );
  });

  test('fails first on missing params and nested query values', () => {
    const loose: { file(args: Record<string, unknown>): string } = urls;
    expect(() => loose.file({ tenantId: 't1', '*': '' })).toThrow(
      'Missing path param: fileId',
    );
    expect(() =>
      loose.file({ tenantId: 't1', fileId: 'f', '*': '', filter: { active: true } }),
    ).toThrow('input field "filter" is a nested object');
  });
});

function _typeChecks() {
  const urls = createUrlBuilder(media, http, {
    pathPrefix: ({ tenantId }) => `tenants/${tenantId}`,
    stripPrefixKeys: ['tenantId'],
  });
  const url: string = urls.file({
    tenantId: 't1',
    fileId: 'f',
    '*': 'a/b',
    thumbnail: true,
  });
  void url;
  const rawUrl: string = urls.download({ tenantId: 't1', fileId: 'f' });
  void rawUrl;
  // @ts-expect-error scoped keys remain required
  urls.file({ fileId: 'f', '*': '' });
  // @ts-expect-error body operations are not linkable
  void urls.mutate;
  // @ts-expect-error non-HTTP endpoints are not linkable
  void urls.toolOnly;

  const registry = createUrlBuilders({ media }, http, {
    stripPrefixKeys: ['tenantId'],
    pathPrefix: ({ tenantId }) => `tenants/${tenantId}`,
  });
  void registry.media.file({ tenantId: 't1', fileId: 'f', '*': '' });
}
void _typeChecks;
