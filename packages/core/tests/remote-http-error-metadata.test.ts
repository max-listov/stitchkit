import { expect, test } from 'bun:test';
import { z } from 'zod';
import { createCliInvoker } from '../src/entrypoints/cli';
import { AppError, defineContract } from '../src/entrypoints/contract';
import { ApiError, createClient, createHttpClient } from '../src/entrypoints/index';
import { createHandler, implement } from '../src/entrypoints/node';
import { implementRemote } from '../src/entrypoints/remote';
import { createToolInvoker } from '../src/entrypoints/tools/invoker';

const contract = defineContract(
  { prefix: 'recommendation' },
  {
    fail: {
      method: 'POST',
      path: '/fail',
      desc: 'Refuse a call',
      expose: ['HTTP', 'CLI', 'MCP', 'AGENT'],
      tool: { name: 'recommendation_fail' },
      input: z.object({ status: z.number(), declared: z.boolean().optional() }),
      output: z.object({ ok: z.boolean() }),
    },
  },
);
const service = implement(contract, {
  fail: ({ input }) => {
    throw new AppError('DOMAIN_REFUSED', {
      message: 'Cannot repeat this operation',
      status: input.status,
      details: { message: 'Cannot repeat this operation', marker: 'safe' },
      hint: 'Reconcile destination',
      traceId: 'domain-trace',
      retryable: input.declared,
    });
  },
});
const handler = createHandler({ services: [service], logging: false });
const fetch: typeof globalThis.fetch = Object.assign(
  (input: RequestInfo | URL, init?: RequestInit) => handler(new Request(input, init)),
  { preconnect: globalThis.fetch.preconnect },
);
const http = createHttpClient({ baseUrl: 'http://localhost', fetch, retry: { limit: 0 } });
const remote = implementRemote(contract, http);

test('declared HTTP retryability survives direct and remote CLI and model tool hops', async () => {
  const direct = await createCliInvoker({ name: 'direct', services: [service] });
  const proxy = await createCliInvoker({ name: 'remote', services: [remote] });
  for (const [status, declared, expected] of [
    [502, false, false],
    [409, true, true],
    [502, undefined, true],
    [409, undefined, false],
  ] as const) {
    const args = { status, ...(declared !== undefined && { declared }) };
    for (const cli of [direct, proxy]) {
      expect(await cli.invoke('recommendation_fail', args)).toMatchObject({
        ok: false,
        error: {
          code: 'DOMAIN_REFUSED',
          retryable: expected,
          hint: 'Reconcile destination',
          details: { marker: 'safe' },
        },
      });
    }
    for (const source of ['mcp', 'agent'] as const) {
      const tools = createToolInvoker([remote], {
        transport: source === 'mcp' ? 'MCP' : 'AGENT',
      });
      expect(await tools.invoke('recommendation_fail', args, { source })).toMatchObject({
        ok: false,
        code: 'DOMAIN_REFUSED',
        retryable: expected,
        hint: 'Reconcile destination',
        details: { marker: 'safe' },
      });
    }
  }
});

test('both HTTP client adapters preserve boolean retryability and transport trace', async () => {
  for (const client of [
    createClient(contract, http),
    createClient(contract, { baseUrl: 'http://localhost', fetch }),
  ]) {
    try {
      await client.fail({ status: 502, declared: false });
      throw new Error('Expected refusal');
    } catch (error) {
      expect(ApiError.is(error)).toBe(true);
      if (!ApiError.is(error)) throw error;
      expect(error.retryable).toBe(false);
      expect(error.code).toBe('DOMAIN_REFUSED');
      expect(error.hint).toBe('Reconcile destination');
      expect(error.traceId).toBeDefined();
    }
  }
});

test('HTTP retryability is absent by default and rejects nonboolean wire metadata', async () => {
  expect(new AppError('DEFAULT', { message: 'Default', status: 502 }).toJSON()).toEqual({
    error: { code: 'DEFAULT', message: 'Default' },
  });
  expect(
    new AppError('EXPLICIT', { message: 'Explicit', status: 502, retryable: false }).toJSON(),
  ).toEqual({ error: { code: 'EXPLICIT', message: 'Explicit', retryable: false } });
  for (const malformed of ['false', 0, null]) {
    const transport: typeof globalThis.fetch = Object.assign(
      async () =>
        Response.json(
          {
            error: { code: 'REMOTE', retryable: malformed },
          },
          { status: 502 },
        ),
      { preconnect: globalThis.fetch.preconnect },
    );
    const adapted = implementRemote(
      contract,
      createHttpClient({ baseUrl: 'http://localhost', fetch: transport, retry: { limit: 0 } }),
    );
    expect(
      await (await createCliInvoker({ name: 'malformed', services: [adapted] })).invoke(
        'recommendation_fail',
        { status: 502 },
      ),
    ).toMatchObject({ ok: false, error: { retryable: true } });
  }
});

test('ApiError keeps the existing cause argument and remote transport errors stay private', async () => {
  const secret = new Error('private-token-and-url');
  const explicit = new ApiError('REMOTE', {
    status: 502,
    message: 'Safe',
    traceId: 'trace',
    retryable: false,
    cause: secret,
  });
  expect(explicit.cause).toBe(secret);
  expect(explicit.retryable).toBe(false);
  const transport: typeof globalThis.fetch = Object.assign(
    async () => {
      throw secret;
    },
    { preconnect: globalThis.fetch.preconnect },
  );
  const causes: unknown[] = [];
  const adapted = implementRemote(
    contract,
    createHttpClient({ baseUrl: 'http://localhost', fetch: transport, retry: { limit: 0 } }),
  );
  const proxy = await createCliInvoker({
    name: 'private',
    services: [adapted],
    hooks: {
      onToolError: ({ error }) => {
        causes.push(error);
      },
    },
  });
  const result = await proxy.invoke('recommendation_fail', { status: 502 });
  expect(result).toMatchObject({
    ok: false,
    error: { code: 'CONNECTION_REQUEST_FAILED', retryable: true },
  });
  expect(JSON.stringify(result)).not.toContain('private-token-and-url');
  expect(JSON.stringify(result)).not.toContain('localhost');
  expect(causes).toHaveLength(1);
  const projected = causes[0];
  if (!AppError.is(projected)) throw new Error('Missing projected error');
  expect(projected.status).toBe(502);
  expect(ApiError.is(projected.cause)).toBe(true);
  if (!ApiError.is(projected.cause)) throw new Error('Missing internal cause');
  expect(projected.cause.cause).toBe(secret);
});

test('an upstream failure without an envelope keeps its status and never leaks its body', async () => {
  for (const [status, body] of [
    [503, '<html>nginx upstream-secret-body</html>'],
    [429, 'proxy upstream-secret-body'],
    [404, 'upstream-secret-body'],
  ] as const) {
    const transport: typeof globalThis.fetch = Object.assign(
      async () => new Response(body, { status, headers: { 'content-type': 'text/html' } }),
      { preconnect: globalThis.fetch.preconnect },
    );
    const adapted = implementRemote(
      contract,
      createHttpClient({ baseUrl: 'http://localhost', fetch: transport, retry: { limit: 0 } }),
    );
    const causes: unknown[] = [];
    const cli = await createCliInvoker({
      name: 'envelope-less',
      services: [adapted],
      hooks: { onToolError: ({ error }) => void causes.push(error) },
    });
    const result = await cli.invoke('recommendation_fail', { status });
    expect(result).toMatchObject({
      ok: false,
      error: { code: 'HTTP_ERROR', retryable: status !== 404 },
    });
    expect(JSON.stringify(result)).not.toContain('upstream-secret-body');
    const tools = createToolInvoker([adapted], { transport: 'MCP' });
    const tool = await tools.invoke('recommendation_fail', { status }, { source: 'mcp' });
    expect(tool).toMatchObject({ ok: false, code: 'HTTP_ERROR', retryable: status !== 404 });
    expect(JSON.stringify(tool)).not.toContain('upstream-secret-body');
    const projected = causes[0];
    if (!AppError.is(projected)) throw new Error('Missing projected error');
    expect(projected.status).toBe(status);
    expect(projected.details).toBeUndefined();
    expect(ApiError.is(projected.cause)).toBe(true);
  }
});

test('a deadline the remote client hit follows the status class like any 408', async () => {
  const transport: typeof globalThis.fetch = Object.assign(
    async (input: RequestInfo | URL, init?: RequestInit) => {
      const request = new Request(input, init);
      await new Promise<void>((_resolve, reject) =>
        request.signal.addEventListener('abort', () => reject(request.signal.reason), {
          once: true,
        }),
      );
      return Response.json({ ok: true });
    },
    { preconnect: globalThis.fetch.preconnect },
  );
  const adapted = implementRemote(
    contract,
    createHttpClient({
      baseUrl: 'http://localhost',
      fetch: transport,
      timeout: 5,
      retry: { limit: 0 },
    }),
  );
  const cli = await createCliInvoker({ name: 'deadline', services: [adapted] });
  expect(await cli.invoke('recommendation_fail', { status: 502 })).toMatchObject({
    ok: false,
    error: { code: 'REQUEST_TIMEOUT', retryable: true },
  });
});

test('declared retryability survives canonical SSE and NDJSON error frames', async () => {
  for (const format of ['sse', 'ndjson'] as const) {
    for (const declared of [false, true, undefined]) {
      const streamed = defineContract(
        { prefix: 'recommendation_stream' },
        {
          observe: {
            method: 'GET',
            path: '/observe',
            desc: 'Stream failure control',
            stream: { format, item: z.object({ ok: z.boolean() }) },
          },
        },
      );
      const origin = createHandler({
        logging: false,
        services: [
          implement(streamed, {
            observe: async function* () {
              yield { ok: true };
              throw new AppError('DOMAIN_REFUSED', {
                message: 'Safe stream refusal',
                status: 502,
                retryable: declared,
              });
            },
          }),
        ],
      });
      const client = createClient(streamed, {
        baseUrl: 'http://localhost',
        fetch: (input, init) => origin(new Request(input, init)),
      });
      const stream = await client.observe();
      expect(await stream.next()).toEqual({ done: false, value: { ok: true } });
      await expect(stream.next()).rejects.toMatchObject({
        code: 'DOMAIN_REFUSED',
        retryable: declared,
      });
    }
  }
});
