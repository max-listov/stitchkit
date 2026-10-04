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
    throw new AppError(
      'DOMAIN_REFUSED',
      'Cannot repeat this operation',
      input.status,
      { message: 'Cannot repeat this operation', marker: 'safe' },
      'Reconcile destination',
      'domain-trace',
      input.declared,
    );
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
  expect(new AppError('DEFAULT', 'Default', 502).toJSON()).toEqual({
    error: { code: 'DEFAULT', message: 'Default' },
  });
  expect(
    new AppError('EXPLICIT', 'Explicit', 502, undefined, undefined, undefined, false).toJSON(),
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

test('ApiError keeps the existing cause argument and remote unknown transport errors stay private', async () => {
  const secret = new Error('private-token-and-url');
  const explicit = new ApiError(
    'REMOTE',
    502,
    undefined,
    'Safe',
    undefined,
    'trace',
    { cause: secret },
    false,
  );
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
    error: { code: 'INTERNAL_SERVER_ERROR', retryable: false },
  });
  expect(JSON.stringify(result)).not.toContain('private-token-and-url');
  expect(causes).toHaveLength(1);
  expect(ApiError.is(causes[0])).toBe(true);
  if (!ApiError.is(causes[0])) throw new Error('Missing internal cause');
  expect(causes[0].cause).toBe(secret);
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
              throw new AppError(
                'DOMAIN_REFUSED',
                'Safe stream refusal',
                502,
                undefined,
                undefined,
                undefined,
                declared,
              );
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
