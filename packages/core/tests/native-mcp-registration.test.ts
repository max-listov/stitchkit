import { describe, expect, test } from 'bun:test';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import { z } from 'zod';
import { AppError } from '../src/contract';
import { isRecord } from '../src/internal/typed';
import {
  createAuditHook,
  createTraceContext,
  type RequestEvent,
  runWithRequestContext,
  setRequestDimensions,
} from '../src/observability';
import { buildMcpServer } from '../src/tools/mcp';
import { createMcpHandler } from '../src/tools/mcp-handler';
import type { NativeMcpRegistrar } from '../src/tools/native-mcp';

async function connect(server: McpServer): Promise<Client> {
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: 'native-test', version: '1' });
  await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
  return client;
}

function rpcRequest(method: string, sessionId?: string): Request {
  return new Request('http://local/mcp', {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      accept: 'application/json, text/event-stream',
      ...(sessionId && { 'mcp-session-id': sessionId }),
    },
    body: JSON.stringify({
      jsonrpc: '2.0',
      id: 1,
      method,
      params:
        method === 'initialize'
          ? {
              protocolVersion: '2025-06-18',
              capabilities: {},
              clientInfo: { name: 'native-test', version: '1' },
            }
          : {},
    }),
  });
}

async function rpcBody(response: Response): Promise<unknown> {
  const text = await response.text();
  const data = text
    .split('\n')
    .find((line) => line.startsWith('data: '))
    ?.slice('data: '.length);
  return JSON.parse(data ?? text);
}

function listedToolNames(body: unknown): string[] {
  if (!isRecord(body) || !isRecord(body.result) || !Array.isArray(body.result.tools))
    return [];
  return body.result.tools.flatMap((tool) =>
    isRecord(tool) && typeof tool.name === 'string' ? [tool.name] : [],
  );
}

function registerTransportProbe({ registerTool }: NativeMcpRegistrar): void {
  registerTool({
    name: 'transport_probe',
    description: 'Probe transport registration',
    identity: { serviceName: 'native', action: 'probe', method: 'GET' },
    input: z.object({}),
    handler: () => undefined,
  });
}

describe('framework-owned native MCP registration', () => {
  test('preserves multimodal content and parses only structuredContent', async () => {
    const content: CallToolResult['content'] = [
      { type: 'text', text: 'preview' },
      { type: 'image', data: 'aGVsbG8=', mimeType: 'image/png' },
    ];
    const meta = { requestId: 'r1', nested: { keep: true } };
    const structured = { assetId: 'asset-1', internal: 'stripped' };
    const server = buildMcpServer(
      {
        serverInfo: { name: 'native', version: '1' },
        services: [],
        nativeTools: ({ registerTool }) => {
          registerTool({
            name: 'render_preview',
            description: 'Render a preview',
            identity: {
              serviceName: 'renderer',
              action: 'preview',
              scope: 'admin',
              method: 'POST',
            },
            input: z.object({ prompt: z.string() }),
            output: z.object({ assetId: z.string() }),
            handler: () => structured,
            present: { mcp: () => ({ content, _meta: meta }) },
          });
        },
      },
      undefined,
    );
    const client = await connect(server);

    const result = await client.callTool({
      name: 'render_preview',
      arguments: { prompt: 'forest' },
    });

    expect(result.content).toEqual(content);
    expect(result.structuredContent).toEqual({ assetId: 'asset-1' });
    expect(result._meta).toEqual(meta);
    await client.close();
  });

  test('runs lifecycle and hooks in one documented order with native identity', async () => {
    const order: string[] = [];
    const endpoints: Array<{ serviceName: string; action: string; scope?: string }> = [];
    const server = buildMcpServer(
      {
        serverInfo: { name: 'native', version: '1' },
        services: [],
        lifecycle: {
          beforeHandle: (_context, endpoint) => {
            order.push('beforeHandle');
            endpoints.push({
              serviceName: endpoint.serviceName,
              action: endpoint.key,
              scope: endpoint.scope,
            });
          },
          afterHandle: (_context, result) => {
            order.push('afterHandle');
            return result;
          },
        },
        hooks: {
          beforeToolCall: () => {
            order.push('beforeToolCall');
          },
          afterToolCall: () => {
            order.push('afterToolCall');
          },
        },
        nativeTools: ({ registerTool }) => {
          registerTool({
            name: 'entity_update',
            description: 'Update an entity',
            identity: {
              serviceName: 'agentTools',
              action: 'entityUpdate',
              scope: 'admin',
              method: 'PATCH',
            },
            input: z.object({ id: z.string() }),
            handler: () => {
              order.push('handler');
            },
          });
        },
      },
      undefined,
    );
    const client = await connect(server);

    await client.callTool({ name: 'entity_update', arguments: { id: 'e1' } });

    expect(order).toEqual([
      'beforeToolCall',
      'beforeHandle',
      'handler',
      'afterHandle',
      'afterToolCall',
    ]);
    expect(endpoints).toEqual([
      { serviceName: 'agentTools', action: 'entityUpdate', scope: 'admin' },
    ]);
    await client.close();
  });

  test('normalises throws and invalid structured output through the failure hooks', async () => {
    const thrown = new Error('database unavailable');
    const errors: unknown[] = [];
    const results: Array<{ ok: boolean; code?: string }> = [];
    const failureOrder: string[] = [];
    const server = buildMcpServer(
      {
        serverInfo: { name: 'native', version: '1' },
        services: [],
        hooks: {
          beforeToolCall: ({ toolName }) => {
            if (toolName === 'throwing_tool') failureOrder.push('beforeToolCall');
          },
          onToolError: ({ toolName, error }) => {
            if (toolName === 'throwing_tool') failureOrder.push('onToolError');
            errors.push(error);
          },
          afterToolCall: ({ toolName, result }) => {
            if (toolName === 'throwing_tool') failureOrder.push('afterToolCall');
            results.push(result.ok ? { ok: true } : { ok: false, code: result.code });
          },
        },
        lifecycle: {
          beforeHandle: (_context, endpoint) => {
            if (endpoint.key === 'throw') failureOrder.push('beforeHandle');
          },
        },
        nativeTools: ({ registerTool }) => {
          registerTool({
            name: 'throwing_tool',
            description: 'Throw',
            identity: { serviceName: 'native', action: 'throw', method: 'POST' },
            input: z.object({}),
            handler: () => {
              failureOrder.push('handler');
              throw thrown;
            },
          });
          registerTool({
            name: 'invalid_output',
            description: 'Return invalid output',
            identity: { serviceName: 'native', action: 'invalidOutput', method: 'POST' },
            input: z.object({}),
            output: z.object({ count: z.number().finite() }),
            handler: () => ({ count: Number.NaN }),
          });
        },
      },
      undefined,
    );
    const client = await connect(server);

    const originalError = console.error;
    console.error = () => undefined;
    const thrownResult = await client.callTool({ name: 'throwing_tool', arguments: {} });
    console.error = originalError;
    const invalidResult = await client.callTool({ name: 'invalid_output', arguments: {} });

    expect(thrownResult.isError).toBe(true);
    expect(invalidResult.isError).toBe(true);
    expect(errors).toEqual([thrown]);
    expect(failureOrder).toEqual([
      'beforeToolCall',
      'beforeHandle',
      'handler',
      'onToolError',
      'afterToolCall',
    ]);
    expect(results).toEqual([
      { ok: false, code: 'INTERNAL_SERVER_ERROR' },
      { ok: false, code: 'INTERNAL_SERVER_ERROR' },
    ]);
    await client.close();
  });

  test('uses the canonical schema profile for native input and output', () => {
    expect(() =>
      buildMcpServer(
        {
          serverInfo: { name: 'native', version: '1' },
          services: [],
          schemaValidation: { requirePortableFormats: true },
          nativeTools: ({ registerTool }) => {
            registerTool({
              name: 'custom_id',
              description: 'Read a custom id',
              identity: { serviceName: 'native', action: 'read', method: 'GET' },
              input: z.object({ id: z.cuid2() }),
              output: z.object({ id: z.ulid() }),
              handler: () => ({ id: '01ARZ3NDEKTSV4RRFFQ69G5FAV' }),
            });
          },
        },
        undefined,
      ),
    ).toThrow(/custom_id.*input property "id".*cuid2.*custom_id.*output property "id".*ulid/s);
  });

  test('invalid arguments are rejected inside stitchkit hooks', async () => {
    let hookCalls = 0;
    let handlerCalls = 0;
    const server = buildMcpServer(
      {
        serverInfo: { name: 'native', version: '1' },
        services: [],
        hooks: {
          beforeToolCall: () => {
            hookCalls += 1;
          },
          afterToolCall: () => {
            hookCalls += 1;
          },
        },
        nativeTools: ({ registerTool }) => {
          registerTool({
            name: 'typed_input',
            description: 'Typed input',
            identity: { serviceName: 'native', action: 'typed', method: 'POST' },
            input: z.object({ count: z.number() }).strict(),
            handler: () => {
              handlerCalls += 1;
            },
          });
        },
      },
      undefined,
    );
    const client = await connect(server);

    const result = await client.callTool({
      name: 'typed_input',
      arguments: { count: 'wrong' },
    });
    expect(result.isError).toBe(true);
    expect(JSON.stringify(result.content)).toMatch(/Invalid arguments|validation/i);
    expect(hookCalls).toBe(2);
    expect(handlerCalls).toBe(0);
    await client.close();
  });

  test('lifecycle can reject a native scope before the handler', async () => {
    let handled = false;
    const server = buildMcpServer(
      {
        serverInfo: { name: 'native', version: '1' },
        services: [],
        lifecycle: {
          beforeHandle: (_context, endpoint) => {
            if (endpoint.scope === 'admin') throw new AppError('FORBIDDEN', 'denied', 403);
          },
        },
        nativeTools: ({ registerTool }) => {
          registerTool({
            name: 'admin_action',
            description: 'Admin action',
            identity: {
              serviceName: 'adminTools',
              action: 'run',
              scope: 'admin',
              method: 'POST',
            },
            input: z.object({}),
            handler: () => {
              handled = true;
            },
          });
        },
      },
      undefined,
    );
    const client = await connect(server);

    const result = await client.callTool({ name: 'admin_action', arguments: {} });

    expect(result.isError).toBe(true);
    expect(handled).toBe(false);
    await client.close();
  });
});

describe('native registration transport parity', () => {
  test('transport-neutral, stateful HTTP and stateless HTTP advertise the same tool', async () => {
    const directClient = await connect(
      buildMcpServer(
        {
          serverInfo: { name: 'native', version: '1' },
          services: [],
          nativeTools: registerTransportProbe,
        },
        undefined,
      ),
    );
    const directNames = (await directClient.listTools()).tools.map((tool) => tool.name);

    const stateful = createMcpHandler({
      serverInfo: { name: 'native', version: '1' },
      auth: () => ({ id: 'stateful' }),
      services: [],
      nativeTools: registerTransportProbe,
      sessionMode: 'stateful',
    });
    const initialized = await stateful(rpcRequest('initialize'));
    const sessionId = initialized.headers.get('mcp-session-id');
    if (!sessionId) throw new Error('expected stateful session id');
    const statefulNames = listedToolNames(
      await rpcBody(await stateful(rpcRequest('tools/list', sessionId))),
    );

    const stateless = createMcpHandler({
      serverInfo: { name: 'native', version: '1' },
      auth: () => ({ id: 'stateless' }),
      services: [],
      nativeTools: registerTransportProbe,
      sessionMode: 'stateless',
    });
    const statelessNames = listedToolNames(
      await rpcBody(await stateless(rpcRequest('tools/list'))),
    );

    expect(directNames).toEqual(['transport_probe']);
    expect(statefulNames).toEqual(directNames);
    expect(statelessNames).toEqual(directNames);
    await directClient.close();
  });
});

describe('native call isolation and audit', () => {
  test('parallel calls keep dimensions, failures and parent trace isolated', async () => {
    const events: RequestEvent[] = [];
    const audit = createAuditHook({ write: (event) => void events.push(event) });
    const server = buildMcpServer(
      {
        serverInfo: { name: 'native', version: '1' },
        services: [],
        hooks: audit.toolCall,
        lifecycle: {
          beforeHandle: (context) => {
            const id = z.object({ id: z.string() }).parse(context.input).id;
            setRequestDimensions({ entityId: id });
          },
        },
        nativeTools: ({ registerTool }) => {
          registerTool({
            name: 'entity_action',
            description: 'Act on an entity',
            identity: {
              serviceName: 'agentTools',
              action: 'entityAction',
              scope: 'admin',
              method: 'POST',
            },
            input: z.object({ id: z.string(), fail: z.boolean() }),
            handler: async ({ input }) => {
              await new Promise((resolve) => setTimeout(resolve, input.fail ? 2 : 5));
              if (input.fail) throw new AppError('CONFLICT', `failed ${input.id}`, 409);
            },
          });
        },
      },
      undefined,
    );
    const client = await connect(server);
    const trace = createTraceContext();

    await runWithRequestContext(
      {
        trace,
        source: 'http',
        method: 'POST',
        path: '/mcp',
        startedAt: process.hrtime.bigint(),
      },
      () =>
        Promise.all([
          client.callTool({
            name: 'entity_action',
            arguments: { id: 'alpha', fail: false },
          }),
          client.callTool({
            name: 'entity_action',
            arguments: { id: 'beta', fail: true },
          }),
        ]),
    );

    expect(events).toHaveLength(2);
    expect(
      events
        .map((event) => ({
          entityId: event.dimensions?.entityId,
          ok: event.ok,
          code: event.errorCode,
          serviceName: event.serviceName,
          action: event.action,
          traceId: event.traceId,
          parentSpanId: event.parentSpanId,
        }))
        .sort((a, b) => String(a.entityId).localeCompare(String(b.entityId))),
    ).toEqual([
      {
        entityId: 'alpha',
        ok: true,
        code: undefined,
        serviceName: 'agentTools',
        action: 'entityAction',
        traceId: trace.traceId,
        parentSpanId: trace.spanId,
      },
      {
        entityId: 'beta',
        ok: false,
        code: 'CONFLICT',
        serviceName: 'agentTools',
        action: 'entityAction',
        traceId: trace.traceId,
        parentSpanId: trace.spanId,
      },
    ]);
    await client.close();
  });
});

describe('raw native escape hatch', () => {
  test('is visibly outside lifecycle and hooks', async () => {
    let protectedCalls = 0;
    const server = buildMcpServer(
      {
        serverInfo: { name: 'native', version: '1' },
        services: [],
        lifecycle: {
          beforeHandle: () => {
            protectedCalls += 1;
          },
        },
        nativeTools: ({ rawServer }) => {
          rawServer.registerTool(
            'raw_ping',
            { description: 'Raw ping', inputSchema: {} },
            async () => ({ content: [{ type: 'text', text: 'pong' }] }),
          );
        },
      },
      undefined,
    );
    const client = await connect(server);

    const result = await client.callTool({ name: 'raw_ping', arguments: {} });

    expect(result.content).toEqual([{ type: 'text', text: 'pong' }]);
    expect(protectedCalls).toBe(0);
    await client.close();
  });
});
