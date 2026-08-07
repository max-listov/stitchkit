import { describe, expect, test } from 'bun:test';
import { z } from 'zod';
import { createScopedUrlBuilders, type ScopeClientConfigs } from '../src/browser/client';
import { createContractFactory } from '../src/contract';

const { defineContract } = createContractFactory<'public' | 'tenant'>();

const AssetParams = z.object({ assetId: z.string() });
const FileParams = z.object({ fileId: z.string() });
const FileQuery = z.object({ download: z.boolean().optional() });

const publicAssets = defineContract(
  { prefix: 'assets', scope: 'public' },
  {
    asset: {
      method: 'GET',
      path: '/:assetId',
      desc: 'Public asset',
      params: AssetParams,
      rawResponse: true,
      contentType: 'application/octet-stream',
    },
  },
);

const tenantFiles = defineContract(
  { prefix: 'files', scope: 'tenant' },
  {
    file: {
      method: 'GET',
      path: '/:fileId',
      desc: 'Tenant file',
      params: FileParams,
      input: FileQuery,
      rawResponse: true,
      contentType: 'application/octet-stream',
    },
    inspect: {
      method: 'HEAD',
      path: '/:fileId',
      desc: 'Inspect tenant file',
      params: FileParams,
      rawResponse: true,
      contentType: 'application/octet-stream',
    },
    replace: {
      method: 'POST',
      path: '/:fileId',
      desc: 'Replace tenant file',
      params: FileParams,
      input: z.object({ name: z.string() }),
      output: z.object({ ok: z.boolean() }),
    },
    upload: {
      method: 'POST',
      path: '/:fileId/upload',
      desc: 'Upload tenant file',
      params: FileParams,
      input: z.object({ caption: z.string().optional() }),
      output: z.object({ ok: z.boolean() }),
      multipart: 'file',
    },
    remove: {
      method: 'DELETE',
      path: '/:fileId',
      desc: 'Remove tenant file',
      params: FileParams,
      output: z.object({ ok: z.boolean() }),
    },
  },
);

const tenantMetadata = defineContract(
  { prefix: 'files', scope: 'tenant' },
  {
    metadata: {
      method: 'GET',
      path: '/:fileId/metadata',
      desc: 'Tenant file metadata',
      params: FileParams,
      output: z.object({ ok: z.boolean() }),
    },
  },
);

const source = { baseUrl: '/api/' };
function defineScopeConfigs<const Configs extends ScopeClientConfigs<'public' | 'tenant'>>(
  configs: Configs,
): Configs {
  return configs;
}

const scopeConfigs = defineScopeConfigs({
  public: {},
  tenant: {
    stripPrefixKeys: ['tenantId'],
    pathPrefix: ({ tenantId }) => `tenants/${tenantId}`,
  },
});

describe('createScopedUrlBuilders', () => {
  test('routes by literal scope and composes namespaces', () => {
    const urls = createScopedUrlBuilders(
      { assets: publicAssets, media: [tenantFiles, tenantMetadata] },
      source,
      scopeConfigs,
    );

    expect(urls.assets.asset({ assetId: 'a b' })).toBe('/api/assets/a%20b');
    expect(urls.media.file({ tenantId: 't1', fileId: 'a b', download: true })).toBe(
      '/api/tenants/t1/files/a%20b?download=true',
    );
    expect(urls.media.inspect({ tenantId: 't1', fileId: 'a b' })).toBe(
      '/api/tenants/t1/files/a%20b',
    );
    expect(urls.media.metadata({ tenantId: 't1', fileId: 'a b' })).toBe(
      '/api/tenants/t1/files/a%20b/metadata',
    );
  });

  test('builds body and delete URLs from URL-bound arguments only', () => {
    const urls = createScopedUrlBuilders({ files: tenantFiles }, source, {
      tenant: scopeConfigs.tenant,
    });
    expect(urls.files.replace({ tenantId: 't1', fileId: 'f' })).toBe(
      '/api/tenants/t1/files/f',
    );
    expect(urls.files.remove({ tenantId: 't1', fileId: 'f' })).toBe('/api/tenants/t1/files/f');
    expect(urls.files.upload({ tenantId: 't1', fileId: 'f' })).toBe(
      '/api/tenants/t1/files/f/upload',
    );
  });

  test('fails first on a missing scope config or duplicate method', () => {
    expect(() =>
      createScopedUrlBuilders(
        { files: tenantFiles },
        source,
        // @ts-expect-error tenant config is required
        {},
      ),
    ).toThrow('Missing URL builder config for scope: tenant');

    expect(() =>
      createScopedUrlBuilders({ files: [tenantFiles, tenantFiles] }, source, {
        tenant: scopeConfigs.tenant,
      }),
    ).toThrow('URL builder namespace "files" has duplicate method: file');
  });
});

function compileTimeChecks(): void {
  const urls = createScopedUrlBuilders(
    { assets: publicAssets, media: [tenantFiles, tenantMetadata] },
    source,
    scopeConfigs,
  );
  void urls.assets.asset({ assetId: 'public' });
  void urls.media.file({ tenantId: 't1', fileId: 'f', download: true });
  void urls.media.replace({ tenantId: 't1', fileId: 'f' });
  void urls.media.upload({ tenantId: 't1', fileId: 'f' });
  void urls.media.inspect({ tenantId: 't1', fileId: 'f' });
  // @ts-expect-error tenant prefix key is required only on tenant methods
  void urls.media.file({ fileId: 'f' });
  // @ts-expect-error public methods do not accept tenant prefix keys
  void urls.assets.asset({ tenantId: 't1', assetId: 'public' });
  // @ts-expect-error body fields are not URL-bound
  void urls.media.replace({ tenantId: 't1', fileId: 'f', name: 'body' });
  // @ts-expect-error multipart files are not URL-bound
  void urls.media.upload({ tenantId: 't1', fileId: 'f', file: new Blob() });
}
void compileTimeChecks;
