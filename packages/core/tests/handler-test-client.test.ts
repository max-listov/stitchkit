import { describe, expect, test } from 'bun:test';
import { z } from 'zod';
import { ApiError } from '../src/browser/http';
import { defineContract, notFound, unauthorized } from '../src/contract';
import { createHandler } from '../src/server/create';
import { implement } from '../src/server/implement';
import { createHandlerTestClient, createHandlerTestClients } from '../src/testing';

const EchoInputSchema = z.object({ value: z.string() });
const EchoOutputSchema = z.object({ value: z.string() });
const NullableOutputSchema = z.string().nullable();
const RequestDetailsOutputSchema = z.object({ cookie: z.string(), traceId: z.string() });
const UploadInputSchema = z.object({ title: z.string() });
const UploadOutputSchema = z.object({ filename: z.string(), title: z.string() });

const contract = defineContract(
  { prefix: 'testing' },
  {
    echo: {
      method: 'POST',
      path: '/echo',
      desc: 'Echo one value',
      input: EchoInputSchema,
      output: EchoOutputSchema,
    },
    nullable: {
      method: 'GET',
      path: '/nullable',
      desc: 'Return a nullable value',
      output: NullableOutputSchema,
    },
    empty: {
      method: 'POST',
      path: '/empty',
      desc: 'Return no content',
    },
    requestDetails: {
      method: 'GET',
      path: '/request-details',
      desc: 'Read request headers',
      output: RequestDetailsOutputSchema,
      responseMeta: {},
    },
    fail: {
      method: 'GET',
      path: '/fail',
      desc: 'Return a typed application error',
      output: EchoOutputSchema,
    },
    raw: {
      method: 'GET',
      path: '/raw',
      desc: 'Return a raw response',
      rawResponse: true,
      contentType: 'text/plain',
    },
    upload: {
      method: 'POST',
      path: '/upload',
      desc: 'Upload one file',
      input: UploadInputSchema,
      output: UploadOutputSchema,
      multipart: { files: { file: {} } },
    },
  },
);

const service = implement(contract, {
  echo: ({ input }) => input,
  nullable: () => null,
  empty: () => undefined,
  requestDetails: ({ req }) => ({
    cookie: req.headers.get('cookie') ?? '',
    traceId: req.headers.get('x-request-id') ?? '',
  }),
  fail: () => notFound('Missing test resource'),
  raw: () => new Response('raw-body', { headers: { 'x-raw': 'yes' } }),
  upload: ({ input, files }) => ({ filename: files.file.name, title: input.title }),
});

const handler = createHandler({
  groups: [{ pathPrefix: 'api', services: [service] }],
});

function createApi() {
  return createHandlerTestClient({
    contract,
    handler,
    pathPrefix: 'api',
    client: {
      headers: {
        cookie: 'session=test',
        'x-request-id': 'trace-test-client',
      },
    },
  });
}

describe('createHandlerTestClient', () => {
  test('runs JSON, nullable, empty, headers and cookies through the real handler', async () => {
    const api = createApi();

    expect(await api.echo({ value: 'hello' })).toEqual({ value: 'hello' });
    expect(await api.nullable()).toBeNull();
    expect(await api.empty()).toBeUndefined();
    expect(await api.requestDetails()).toEqual({
      cookie: 'session=test',
      traceId: 'trace-test-client',
    });
  });

  test('preserves ApiError details and the handler correlation id', async () => {
    const api = createApi();
    try {
      await api.fail();
      throw new Error('Expected ApiError');
    } catch (error) {
      expect(ApiError.is(error)).toBe(true);
      if (!ApiError.is(error)) throw error;
      expect(error.status).toBe(404);
      expect(error.code).toBe('NOT_FOUND');
      expect(error.message).toBe('Missing test resource');
      expect(error.traceId).toBe('trace-test-client');
    }
  });

  test('preserves raw responses and buffered multipart files', async () => {
    const api = createApi();
    const raw = await api.raw();
    expect(raw.headers.get('x-raw')).toBe('yes');
    expect(await raw.text()).toBe('raw-body');

    expect(
      await api.upload({
        title: 'document',
        file: new File(['contents'], 'document.txt', { type: 'text/plain' }),
      }),
    ).toEqual({ filename: 'document.txt', title: 'document' });
  });

  test('honours cancellation before dispatching into the handler', async () => {
    const api = createApi();
    const controller = new AbortController();
    controller.abort();

    await expect(
      api.echo.withOptions({ value: 'cancelled' }, { signal: controller.signal }),
    ).rejects.toMatchObject({ code: 'REQUEST_ABORTED', status: 0 });
  });

  test('runs authorization and lifecycle hooks through the real handler', async () => {
    const lifecycle = { before: 0, after: 0 };
    const guardedHandler = createHandler({
      groups: [{ pathPrefix: 'api', services: [service] }],
      hooks: {
        beforeHandle: ({ req }) => {
          lifecycle.before += 1;
          if (!req) throw new Error('HTTP lifecycle requires a Request');
          if (req.headers.get('authorization') !== 'Bearer test') {
            throw unauthorized('Missing test authorization');
          }
        },
        afterHandle: (_context, result) => {
          lifecycle.after += 1;
          return result;
        },
      },
    });
    const authorizedApi = createHandlerTestClient({
      contract,
      handler: guardedHandler,
      pathPrefix: 'api',
      client: { headers: { authorization: 'Bearer test' } },
    });

    expect(await authorizedApi.echo({ value: 'authorized' })).toEqual({
      value: 'authorized',
    });
    expect(lifecycle).toEqual({ before: 1, after: 1 });

    const anonymousApi = createHandlerTestClient({
      contract,
      handler: guardedHandler,
      pathPrefix: 'api',
    });
    await expect(anonymousApi.echo({ value: 'anonymous' })).rejects.toMatchObject({
      code: 'UNAUTHORIZED',
      status: 401,
    });
    expect(lifecycle).toEqual({ before: 2, after: 1 });
  });

  test('builds an exact client registry from the same in-process transport', async () => {
    const clients = createHandlerTestClients({
      contracts: { primary: contract },
      handler,
      pathPrefix: 'api',
    });

    expect(await clients.primary.echo({ value: 'registry' })).toEqual({ value: 'registry' });
  });

  test('keeps scoped prefix keys in the generated client type and URL', async () => {
    const scopedHandler = createHandler({
      groups: [{ pathPrefix: 'api/tenants/acme', services: [service] }],
    });
    const api = createHandlerTestClient({
      contract,
      handler: scopedHandler,
      pathPrefix: 'api',
      contractConfig: {
        pathPrefix: ({ tenantId }) => `tenants/${tenantId}`,
        stripPrefixKeys: ['tenantId'],
      },
    });

    expect(await api.echo({ tenantId: 'acme', value: 'scoped' })).toEqual({ value: 'scoped' });
  });

  test('matches the observable result of a real HTTP server', async () => {
    const server = Bun.serve({ port: 0, fetch: handler });
    try {
      const inProcess = createApi();
      const overHttp = createHandlerTestClient({
        contract,
        handler: (request) => fetch(request),
        origin: `http://localhost:${server.port}`,
        pathPrefix: 'api',
      });

      expect(await inProcess.echo({ value: 'parity' })).toEqual(
        await overHttp.echo({ value: 'parity' }),
      );
    } finally {
      server.stop(true);
    }
  });
});
