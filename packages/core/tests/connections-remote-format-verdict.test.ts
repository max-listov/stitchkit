/** Real remote validation owns the wording lost by a JSON Schema round trip. */
import { afterEach, expect, test } from 'bun:test';
import { z } from 'zod';
import { createCli, createCliInvoker, defineCliCommand } from '../src/entrypoints/cli';
import { defineContract } from '../src/entrypoints/contract';
import {
  defineMcpClientConnection,
  defineOpenApiConnection,
  mountConnections,
} from '../src/entrypoints/tools/connections';
import { createImplement } from '../src/server/implement';
import { McpHttpClient } from '../src/tools/connections/mcp-client';
import { createMcpHandler } from '../src/tools/mcp/handler';

const message =
  'Expected ISO 8601 UTC time, e.g. 2026-10-12T00:00:00Z; a bare date such as 2026-10-12 is not accepted';
const Input = z.strictObject({
  createdFrom: z.iso.datetime({ error: message }),
  mode: z.enum(['safe', 'fast']),
});
const valid = { createdFrom: '2026-10-12T00:00:00Z', mode: 'safe' };
const contract = defineContract(
  { prefix: 'entries', scope: 'public' },
  {
    list: {
      method: 'POST',
      path: '/',
      desc: 'List entries',
      expose: ['MCP'],
      tool: { name: 'list' },
      input: Input,
      output: z.object({ count: z.number() }),
    },
  },
);
const stops: Array<() => Promise<void>> = [];
afterEach(async () => {
  await Promise.all(stops.splice(0).map((stop) => stop()));
});

async function fixture() {
  const calls: unknown[] = [];
  const received: unknown[] = [];
  const service = createImplement()(contract, {
    list: async ({ input }) => {
      received.push(input);
      return { count: 1 };
    },
  });
  const handler = createMcpHandler({
    serverInfo: { name: 'entries', version: '1' },
    auth: () => ({}),
    context: () => ({}),
    services: [service],
  });
  const requestSchema = z.object({ method: z.string(), params: z.unknown().optional() });
  const server = Bun.serve({
    hostname: '127.0.0.1',
    port: 0,
    fetch: async (request) => {
      if (request.method === 'POST') {
        const body = requestSchema.parse(await request.clone().json());
        if (body.method === 'tools/call') calls.push(body.params);
      }
      return handler.fetch(request);
    },
  });
  stops.push(async () => {
    await server.stop(true);
    await handler.close();
  });
  const url = new URL('/mcp', server.url);
  const runtimeTools = await mountConnections([
    defineMcpClientConnection({
      name: 'entries',
      transport: { url: url.href },
      transports: ['CLI'],
    }),
  ]);
  const invoker = await createCliInvoker({ name: 'entries', runtimeTools });
  const cli = async (args: { createdFrom: string; mode: string }) => {
    let out = '';
    let err = '';
    let code = -1;
    await createCli({
      name: 'entries',
      version: '1',
      runtimeTools,
      argv: ['list', '--createdFrom', args.createdFrom, '--mode', args.mode, '--json'],
      stdin: async () => null,
      stdout: (text) => {
        out += text;
      },
      stderr: (text) => {
        err += text;
      },
      exit: (value) => {
        code = value;
      },
    });
    return { out, err, code };
  };
  return { calls, received, url, invoker, cli };
}

test('a restored datetime reaches real MCP validation and relays its whole authored refusal', async () => {
  const { calls, received, url, invoker, cli } = await fixture();
  const args = { ...valid, createdFrom: '2026-10-12' };
  const client = new McpHttpClient('reference', 'reference', {
    transport: { url: url.href },
    allowedHosts: new Set([url.host]),
    timeoutMs: 5_000,
    maxResponseBytes: 65_536,
  });
  let remote: unknown;
  try {
    await client.initialize(undefined);
    const result = z
      .object({
        isError: z.literal(true),
        content: z.array(z.object({ type: z.literal('text'), text: z.string() })),
      })
      .parse(await client.request('tools/call', { name: 'list', arguments: args }, undefined));
    const part = result.content[0];
    if (!part) throw new Error('Expected the remote refusal in the text content');
    remote = JSON.parse(part.text);
  } finally {
    client.teardown();
  }
  expect(calls).toHaveLength(1);
  const result = await invoker.invoke('list', args);
  expect(calls).toHaveLength(2);
  expect(result.ok).toBe(false);
  expect(result.error).toMatchObject({
    code: 'VALIDATION_ERROR',
    message: `Invalid input: createdFrom: ${message}`,
    details: { message: `Invalid input: createdFrom: ${message}` },
    retryable: false,
  });
  const output = await cli(args);
  expect(output.code).toBe(1);
  expect(output.out).toBe('');
  expect(JSON.parse(output.err)).toEqual(remote);
  expect(output.err).toContain(message);
  expect(output.err).not.toContain('Invalid ISO datetime');
  expect(output.err).not.toContain('must match pattern');
  expect(calls).toEqual(Array.from({ length: 3 }, () => ({ name: 'list', arguments: args })));
  expect(received).toEqual([]);
});

test.each([
  { name: 'type', args: { ...valid, createdFrom: 123 }, field: 'createdFrom' },
  { name: 'required', args: { mode: 'safe' }, field: 'createdFrom' },
  { name: 'extra key', args: { ...valid, extra: true }, field: 'extra' },
  { name: 'enum', args: { ...valid, mode: 'unknown' }, field: 'mode' },
  { name: 'mixed', args: { createdFrom: '2026-10-12', mode: 'unknown' }, field: 'mode' },
])('a reported $name refusal stops before remote tools/call', async ({ args, field }) => {
  const { calls, received, invoker } = await fixture();
  const result = await invoker.invoke('list', args);
  expect(result.ok).toBe(false);
  expect(result.error?.code).toBe('VALIDATION_ERROR');
  expect(result.error?.message).toContain(field);
  expect(result.error?.message).not.toContain('Invalid ISO datetime');
  expect(result.error?.message).not.toContain('must match pattern');
  expect(calls).toEqual([]);
  expect(received).toEqual([]);
});

test('a valid datetime reaches the handler unchanged through CLI and invoker', async () => {
  const { calls, received, invoker, cli } = await fixture();
  expect(await invoker.invoke('list', valid)).toMatchObject({ ok: true, data: { count: 1 } });
  const output = await cli(valid);
  expect(output.code).toBe(0);
  expect(JSON.parse(output.out)).toEqual({ count: 1 });
  expect(output.err).toBe('');
  expect(calls).toEqual(Array.from({ length: 2 }, () => ({ name: 'list', arguments: valid })));
  expect(received).toEqual([valid, valid]);
});

test('a locally authored CLI schema keeps its custom format refusal before its handler', async () => {
  let calls = 0;
  const invoker = await createCliInvoker({
    name: 'local',
    commands: [
      defineCliCommand({
        name: 'list',
        description: 'Local list',
        input: Input,
        output: z.object({ count: z.number() }),
        handler: () => {
          calls += 1;
          return { count: 1 };
        },
      }),
    ],
  });
  const result = await invoker.invoke('list', { ...valid, createdFrom: '2026-10-12' });
  expect(result.ok).toBe(false);
  expect(result.error?.message).toContain(message);
  expect(calls).toBe(0);
});

test('OpenAPI restores the same verdict without changing query arguments or error policy', async () => {
  const received: string[] = [];
  const server = Bun.serve({
    hostname: '127.0.0.1',
    port: 0,
    fetch: (request) => {
      received.push(new URL(request.url).searchParams.get('createdFrom') ?? 'absent');
      return Response.json({ error: 'REMOTE_DATE', details: { message } }, { status: 400 });
    },
  });
  stops.push(async () => {
    await server.stop(true);
  });
  const runtimeTools = await mountConnections([
    defineOpenApiConnection({
      name: 'entries',
      transports: ['CLI'],
      spec: {
        openapi: '3.1.0',
        info: { title: 'Entries', version: '1' },
        servers: [{ url: server.url.href }],
        paths: {
          '/entries': {
            get: {
              operationId: 'list',
              responses: {},
              parameters: [
                {
                  name: 'createdFrom',
                  in: 'query',
                  required: true,
                  schema: { type: 'string', format: 'date-time' },
                },
              ],
            },
          },
        },
      },
    }),
  ]);
  const invoker = await createCliInvoker({ name: 'entries', runtimeTools });
  const result = await invoker.invoke('entries__list', { createdFrom: '2026-10-12' });
  expect(received).toEqual(['2026-10-12']);
  expect(result.ok).toBe(false);
  expect(result.error?.code).toBe('CONNECTION_REQUEST_FAILED');
  for (const input of [{}, { createdFrom: 123 }]) {
    expect((await invoker.invoke('entries__list', input)).error?.code).toBe(
      'VALIDATION_ERROR',
    );
  }
  expect(received).toHaveLength(1);
});
