import { createMutation, createQuery } from 'react-query-kit';
import { z } from 'zod';
import { createClient, createClients, createScopedClients } from '../src/browser/client';
import { defineContract } from '../src/contract';

const ResultSchema = z.object({ value: z.string() });
const InputSchema = z.object({ value: z.string() });
const SearchSchema = z.object({ query: z.string() });

const publicContract = defineContract(
  { prefix: 'public', scope: 'public' },
  {
    ping: {
      method: 'POST',
      path: '/ping',
      desc: 'Ping',
      output: ResultSchema,
    },
    create: {
      method: 'POST',
      path: '/',
      desc: 'Create',
      input: InputSchema,
      output: ResultSchema,
    },
    search: {
      method: 'GET',
      path: '/',
      desc: 'Search',
      input: SearchSchema,
      output: ResultSchema,
    },
    upload: {
      method: 'POST',
      path: '/upload',
      desc: 'Upload',
      multipart: { files: { file: {} } },
      output: ResultSchema,
    },
    download: {
      method: 'GET',
      path: '/download',
      desc: 'Download',
      rawResponse: true,
    },
  },
);

const privateContract = defineContract(
  { prefix: 'private', scope: 'private' },
  {
    update: {
      method: 'PATCH',
      path: '/',
      desc: 'Update',
      input: InputSchema,
      output: ResultSchema,
    },
  },
);

function compileReactQueryKitCompatibility(): void {
  const signal = new AbortController().signal;
  const plain = createClient(publicContract, { baseUrl: 'https://example.com' });

  createMutation({ mutationFn: plain.create });
  createMutation({ mutationFn: plain.ping });
  createQuery({ queryKey: ['search'], fetcher: plain.search });

  void plain.create.withOptions({ value: 'value' }, { signal });
  void plain.ping.withOptions({ signal });
  const uploadResult: Promise<{ value: string }> = plain.upload.withOptions(
    { file: new File(['data'], 'data.txt') },
    { signal },
  );
  const downloadResult: Promise<Response> = plain.download.withOptions({ signal });
  void uploadResult;
  void downloadResult;

  // @ts-expect-error ordinary endpoint calls do not accept transport options
  void plain.create({ value: 'value' }, { signal });
  // @ts-expect-error no-argument endpoint options use withOptions
  void plain.ping({ signal });

  const batch = createClients({ public: publicContract }, { baseUrl: 'https://example.com' });
  createMutation({ mutationFn: batch.public.create });
  void batch.public.create.withOptions({ value: 'value' }, { signal });

  const scoped = createClient(
    publicContract,
    { baseUrl: 'https://example.com' },
    {
      pathPrefix: ({ tenantId }) => `tenants/${tenantId}`,
      stripPrefixKeys: ['tenantId'],
    },
  );
  createMutation({ mutationFn: scoped.create });
  void scoped.create.withOptions({ tenantId: 'tenant', value: 'value' }, { signal });
  const scopedUploadResult: Promise<{ value: string }> = scoped.upload.withOptions(
    { tenantId: 'tenant', file: new File(['data'], 'data.txt') },
    { signal },
  );
  const scopedDownloadResult: Promise<Response> = scoped.download.withOptions(
    { tenantId: 'tenant' },
    { signal },
  );
  void scopedUploadResult;
  void scopedDownloadResult;

  const routed = createScopedClients(
    { api: [publicContract, privateContract] },
    { baseUrl: 'https://example.com' },
    {
      public: {},
      private: {
        pathPrefix: ({ tenantId }) => `tenants/${tenantId}`,
        stripPrefixKeys: ['tenantId'],
      },
    },
  );
  createMutation({ mutationFn: routed.api.create });
  createMutation({ mutationFn: routed.api.update });
  void routed.api.create.withOptions({ value: 'value' }, { signal });
  void routed.api.update.withOptions({ tenantId: 'tenant', value: 'value' }, { signal });
}

void compileReactQueryKitCompatibility;
