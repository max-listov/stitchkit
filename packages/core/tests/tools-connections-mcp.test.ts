/**
 * External MCP connections over the raw wire.
 *
 * One `Bun.serve` fake speaks JSON-RPC 2.0 over Streamable HTTP; another speaks
 * the legacy HTTP+SSE transport, so the narrow fallback rule is exercised
 * against a real socket rather than a stubbed `fetch`.
 */
import { afterEach, describe, expect, test } from 'bun:test';
import type { ToolSet } from 'ai';
import { mountAgent } from '../src/tools/agent';
import {
  ConnectionAuthorizationRequiredError,
  ConnectionBudgetExceededError,
  ConnectionRequestError,
  ConnectionUrlError,
  defineMcpClientConnection,
  mountConnections,
} from '../src/tools/connections';
import {
  ConnectionResponseTooLargeError,
  ConnectionTimeoutError,
} from '../src/tools/connections/errors';
import type { RuntimeToolDefinition } from '../src/tools/runtime-tool';

interface JsonRpcBody {
  jsonrpc: '2.0';
  id?: number;
  method: string;
  params?: Record<string, unknown>;
}

const DISCOVERED_TOOLS = [
  {
    name: 'echo',
    description: 'Echo a value',
    inputSchema: {
      type: 'object',
      properties: { value: { type: 'string' } },
      required: ['value'],
    },
  },
  {
    name: 'sum',
    description: 'Add two numbers',
    inputSchema: {
      type: 'object',
      properties: { a: { type: 'number' }, b: { type: 'number' } },
      required: ['a', 'b'],
    },
  },
  { name: 'blocked', description: 'Never allowed', inputSchema: { type: 'object' } },
];

const servers: Array<{ stop: () => Promise<void> | void }> = [];

afterEach(() => {
  for (const server of servers.splice(0)) void server.stop();
});

function executable(tools: ToolSet, name: string) {
  const execute = tools[name]?.execute;
  if (!execute) throw new Error('missing tool');
  return execute;
}

async function callTool(
  definitions: readonly RuntimeToolDefinition[],
  name: string,
  input: Record<string, unknown>,
): Promise<unknown> {
  const tools = mountAgent([], { runtimeTools: definitions });
  const entry = tools[name];
  if (!entry?.execute) throw new Error(`tool ${name} was not mounted`);
  const execute = entry.execute as unknown as (
    input: Record<string, unknown>,
    options: { toolCallId: string; messages: unknown[] },
  ) => Promise<unknown>;
  return execute(input, { toolCallId: 'test', messages: [] });
}

/** Invoke the foreign handler directly so a typed connection error is observable. */
function callRaw(
  definition: RuntimeToolDefinition,
  input: Record<string, unknown>,
): Promise<unknown> {
  const handler = definition.handler as unknown as (
    context: Record<string, unknown>,
  ) => Promise<unknown>;
  return handler({ input, params: undefined, source: 'agent' });
}

function requireTool(
  definitions: readonly RuntimeToolDefinition[],
  name: string,
): RuntimeToolDefinition {
  const tool = definitions.find((entry) => entry.name === name);
  if (!tool) throw new Error(`tool ${name} was not mounted`);
  return tool;
}

function jsonResult(id: number | undefined, result: unknown): Response {
  if (id === undefined) return new Response(null, { status: 202 });
  return new Response(JSON.stringify({ jsonrpc: '2.0', id, result }), {
    status: 200,
    headers: { 'content-type': 'application/json' },
  });
}

/** Streamable HTTP JSON server with an optional deny gate and a failure switch. */
function startJsonMcp(options: {
  deny?: (request: Request, body: JsonRpcBody) => number | undefined;
  onCall?: (name: string, args: Record<string, unknown>, request: Request) => unknown;
  failStatus?: number;
}) {
  let sseOpens = 0;
  const server = Bun.serve({
    port: 0,
    fetch: async (request) => {
      if (request.method === 'GET') {
        sseOpens += 1;
        return new Response('', { status: 404 });
      }
      const body = (await request.json()) as JsonRpcBody;
      if (options.failStatus !== undefined) {
        return new Response('failure', { status: options.failStatus });
      }
      const denial = options.deny?.(request, body);
      if (denial !== undefined) return new Response('denied', { status: denial });
      switch (body.method) {
        case 'initialize':
          return jsonResult(body.id, {
            protocolVersion: '2024-11-05',
            capabilities: {},
            serverInfo: { name: 'fake', version: '1' },
          });
        case 'notifications/initialized':
          return jsonResult(body.id, {});
        case 'tools/list':
          return jsonResult(body.id, { tools: DISCOVERED_TOOLS });
        case 'tools/call': {
          const name = String(body.params?.name ?? '');
          const args = (body.params?.arguments ?? {}) as Record<string, unknown>;
          const result = options.onCall?.(name, args, request) ?? { echoed: args };
          return jsonResult(body.id, { content: [{ type: 'text', text: name }], ...result });
        }
        default:
          return jsonResult(body.id, {});
      }
    },
  });
  const handle = {
    url: `http://127.0.0.1:${server.port}/mcp`,
    get sseOpens() {
      return sseOpens;
    },
    stop: () => server.stop(true),
  };
  servers.push(handle);
  return handle;
}

/** Legacy HTTP+SSE server: the initial POST /mcp is refused and the endpoint arrives on the stream. */
function startSseMcp(
  options: { postStatus?: number; endpoint?: string; crlf?: boolean } = {},
) {
  const postStatus = options.postStatus ?? 404;
  const boundary = options.crlf ? '\r\n' : '\n';
  const frame = (lines: string[]) => `${lines.join(boundary)}${boundary}${boundary}`;
  const senders: Array<(frame: string) => void> = [];
  let sseOpens = 0;
  const server = Bun.serve({
    port: 0,
    fetch: async (request) => {
      const url = new URL(request.url);
      if (request.method === 'GET' && url.pathname === '/mcp') {
        sseOpens += 1;
        const stream = new ReadableStream<Uint8Array>({
          start(controller) {
            const send = (chunk: string) => {
              if (controller.desiredSize !== null)
                controller.enqueue(new TextEncoder().encode(chunk));
            };
            senders.push(send);
            send(frame(['event: endpoint', `data: ${options.endpoint ?? '/messages'}`]));
          },
        });
        return new Response(stream, { headers: { 'content-type': 'text/event-stream' } });
      }
      if (request.method === 'POST' && url.pathname === '/mcp') {
        return new Response('not streamable', { status: postStatus });
      }
      if (request.method === 'POST' && url.pathname === '/messages') {
        const body = (await request.json()) as JsonRpcBody;
        if (body.id !== undefined) {
          const result =
            body.method === 'tools/list'
              ? { tools: DISCOVERED_TOOLS }
              : body.method === 'tools/call'
                ? { content: [{ type: 'text', text: String(body.params?.name ?? '') }] }
                : { protocolVersion: '2024-11-05' };
          for (const send of senders)
            send(
              frame([
                'event: message',
                `data: ${JSON.stringify({ jsonrpc: '2.0', id: body.id, result })}`,
              ]),
            );
        }
        return new Response(null, { status: 202 });
      }
      return new Response('not found', { status: 404 });
    },
  });
  const handle = {
    url: `http://127.0.0.1:${server.port}/mcp`,
    get sseOpens() {
      return sseOpens;
    },
    stop: () => server.stop(true),
  };
  servers.push(handle);
  return handle;
}

/** Streamable HTTP that answers every JSON-RPC request with a CRLF-framed SSE body. */
function startStreamableSseMcp() {
  const server = Bun.serve({
    port: 0,
    fetch: async (request) => {
      if (request.method === 'GET') return new Response('', { status: 404 });
      const body = (await request.json()) as JsonRpcBody;
      if (body.id === undefined) return new Response(null, { status: 202 });
      const result =
        body.method === 'tools/list'
          ? { tools: DISCOVERED_TOOLS }
          : body.method === 'tools/call'
            ? { content: [{ type: 'text', text: String(body.params?.name ?? '') }] }
            : { protocolVersion: '2024-11-05' };
      const payload = JSON.stringify({ jsonrpc: '2.0', id: body.id, result });
      return new Response(`event: message\r\ndata: ${payload}\r\n\r\n`, {
        status: 200,
        headers: { 'content-type': 'text/event-stream' },
      });
    },
  });
  const handle = {
    url: `http://127.0.0.1:${server.port}/mcp`,
    stop: () => server.stop(true),
  };
  servers.push(handle);
  return handle;
}

/** A server that never answers, so the connection deadline is the only way out. */
function startHungServer() {
  const server = Bun.serve({
    port: 0,
    fetch: async () => {
      await Bun.sleep(10_000);
      return new Response('late');
    },
  });
  const handle = {
    url: `http://127.0.0.1:${server.port}/mcp`,
    stop: () => server.stop(true),
  };
  servers.push(handle);
  return handle;
}

/** A server whose JSON-RPC replies always exceed a tiny byte ceiling. */
function startOversizedMcp() {
  const server = Bun.serve({
    port: 0,
    fetch: (request) => {
      if (request.method === 'GET') return new Response('', { status: 404 });
      const blob = 'x'.repeat(4096);
      return new Response(JSON.stringify({ jsonrpc: '2.0', id: 1, result: { blob } }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      });
    },
  });
  const handle = {
    url: `http://127.0.0.1:${server.port}/mcp`,
    stop: () => server.stop(true),
  };
  servers.push(handle);
  return handle;
}

/** A server that records every request it receives, answering 202 to all of them. */
function startRecordingServer() {
  const requests: Array<{ method: string; headers: Headers }> = [];
  const server = Bun.serve({
    port: 0,
    fetch: (request) => {
      requests.push({ method: request.method, headers: request.headers });
      return new Response(null, { status: 202 });
    },
  });
  const handle = {
    base: `http://127.0.0.1:${server.port}`,
    host: `127.0.0.1:${server.port}`,
    requests,
    stop: () => server.stop(true),
  };
  servers.push(handle);
  return handle;
}

/** Legacy SSE whose first tool call is a 500 and every later one a 401. */
function startFlakySseMcp() {
  const senders: Array<(frame: string) => void> = [];
  let calls = 0;
  const server = Bun.serve({
    port: 0,
    fetch: async (request) => {
      const url = new URL(request.url);
      if (request.method === 'GET' && url.pathname === '/mcp') {
        const stream = new ReadableStream<Uint8Array>({
          start(controller) {
            const send = (frame: string) => {
              if (controller.desiredSize !== null)
                controller.enqueue(new TextEncoder().encode(frame));
            };
            senders.push(send);
            send('event: endpoint\ndata: /messages\n\n');
          },
        });
        return new Response(stream, { headers: { 'content-type': 'text/event-stream' } });
      }
      if (request.method === 'POST' && url.pathname === '/mcp') {
        return new Response('not streamable', { status: 404 });
      }
      if (request.method === 'POST' && url.pathname === '/messages') {
        const body = (await request.json()) as JsonRpcBody;
        if (body.method === 'tools/call') {
          calls += 1;
          return new Response('failure', { status: calls === 1 ? 500 : 401 });
        }
        if (body.id !== undefined) {
          const result =
            body.method === 'tools/list'
              ? { tools: DISCOVERED_TOOLS }
              : { protocolVersion: '2024-11-05' };
          const frame = `event: message\ndata: ${JSON.stringify({ jsonrpc: '2.0', id: body.id, result })}\n\n`;
          for (const send of senders) send(frame);
        }
        return new Response(null, { status: 202 });
      }
      return new Response('not found', { status: 404 });
    },
  });
  const handle = {
    url: `http://127.0.0.1:${server.port}/mcp`,
    stop: () => server.stop(true),
  };
  servers.push(handle);
  return handle;
}

describe('MCP connections over Streamable HTTP', () => {
  test('discovery mounts one tool per advertised tool and a call reaches the server', async () => {
    const server = startJsonMcp({
      onCall: (name, args) => ({ structuredContent: { tool: name, args } }),
    });
    const tools = await mountConnections([
      defineMcpClientConnection({ name: 'weather', transport: { url: server.url } }),
    ]);
    expect(tools.map((tool) => tool.name).sort()).toEqual(['blocked', 'echo', 'sum']);

    const result = await callTool(tools, 'echo', { value: 'hi' });
    expect(result).toMatchObject({
      structuredContent: { tool: 'echo', args: { value: 'hi' } },
    });
  });

  test('tools.allow keeps only the whitelist and tools.block removes from it', async () => {
    const server = startJsonMcp({});
    const tools = await mountConnections([
      defineMcpClientConnection({
        name: 'filtered',
        transport: { url: server.url },
        tools: { allow: ['echo', 'sum'], block: ['sum'] },
      }),
    ]);
    expect(tools.map((tool) => tool.name)).toEqual(['echo']);
  });

  test('a 500 propagates and never opens the SSE fallback', async () => {
    const server = startJsonMcp({ failStatus: 500 });
    await expect(
      mountConnections([
        defineMcpClientConnection({ name: 'broken', transport: { url: server.url } }),
      ]),
    ).rejects.toBeInstanceOf(ConnectionRequestError);
    expect(server.sseOpens).toBe(0);
  });

  test('a 404 falls back to legacy HTTP+SSE and still discovers and calls', async () => {
    const server = startSseMcp();
    const tools = await mountConnections([
      defineMcpClientConnection({ name: 'legacy', transport: { url: server.url } }),
    ]);
    expect(tools.map((tool) => tool.name).sort()).toEqual(['blocked', 'echo', 'sum']);
    const result = await callTool(tools, 'echo', { value: 'sse' });
    expect(result).toMatchObject({ content: [{ type: 'text', text: 'echo' }] });
  });

  test('400 and 405 open the SSE fallback exactly as 404 does', async () => {
    for (const status of [400, 405]) {
      const server = startSseMcp({ postStatus: status });
      const tools = await mountConnections([
        defineMcpClientConnection({
          name: `legacy-${status}`,
          transport: { url: server.url },
        }),
      ]);
      expect(tools).toHaveLength(DISCOVERED_TOOLS.length);
      expect(server.sseOpens).toBe(1);
    }
  });

  test('401 raises the typed reauthorization error and the next call re-fetches the token', async () => {
    let issued = 0;
    const server = startJsonMcp({
      deny: (request, body) =>
        body.method === 'tools/call' &&
        request.headers.get('authorization') !== 'Bearer second'
          ? 401
          : undefined,
      onCall: (name) => ({ structuredContent: { name } }),
    });
    const tools = await mountConnections([
      defineMcpClientConnection({
        name: 'guarded',
        transport: { url: server.url },
        token: () => {
          issued += 1;
          return issued <= 2 ? 'first' : 'second';
        },
      }),
    ]);

    const failure = await callRaw(requireTool(tools, 'echo'), { value: 'x' }).catch(
      (error: unknown) => error,
    );
    expect(failure).toBeInstanceOf(ConnectionAuthorizationRequiredError);
    expect(issued).toBe(2);
    expect(server.sseOpens).toBe(0);

    const result = await callTool(tools, 'echo', { value: 'x' });
    expect(issued).toBe(3);
    expect(result).toMatchObject({ structuredContent: { name: 'echo' } });
  });

  test('403 propagates unchanged and each call resolves its own credential', async () => {
    let issued = 0;
    const server = startJsonMcp({
      deny: (_request, body) => (body.method === 'tools/call' ? 403 : undefined),
    });
    const tools = await mountConnections([
      defineMcpClientConnection({
        name: 'forbidden',
        transport: { url: server.url },
        token: () => {
          issued += 1;
          return 'granted';
        },
      }),
    ]);

    const failure = await callRaw(requireTool(tools, 'echo'), { value: 'x' }).catch(
      (error: unknown) => error,
    );
    expect(failure).toBeInstanceOf(ConnectionRequestError);
    expect((failure as ConnectionRequestError).status).toBe(403);
    await callRaw(requireTool(tools, 'echo'), { value: 'x' }).catch(() => undefined);
    expect(issued).toBe(3);
  });

  test('a non-http(s) connection URL is refused at definition', () => {
    expect(() =>
      defineMcpClientConnection({ name: 'bad', transport: { url: 'ftp://example.com/mcp' } }),
    ).toThrow(ConnectionUrlError);
  });

  test('mount lifecycle gates and transforms foreign tool results', async () => {
    const server = startJsonMcp({ onCall: () => ({ structuredContent: { ok: true } }) });
    const seen: string[] = [];
    const definitions = await mountConnections([
      defineMcpClientConnection({ name: 'gated', transport: { url: server.url } }),
    ]);
    const tools = mountAgent([], {
      runtimeTools: definitions,
      lifecycle: {
        beforeHandle: (context, endpoint) => {
          seen.push(`before:${endpoint.toolName}`);
          expect(context.source).toBe('agent');
        },
        afterHandle: (_context, result) => ({ wrapped: result }),
      },
    });
    const result = await executable(tools, 'echo')(
      { value: 'x' },
      { toolCallId: 'test', messages: [], context: undefined },
    );
    expect(seen).toEqual(['before:echo']);
    expect(result).toMatchObject({ wrapped: { structuredContent: { ok: true } } });
  });

  test('a mount budget is enforced across connections', async () => {
    const server = startJsonMcp({});
    await expect(
      mountConnections(
        [defineMcpClientConnection({ name: 'budgeted', transport: { url: server.url } })],
        { budget: { maxTools: 2 } },
      ),
    ).rejects.toThrow(/budget of 2/);
  });

  test('an off-policy SSE endpoint is refused and no request reaches it', async () => {
    const other = startRecordingServer();
    const server = startSseMcp({ endpoint: `${other.base}/messages` });
    const failure = await mountConnections([
      defineMcpClientConnection({ name: 'fenced', transport: { url: server.url } }),
    ]).catch((error: unknown) => error);
    expect(failure).toBeInstanceOf(ConnectionUrlError);
    expect(other.requests).toHaveLength(0);
  });

  test('a CRLF-framed legacy SSE server still discovers and calls', async () => {
    const server = startSseMcp({ crlf: true });
    const tools = await mountConnections([
      defineMcpClientConnection({ name: 'crlf-legacy', transport: { url: server.url } }),
    ]);
    expect(tools.map((tool) => tool.name).sort()).toEqual(['blocked', 'echo', 'sum']);
    const result = await callTool(tools, 'echo', { value: 'crlf' });
    expect(result).toMatchObject({ content: [{ type: 'text', text: 'echo' }] });
  });

  test('a CRLF-framed Streamable HTTP SSE response still discovers and calls', async () => {
    const server = startStreamableSseMcp();
    const tools = await mountConnections([
      defineMcpClientConnection({ name: 'crlf-streamable', transport: { url: server.url } }),
    ]);
    expect(tools.map((tool) => tool.name).sort()).toEqual(['blocked', 'echo', 'sum']);
    const result = await callTool(tools, 'echo', { value: 'crlf' });
    expect(result).toMatchObject({ content: [{ type: 'text', text: 'echo' }] });
  });

  test('a hung server is aborted by the timeout and surfaces a typed error', async () => {
    const server = startHungServer();
    const failure = await mountConnections([
      defineMcpClientConnection({
        name: 'hung',
        transport: { url: server.url },
        timeoutMs: 50,
      }),
    ]).catch((error: unknown) => error);
    expect(failure).toBeInstanceOf(ConnectionTimeoutError);
  });

  test('an oversized response body is refused', async () => {
    const server = startOversizedMcp();
    const failure = await mountConnections([
      defineMcpClientConnection({
        name: 'oversized',
        transport: { url: server.url },
        maxResponseBytes: 64,
      }),
    ]).catch((error: unknown) => error);
    expect(failure).toBeInstanceOf(ConnectionResponseTooLargeError);
  });

  test('the maxSchemaBytes budget is enforced across discovered schemas', async () => {
    const server = startJsonMcp({});
    const failure = await mountConnections(
      [defineMcpClientConnection({ name: 'schemas', transport: { url: server.url } })],
      { budget: { maxSchemaBytes: 10 } },
    ).catch((error: unknown) => error);
    expect(failure).toBeInstanceOf(ConnectionBudgetExceededError);
  });

  test('a non-2xx SSE POST leaves no unhandled rejection after teardown', async () => {
    const server = startFlakySseMcp();
    const tools = await mountConnections([
      defineMcpClientConnection({ name: 'flaky', transport: { url: server.url } }),
    ]);
    const rejections: unknown[] = [];
    const onUnhandled = (reason: unknown) => rejections.push(reason);
    process.on('unhandledRejection', onUnhandled);
    try {
      await callRaw(requireTool(tools, 'echo'), { value: 'x' }).catch(() => undefined);
      await callRaw(requireTool(tools, 'echo'), { value: 'x' }).catch(() => undefined);
      await new Promise((resolve) => setTimeout(resolve, 20));
    } finally {
      process.off('unhandledRejection', onUnhandled);
    }
    expect(rejections).toEqual([]);
  });
});
