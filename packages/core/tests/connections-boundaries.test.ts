import { afterEach, expect, test } from 'bun:test';
import type { ToolSet } from 'ai';
import { type AgentMountConfig, mountAgent } from '../src/tools/agent';
import { AgentToolError } from '../src/tools/agent-tool-error';
import {
  ConnectionAuthorizationRequiredError,
  ConnectionUrlError,
  defineOpenApiConnection,
  mountConnections,
} from '../src/tools/connections';
import {
  ConnectionResponseTooLargeError,
  ConnectionTimeoutError,
} from '../src/tools/connections/errors';
import { McpHttpClient } from '../src/tools/connections/mcp-client';
import { SseSession } from '../src/tools/connections/sse-session';
import type { RuntimeToolDefinition } from '../src/tools/runtime-tool';

const servers: ReturnType<typeof Bun.serve>[] = [];
afterEach(() => {
  for (const server of servers.splice(0)) server.stop(true);
});
function server(fetch: (request: Request) => Response | Promise<Response>) {
  const s = Bun.serve({ hostname: '127.0.0.1', port: 0, fetch });
  servers.push(s);
  return s.url;
}
async function call(
  definitions: readonly RuntimeToolDefinition[],
  config: AgentMountConfig = {},
) {
  const tools = mountAgent([], { ...config, runtimeTools: definitions });
  const name = Object.keys(tools)[0];
  if (!name) throw new Error('No tool');
  return executable(tools, name)({}, { toolCallId: 'test', messages: [], context: undefined });
}
function executable(tools: ToolSet, name: string) {
  const execute = tools[name]?.execute;
  if (!execute) throw new Error('No execute');
  return execute;
}
const spec = {
  openapi: '3.1.0',
  paths: { '/x': { get: { operationId: 'x', security: [{ bearer: [] }] } } },
  components: { securitySchemes: { bearer: { type: 'http', scheme: 'bearer' } } },
};

test('credentials follow each call context and never another mount', async () => {
  const seen: (string | null)[] = [];
  const url = server((request) => {
    seen.push(request.headers.get('authorization'));
    return Response.json({ ok: true });
  });
  const definitions = await mountConnections([
    defineOpenApiConnection({
      name: 'same',
      baseUrl: url.href,
      spec,
      token: (context) =>
        typeof context?.principal === 'string' ? context.principal : undefined,
    }),
  ]);
  await call(definitions, { context: { principal: 'A' } });
  await call(definitions, { context: { principal: 'B' } });
  const second = await mountConnections([
    defineOpenApiConnection({ name: 'same', baseUrl: url.href, spec, token: () => 'C' }),
  ]);
  await call(second);
  expect(seen).toEqual(['Bearer A', 'Bearer B', 'Bearer C']);
});

test('mounted reauthorization retains its typed cause and lifecycle runs once', async () => {
  let before = 0;
  let after = 0;
  let status = 401;
  const url = server(() => Response.json({ ok: true }, { status }));
  const definitions = await mountConnections([
    defineOpenApiConnection({ name: 'auth', baseUrl: url.href, spec }),
  ]);
  const config: AgentMountConfig = {
    lifecycle: {
      beforeHandle: () => {
        before++;
      },
      afterHandle: () => {
        after++;
      },
    },
  };
  const error = await call(definitions, config).catch((error: unknown) => error);
  expect(error).toBeInstanceOf(AgentToolError);
  if (!(error instanceof AgentToolError)) throw new Error('Wrong envelope');
  expect(error.cause).toBeInstanceOf(ConnectionAuthorizationRequiredError);
  expect(error.message).not.toContain('auth');
  status = 200;
  await call(definitions, config);
  expect({ before, after }).toEqual({ before: 2, after: 1 });
});

test('redirect and remote-spec server cannot authorize a foreign host', async () => {
  let hits = 0;
  const foreign = server(() => {
    hits++;
    return Response.json({ ok: true });
  });
  const redirect = server(
    () => new Response(null, { status: 307, headers: { location: foreign.href } }),
  );
  const definitions = await mountConnections([
    defineOpenApiConnection({ name: 'redirect', baseUrl: redirect.href, spec }),
  ]);
  const failure = await call(definitions).catch((error: unknown) => error);
  expect(failure).toBeInstanceOf(AgentToolError);
  if (!(failure instanceof AgentToolError)) throw new Error('Wrong failure');
  expect(failure.cause).toBeInstanceOf(ConnectionUrlError);
  const document = server(() => Response.json({ ...spec, servers: [{ url: foreign.href }] }));
  await expect(
    mountConnections([defineOpenApiConnection({ name: 'spec', spec: document.href })]),
  ).rejects.toBeInstanceOf(ConnectionUrlError);
  expect(hits).toBe(0);
  const allowed = await mountConnections([
    defineOpenApiConnection({ name: 'spec', spec: document.href, allowHosts: [foreign.host] }),
  ]);
  await call(allowed);
  expect(hits).toBe(1);
});

test('streamable SSE bounds the complete response body', async () => {
  const url = server(
    () =>
      new Response(
        `data: ${JSON.stringify({ jsonrpc: '2.0', id: 1, result: 'x'.repeat(4096) })}\n\n`,
        { headers: { 'content-type': 'text/event-stream' } },
      ),
  );
  const client = new McpHttpClient('bounded', 'fixture', {
    transport: { url: url.href },
    allowedHosts: new Set([url.host]),
    timeoutMs: 1000,
    maxResponseBytes: 64,
  });
  try {
    await expect(client.request('x', {}, undefined)).rejects.toBeInstanceOf(
      ConnectionResponseTooLargeError,
    );
  } finally {
    client.teardown();
  }
});

test('legacy SSE readiness includes endpoint and response wait includes cancellation', async () => {
  const missing = server(
    () =>
      new Response(
        new ReadableStream({
          start(controller) {
            controller.enqueue(new TextEncoder().encode(':ready\n\n'));
          },
        }),
        { headers: { 'content-type': 'text/event-stream' } },
      ),
  );
  const session = new SseSession('deadline', 'fixture', {
    baseUrl: missing.href,
    allowedHosts: new Set([missing.host]),
    headers: {},
    timeoutMs: 20,
    maxResponseBytes: 128,
  });
  await expect(session.ready()).rejects.toBeInstanceOf(ConnectionTimeoutError);
  const url = server((request) =>
    request.method === 'POST'
      ? new Response(null, { status: 202 })
      : new Response(
          new ReadableStream({
            start(controller) {
              controller.enqueue(new TextEncoder().encode('event: endpoint\ndata: /post\n\n'));
            },
          }),
          { headers: { 'content-type': 'text/event-stream' } },
        ),
  );
  const waiting = new SseSession('cancel', 'fixture', {
    baseUrl: url.href,
    allowedHosts: new Set([url.host]),
    headers: {},
    timeoutMs: 1000,
    maxResponseBytes: 128,
  });
  await waiting.ready();
  const controller = new AbortController();
  const result = waiting.request(
    { jsonrpc: '2.0', id: 1, method: 'x' },
    undefined,
    controller.signal,
  );
  const captured = result.catch((error: unknown) => error);
  controller.abort(new Error('caller stopped'));
  const error = await captured;
  expect(error).toBeInstanceOf(Error);
  if (!(error instanceof Error)) throw new Error('Missing cancellation');
  expect(error.message).toBe('caller stopped');
  waiting.close();
});
