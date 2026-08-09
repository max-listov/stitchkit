import { afterAll, describe, expect, test } from 'bun:test';
import { z } from 'zod';
import { createClient } from '../src/browser/client';
import { ApiError, createHttpClient } from '../src/browser/http';
import { defineContract } from '../src/contract';

const TRACE_ID = 'request-trace-123';

const ErrorProbeOutputSchema = z.object({ ok: z.boolean() });
const errorProbeContract = defineContract(
  { prefix: 'trace-errors' },
  {
    structured: {
      method: 'GET',
      path: '/structured',
      desc: 'Return a structured error',
      output: ErrorProbeOutputSchema,
    },
    fallback: {
      method: 'GET',
      path: '/fallback',
      desc: 'Return an unstructured error',
      output: ErrorProbeOutputSchema,
    },
  },
);

const server = Bun.serve({
  port: 0,
  fetch(request) {
    const path = new URL(request.url).pathname;
    const headers = { 'x-request-id': TRACE_ID };
    if (path.endsWith('/structured')) {
      return Response.json(
        {
          error: {
            code: 'CONFLICT',
            message: 'Duplicate project',
            details: { field: 'name' },
            hint: 'Choose another name',
          },
        },
        { status: 409, headers },
      );
    }
    return new Response('upstream exploded', { status: 502, headers });
  },
});

const baseUrl = `http://127.0.0.1:${server.port}`;

async function captureApiError(promise: Promise<unknown>): Promise<ApiError> {
  try {
    await promise;
  } catch (error) {
    if (ApiError.is(error)) return error;
    throw error;
  }
  throw new Error('Expected the request to reject with ApiError');
}

function expectStructuredError(error: ApiError): void {
  expect(error.code).toBe('CONFLICT');
  expect(error.status).toBe(409);
  expect(error.message).toBe('Duplicate project');
  expect(error.details).toEqual({ field: 'name' });
  expect(error.hint).toBe('Choose another name');
  expect(error.traceId).toBe(TRACE_ID);
}

describe('ApiError response trace correlation', () => {
  test('bare client preserves x-request-id on a structured API error', async () => {
    const observed: Array<{ status: number; body: unknown }> = [];
    const api = createClient(errorProbeContract, {
      baseUrl,
      onError: (status, body) => observed.push({ status, body }),
    });

    const error = await captureApiError(api.structured());

    expectStructuredError(error);
    expect(observed).toHaveLength(1);
    expect(observed[0]?.status).toBe(409);
  });

  test('bare client preserves x-request-id on an unstructured HTTP error', async () => {
    const api = createClient(errorProbeContract, { baseUrl });

    const error = await captureApiError(api.fallback());

    expect(error.code).toBe('HTTP_ERROR');
    expect(error.status).toBe(502);
    expect(error.details).toEqual({ body: { error: 'Bad Gateway' } });
    expect(error.traceId).toBe(TRACE_ID);
  });

  test('Ky-backed client preserves x-request-id on a structured API error', async () => {
    const http = createHttpClient({ baseUrl, retry: { limit: 0 } });
    const events: string[] = [];
    http.subscribe((event) => events.push(event.type));
    const api = createClient(errorProbeContract, http);

    const error = await captureApiError(api.structured());

    expectStructuredError(error);
    expect(events).toEqual([]);
  });

  test('Ky-backed client preserves x-request-id on its HTTPError fallback', async () => {
    const http = createHttpClient({ baseUrl, retry: { limit: 0 } });
    const events: string[] = [];
    http.subscribe((event) => events.push(event.type));
    const api = createClient(errorProbeContract, http);

    const error = await captureApiError(api.fallback());

    expect(error.code).toBe('UNKNOWN_ERROR');
    expect(error.status).toBe(502);
    expect(error.details).toEqual({ message: expect.stringContaining('502') });
    expect(error.traceId).toBe(TRACE_ID);
    expect(events).toEqual(['network_error']);
  });

  test('Ky network errors have no trace id and keep their event semantics', async () => {
    const http = createHttpClient({
      baseUrl: 'http://127.0.0.1:1',
      retry: { limit: 0 },
      timeout: 100,
    });
    const events: string[] = [];
    http.subscribe((event) => events.push(event.type));

    const error = await captureApiError(http.get('/unreachable'));

    expect(error.code).toBe('UNKNOWN_ERROR');
    expect(error.status).toBe(0);
    expect(error.traceId).toBeUndefined();
    expect(events).toEqual(['network_error']);
  });

  test('traceId is an optional public field', () => {
    const withoutTrace = new ApiError('UNKNOWN_ERROR');
    const withTrace = new ApiError('CONFLICT', 409, undefined, undefined, undefined, TRACE_ID);

    expect(withoutTrace.traceId).toBeUndefined();
    expect(withTrace.traceId).toBe(TRACE_ID);
  });

  afterAll(() => server.stop());
});
