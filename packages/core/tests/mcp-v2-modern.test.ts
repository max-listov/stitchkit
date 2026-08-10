import { describe, expect, test } from 'bun:test';
import type { CallToolResult } from '@modelcontextprotocol/server';
import { z } from 'zod';
import { defineContract } from '../src/contract';
import {
  createObservability,
  createTraceContext,
  getRequestContext,
  getTraceId,
  type RequestEvent,
  runWithRequestContext,
} from '../src/observability';
import { createImplement } from '../src/server/implement';
import { RESOURCE_MIME_TYPE } from '../src/tools/mcp-app';
import { createMcpHandler } from '../src/tools/mcp-handler';
import { defineRuntimeTool } from '../src/tools/runtime-tool';

const MODERN = '2026-07-28';
const ENVELOPE = {
  'io.modelcontextprotocol/protocolVersion': MODERN,
  'io.modelcontextprotocol/clientInfo': { name: 'stitchkit-test', version: '1' },
  'io.modelcontextprotocol/clientCapabilities': {},
};

function modernRequest(
  method: string,
  params: Record<string, unknown>,
  headers: Record<string, string> = {},
  meta: Record<string, unknown> = {},
): Request {
  return new Request('http://localhost/mcp', {
    method: 'POST',
    headers: {
      accept: 'application/json, text/event-stream',
      'content-type': 'application/json',
      'mcp-protocol-version': MODERN,
      'mcp-method': method,
      host: 'localhost',
      ...headers,
    },
    body: JSON.stringify({
      jsonrpc: '2.0',
      id: 1,
      method,
      params: { ...params, _meta: { ...ENVELOPE, ...meta } },
    }),
  });
}

function legacyRequest(method: string, params: Record<string, unknown>): Request {
  return new Request('http://localhost/mcp', {
    method: 'POST',
    headers: {
      accept: 'application/json, text/event-stream',
      'content-type': 'application/json',
      host: 'localhost',
    },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }),
  });
}

async function json(response: Response): Promise<Record<string, unknown>> {
  return z.record(z.string(), z.unknown()).parse(await response.json());
}

async function legacyJson(response: Response): Promise<Record<string, unknown>> {
  const text = await response.text();
  const payload = text
    .split('\n')
    .find((line) => line.startsWith('data: '))
    ?.slice('data: '.length);
  return z.record(z.string(), z.unknown()).parse(JSON.parse(payload ?? text));
}

const contract = defineContract(
  { prefix: 'modern', scope: 'public' },
  {
    echo: {
      method: 'POST',
      path: '/echo',
      desc: 'Echo a routed value',
      expose: ['MCP'],
      input: z.object({
        text: z.string(),
        region: z.string().meta({ 'x-mcp-header': 'Region' }),
      }),
      output: z.object({ text: z.string(), region: z.string() }),
    },
  },
);

const implement = createImplement();
const service = implement(contract, {
  echo: ({ input }) => input,
});

describe('MCP 2026-07-28 wire semantics', () => {
  test('serves modern discovery and deterministic cacheable tool lists', async () => {
    const handler = createMcpHandler({
      serverInfo: { name: 'modern-test', version: '1' },
      auth: () => ({}),
      services: [service],
      cache: { operations: { 'tools/list': { ttlMs: 60_000, cacheScope: 'private' } } },
    });

    const discover = await handler.fetch(modernRequest('server/discover', {}));
    expect(discover.status).toBe(200);
    const discoverBody = await json(discover);
    expect(discoverBody.result).toBeDefined();

    const first = await handler.fetch(modernRequest('tools/list', {}));
    const second = await handler.fetch(modernRequest('tools/list', {}));
    expect(first.status).toBe(200);
    expect(second.status).toBe(200);
    const firstResult = z
      .object({
        tools: z.array(z.object({ name: z.string() })),
        ttlMs: z.number(),
        cacheScope: z.string(),
      })
      .parse((await json(first)).result);
    const secondResult = z
      .object({
        tools: z.array(z.object({ name: z.string() })),
        ttlMs: z.number(),
        cacheScope: z.string(),
      })
      .parse((await json(second)).result);
    expect(firstResult.tools.map((tool) => tool.name)).toEqual(['echo_modern']);
    expect(secondResult.tools.map((tool) => tool.name)).toEqual(['echo_modern']);
    expect(firstResult.ttlMs).toBe(60_000);
    expect(firstResult.cacheScope).toBe('private');
    await handler.close();
  });

  test('publishes zero/private cache metadata when no operation override is declared', async () => {
    const handler = createMcpHandler({
      serverInfo: { name: 'modern-test', version: '1' },
      auth: () => ({}),
      services: [service],
    });
    const response = await handler.fetch(modernRequest('tools/list', {}));
    const listed = z
      .object({ ttlMs: z.number(), cacheScope: z.string() })
      .parse((await json(response)).result);
    expect(listed).toEqual({ ttlMs: 0, cacheScope: 'private' });
    await handler.close();
  });

  test('publishes and returns every declared JSON output without a framework wrapper', async () => {
    const jsonContract = defineContract(
      { prefix: 'json', scope: 'public' },
      {
        array: {
          method: 'GET',
          path: '/array',
          desc: 'Return an array',
          expose: ['MCP'],
          output: z.array(z.string()),
        },
        string: {
          method: 'GET',
          path: '/string',
          desc: 'Return a string',
          expose: ['MCP'],
          output: z.string(),
        },
        number: {
          method: 'GET',
          path: '/number',
          desc: 'Return a number',
          expose: ['MCP'],
          output: z.number(),
        },
        boolean: {
          method: 'GET',
          path: '/boolean',
          desc: 'Return a boolean',
          expose: ['MCP'],
          output: z.boolean(),
        },
        nullable: {
          method: 'GET',
          path: '/nullable',
          desc: 'Return null',
          expose: ['MCP'],
          output: z.string().nullable(),
        },
        empty: {
          method: 'POST',
          path: '/empty',
          desc: 'Return no output',
          expose: ['MCP'],
        },
      },
    );
    const jsonService = implement(jsonContract, {
      array: () => ['one', 'two'],
      string: () => '',
      number: () => 0,
      boolean: () => false,
      nullable: () => null,
      empty: () => undefined,
    });
    const runtimeArray = defineRuntimeTool({
      name: 'runtime_array',
      description: 'Return a runtime array',
      identity: { serviceName: 'json', action: 'runtimeArray', method: 'GET' },
      input: z.object({}),
      output: z.array(z.number()),
      handler: () => [1, 2],
    });
    const handler = createMcpHandler({
      serverInfo: { name: 'modern-json-test', version: '1' },
      auth: () => ({}),
      services: [jsonService],
      runtimeTools: [runtimeArray],
    });

    const listedBody = await json(await handler.fetch(modernRequest('tools/list', {})));
    const listed = z
      .object({
        tools: z.array(
          z.object({
            name: z.string(),
            outputSchema: z.record(z.string(), z.unknown()).optional(),
          }),
        ),
      })
      .parse(listedBody.result);
    const schemas = new Map(listed.tools.map((tool) => [tool.name, tool.outputSchema]));
    expect(schemas.get('array_json')).toMatchObject({ type: 'array' });
    expect(schemas.get('array_json')).not.toHaveProperty('properties.result');
    expect(schemas.get('string_json')).toMatchObject({ type: 'string' });
    expect(schemas.get('empty_json')).toBeUndefined();
    expect(schemas.get('runtime_array')).toMatchObject({ type: 'array' });

    const expected = new Map<string, unknown>([
      ['array_json', ['one', 'two']],
      ['string_json', ''],
      ['number_json', 0],
      ['boolean_json', false],
      ['nullable_json', null],
      ['runtime_array', [1, 2]],
    ]);
    for (const [name, value] of expected) {
      const body = await json(
        await handler.fetch(
          modernRequest('tools/call', { name, arguments: {} }, { 'mcp-name': name }),
        ),
      );
      const result = z
        .object({
          content: z.array(z.object({ type: z.string(), text: z.string() })),
          structuredContent: z.unknown(),
        })
        .parse(body.result);
      expect(result.structuredContent).toEqual(value);
      expect(JSON.parse(result.content[0]?.text ?? 'null')).toEqual(value);
    }

    const emptyBody = await json(
      await handler.fetch(
        modernRequest(
          'tools/call',
          { name: 'empty_json', arguments: {} },
          { 'mcp-name': 'empty_json' },
        ),
      ),
    );
    const emptyResult = z
      .object({ content: z.array(z.unknown()), structuredContent: z.unknown().optional() })
      .parse(emptyBody.result);
    expect(emptyResult.content).toEqual([]);
    expect(emptyResult.structuredContent).toBeUndefined();
    await handler.close();
  });

  test('serves MCP Apps metadata and HTML resources over modern HTTP', async () => {
    const resourceUri = 'ui://modern/widget.html';
    const appContract = defineContract(
      { prefix: 'app', scope: 'public' },
      {
        show: {
          method: 'GET',
          path: '/show',
          desc: 'Show a modern widget',
          expose: ['MCP'],
          output: z.object({ visible: z.boolean() }),
          ui: { resourceUri },
        },
      },
    );
    const appService = implement(appContract, { show: () => ({ visible: true }) });
    const handler = createMcpHandler({
      serverInfo: { name: 'modern-app-test', version: '1' },
      auth: () => ({}),
      services: [appService],
      resources: [
        {
          uri: resourceUri,
          name: 'Modern widget',
          ui: { csp: { resourceDomains: ['https://cdn.example'] } },
          read: () => '<!doctype html><main>Modern app</main>',
        },
      ],
    });

    const toolsBody = await json(await handler.fetch(modernRequest('tools/list', {})));
    expect(toolsBody.error).toBeUndefined();
    const tools = z
      .object({
        tools: z.array(
          z.object({ name: z.string(), _meta: z.record(z.string(), z.unknown()).optional() }),
        ),
      })
      .parse(toolsBody.result);
    expect(tools.tools[0]?._meta?.ui).toEqual({ resourceUri });

    const calledBody = await json(
      await handler.fetch(
        modernRequest(
          'tools/call',
          { name: 'show_app', arguments: {} },
          { 'mcp-name': 'show_app' },
        ),
      ),
    );
    const called = z
      .object({
        content: z.array(z.object({ type: z.string(), text: z.string().optional() })),
        structuredContent: z.object({ visible: z.boolean() }),
      })
      .parse(calledBody.result);
    expect(called.structuredContent).toEqual({ visible: true });
    expect(called.content[0]?.text).toContain('visible');

    const resourcesBody = await json(await handler.fetch(modernRequest('resources/list', {})));
    expect(resourcesBody.error).toBeUndefined();
    const resources = z
      .object({
        resources: z.array(z.object({ uri: z.string(), mimeType: z.string().optional() })),
      })
      .parse(resourcesBody.result);
    expect(resources.resources).toContainEqual({
      uri: resourceUri,
      mimeType: RESOURCE_MIME_TYPE,
    });

    const readBody = await json(
      await handler.fetch(
        modernRequest('resources/read', { uri: resourceUri }, { 'mcp-name': resourceUri }),
      ),
    );
    expect(readBody.error).toBeUndefined();
    const read = z
      .object({
        contents: z.array(
          z.object({
            uri: z.string(),
            mimeType: z.string().optional(),
            text: z.string().optional(),
            _meta: z.record(z.string(), z.unknown()).optional(),
          }),
        ),
      })
      .parse(readBody.result);
    expect(read.contents[0]).toMatchObject({
      uri: resourceUri,
      mimeType: RESOURCE_MIME_TYPE,
      text: '<!doctype html><main>Modern app</main>',
      _meta: { ui: { csp: { resourceDomains: ['https://cdn.example'] } } },
    });
    await handler.close();
  });

  test('preserves MCP Apps tool/resource semantics on legacy-stateless HTTP', async () => {
    const resourceUri = 'ui://legacy/widget.html';
    const appContract = defineContract(
      { prefix: 'legacy-app', scope: 'public' },
      {
        show: {
          method: 'GET',
          path: '/show',
          desc: 'Show a legacy widget',
          expose: ['MCP'],
          output: z.object({ visible: z.boolean() }),
          ui: { resourceUri },
        },
      },
    );
    const appService = implement(appContract, { show: () => ({ visible: true }) });
    const handler = createMcpHandler({
      serverInfo: { name: 'legacy-app-test', version: '1' },
      auth: () => ({}),
      services: [appService],
      resources: [
        {
          uri: resourceUri,
          name: 'Legacy widget',
          ui: { prefersBorder: true },
          read: () => '<!doctype html><main>Legacy app</main>',
        },
      ],
    });

    const listedTools = await legacyJson(await handler.fetch(legacyRequest('tools/list', {})));
    expect(JSON.stringify(listedTools)).toContain(resourceUri);
    const called = await legacyJson(
      await handler.fetch(
        legacyRequest('tools/call', { name: 'show_legacy_app', arguments: {} }),
      ),
    );
    expect(JSON.stringify(called)).toContain('visible');

    const listedResources = await legacyJson(
      await handler.fetch(legacyRequest('resources/list', {})),
    );
    expect(JSON.stringify(listedResources)).toContain(RESOURCE_MIME_TYPE);
    const read = await legacyJson(
      await handler.fetch(legacyRequest('resources/read', { uri: resourceUri })),
    );
    expect(JSON.stringify(read)).toContain('Legacy app');
    expect(JSON.stringify(read)).toContain('prefersBorder');
    await handler.close();
  });

  test('routes declared Mcp-Param headers and rejects a header/body mismatch before execution', async () => {
    let calls = 0;
    let lifecycleCalls = 0;
    const routedService = implement(contract, {
      echo: ({ input }) => {
        calls += 1;
        return input;
      },
    });
    const handler = createMcpHandler({
      serverInfo: { name: 'modern-test', version: '1' },
      auth: () => ({}),
      services: [routedService],
      lifecycle: {
        beforeHandle: () => {
          lifecycleCalls += 1;
        },
      },
    });

    const mismatch = await handler.fetch(
      modernRequest(
        'tools/call',
        { name: 'echo_modern', arguments: { text: 'hello', region: 'body' } },
        { 'mcp-name': 'echo_modern', 'mcp-param-region': 'header' },
      ),
    );
    expect(mismatch.status).toBe(400);
    const error = z.object({ code: z.number() }).parse((await json(mismatch)).error);
    expect(error.code).toBe(-32_020);
    expect(calls).toBe(0);
    expect(lifecycleCalls).toBe(0);

    const valid = await handler.fetch(
      modernRequest(
        'tools/call',
        { name: 'echo_modern', arguments: { text: 'hello', region: 'header' } },
        { 'mcp-name': 'echo_modern', 'mcp-param-region': 'header' },
      ),
    );
    expect(valid.status).toBe(200);
    const result = z
      .object({ structuredContent: z.object({ text: z.string(), region: z.string() }) })
      .parse((await json(valid)).result);
    expect(result.structuredContent).toEqual({ text: 'hello', region: 'header' });
    expect(calls).toBe(1);
    expect(lifecycleCalls).toBe(1);
    await handler.close();
  });

  test('emits validated modern client attribution on the tool event', async () => {
    const events: RequestEvent[] = [];
    const observability = createObservability({
      tools: { write: (event) => void events.push(event) },
    });
    const handler = createMcpHandler({
      serverInfo: { name: 'modern-test', version: '1' },
      auth: () => ({}),
      services: [service],
      hooks: observability.toolCall,
    });
    const response = await handler.fetch(
      modernRequest(
        'tools/call',
        { name: 'echo_modern', arguments: { text: 'hello', region: 'header' } },
        { 'mcp-name': 'echo_modern', 'mcp-param-region': 'header' },
      ),
    );
    expect(response.status).toBe(200);
    await Bun.sleep(10);
    expect(events).toHaveLength(1);
    expect(events[0]?.mcp).toEqual({
      era: 'modern',
      method: 'tools/call',
      toolName: 'echo_modern',
      protocolVersion: MODERN,
      clientInfo: { name: 'stitchkit-test', version: '1' },
    });
    await handler.close();
  });

  test('continues MCP trace metadata through handler, hooks and audit', async () => {
    const observed: Array<{ phase: string; traceId?: string }> = [];
    const events: RequestEvent[] = [];
    const observability = createObservability({
      tools: { write: (event) => void events.push(event) },
    });
    const traceContract = defineContract(
      { prefix: 'trace', scope: 'public' },
      {
        inspect: {
          method: 'GET',
          path: '/inspect',
          desc: 'Inspect MCP propagation context',
          expose: ['MCP'],
          output: z.object({
            traceId: z.string(),
            spanId: z.string(),
            parentSpanId: z.string().optional(),
            tracestate: z.string().optional(),
            baggage: z.string().optional(),
          }),
        },
        fail: {
          method: 'POST',
          path: '/fail',
          desc: 'Fail inside the traced MCP runner',
          expose: ['MCP'],
          output: z.object({ ok: z.boolean() }),
        },
      },
    );
    const traceService = implement(traceContract, {
      inspect: () => {
        const trace = getRequestContext()?.trace;
        if (!trace) throw new Error('missing MCP request context');
        return trace;
      },
      fail: () => {
        throw new Error('traced failure');
      },
    });
    const handler = createMcpHandler({
      serverInfo: { name: 'modern-trace-test', version: '1' },
      auth: () => ({}),
      services: [traceService],
      hooks: {
        beforeToolCall: () => void observed.push({ phase: 'before', traceId: getTraceId() }),
        onToolError: () => void observed.push({ phase: 'error', traceId: getTraceId() }),
        afterToolCall: async (options) => {
          observed.push({ phase: 'after', traceId: getTraceId() });
          await observability.toolCall.afterToolCall?.(options);
        },
      },
    });
    const inboundTraceId = '4bf92f3577b34da6a3ce929d0e0e4736';
    const inboundSpanId = '00f067aa0ba902b7';
    const ambient = createTraceContext();
    const response = await runWithRequestContext(
      {
        trace: ambient,
        source: 'http',
        method: 'POST',
        path: '/mcp',
        startedAt: process.hrtime.bigint(),
      },
      () =>
        handler.fetch(
          modernRequest(
            'tools/call',
            { name: 'inspect_trace', arguments: {} },
            { 'mcp-name': 'inspect_trace' },
            {
              traceparent: `00-${inboundTraceId}-${inboundSpanId}-01`,
              tracestate: 'vendor=opaque',
              baggage: 'region=eu,tenant=public',
            },
          ),
        ),
    );
    const body = await json(response);
    const result = z
      .object({
        structuredContent: z.object({
          traceId: z.string(),
          spanId: z.string(),
          parentSpanId: z.string().optional(),
          tracestate: z.string().optional(),
          baggage: z.string().optional(),
        }),
      })
      .parse(body.result);
    expect(result.structuredContent).toMatchObject({
      traceId: inboundTraceId,
      parentSpanId: inboundSpanId,
      tracestate: 'vendor=opaque',
      baggage: 'region=eu,tenant=public',
    });
    expect(result.structuredContent.traceId).not.toBe(ambient.traceId);
    expect(observed).toEqual([
      { phase: 'before', traceId: inboundTraceId },
      { phase: 'after', traceId: inboundTraceId },
    ]);
    await Bun.sleep(10);
    expect(events).toHaveLength(1);
    expect(events[0]?.traceId).toBe(inboundTraceId);
    expect(events[0]?.parentSpanId).toBe(result.structuredContent.spanId);
    expect(JSON.stringify(events[0])).not.toContain('tenant=public');

    const malformed = await handler.fetch(
      modernRequest(
        'tools/call',
        { name: 'inspect_trace', arguments: {} },
        { 'mcp-name': 'inspect_trace' },
        { traceparent: '00-00000000000000000000000000000000-0000000000000000-01' },
      ),
    );
    const malformedResult = z
      .object({ structuredContent: z.object({ traceId: z.string() }) })
      .parse((await json(malformed)).result);
    expect(malformedResult.structuredContent.traceId).not.toBe(inboundTraceId);
    expect(malformedResult.structuredContent.traceId).not.toMatch(/^0+$/);

    observed.length = 0;
    events.length = 0;
    const failure = await handler.fetch(
      modernRequest(
        'tools/call',
        { name: 'fail_trace', arguments: {} },
        { 'mcp-name': 'fail_trace' },
        { traceparent: `00-${inboundTraceId}-${inboundSpanId}-01` },
      ),
    );
    expect(JSON.stringify((await json(failure)).result)).toContain('INTERNAL_SERVER_ERROR');
    expect(observed).toEqual([
      { phase: 'before', traceId: inboundTraceId },
      { phase: 'error', traceId: inboundTraceId },
      { phase: 'after', traceId: inboundTraceId },
    ]);
    await Bun.sleep(10);
    expect(events[0]?.traceId).toBe(inboundTraceId);

    const parallel = await Promise.all(
      [1, 2].map(() =>
        handler.fetch(
          modernRequest(
            'tools/call',
            { name: 'inspect_trace', arguments: {} },
            { 'mcp-name': 'inspect_trace' },
            { traceparent: `00-${inboundTraceId}-${inboundSpanId}-01` },
          ),
        ),
      ),
    );
    const parallelTraces = await Promise.all(
      parallel.map(
        async (item) =>
          z
            .object({
              structuredContent: z.object({ traceId: z.string(), spanId: z.string() }),
            })
            .parse((await json(item)).result).structuredContent,
      ),
    );
    expect(parallelTraces.map((trace) => trace.traceId)).toEqual([
      inboundTraceId,
      inboundTraceId,
    ]);
    expect(parallelTraces[0]?.spanId).not.toBe(parallelTraces[1]?.spanId);
    await handler.close();
  });

  test('rejects subscriptions and exposes the rejection observer', async () => {
    const statuses: number[] = [];
    const handler = createMcpHandler({
      serverInfo: { name: 'modern-test', version: '1' },
      auth: () => ({}),
      services: [service],
      onTransportRejected: ({ response }) => void statuses.push(response.status),
    });
    const response = await handler.fetch(modernRequest('subscriptions/listen', {}));
    expect(response.status).toBe(200);
    const body = await json(response);
    expect(z.object({ code: z.number() }).parse(body.error).code).toBe(-32_603);
    expect(statuses).toEqual([]);

    const mismatch = await handler.fetch(
      modernRequest(
        'tools/call',
        { name: 'echo_modern', arguments: { text: 'hello', region: 'body' } },
        { 'mcp-name': 'echo_modern', 'mcp-param-region': 'header' },
      ),
    );
    expect(mismatch.status).toBe(400);
    await Bun.sleep(10);
    expect(statuses).toEqual([400]);
    await handler.close();
  });

  test('keeps raw multimodal tool output on the modern wire', async () => {
    const handler = createMcpHandler({
      serverInfo: { name: 'modern-test', version: '1' },
      auth: () => ({}),
      services: [],
      rawTools: (server) => {
        server.registerTool('preview', { inputSchema: z.object({}) }, async () => {
          const result: CallToolResult = {
            content: [
              { type: 'text', text: 'preview' },
              { type: 'image', data: 'aGVsbG8=', mimeType: 'image/png' },
            ],
          };
          return result;
        });
      },
    });
    const response = await handler.fetch(
      modernRequest(
        'tools/call',
        { name: 'preview', arguments: {} },
        { 'mcp-name': 'preview' },
      ),
    );
    const result = z
      .object({ content: z.array(z.object({ type: z.string() })) })
      .parse((await json(response)).result);
    expect(result.content.map((part) => part.type)).toEqual(['text', 'image']);
    await handler.close();
  });

  test('close is idempotent and refuses later requests', async () => {
    const handler = createMcpHandler({
      serverInfo: { name: 'modern-test', version: '1' },
      auth: () => ({}),
      services: [service],
    });
    await handler.close();
    await handler.close();
    const response = await handler.fetch(modernRequest('tools/list', {}));
    expect(response.status).toBe(503);
  });

  test('close propagates cancellation into an in-flight framework handler', async () => {
    let releaseStarted: (() => void) | undefined;
    const started = new Promise<void>((resolve) => {
      releaseStarted = resolve;
    });
    let aborted = false;
    const slow = defineRuntimeTool({
      name: 'slow_operation',
      description: 'Wait until transport cancellation',
      identity: { serviceName: 'modern', action: 'slow', method: 'POST' },
      input: z.object({}),
      output: z.object({ aborted: z.boolean() }),
      handler: async (context) => {
        if (!context.signal) throw new Error('MCP cancellation signal is required');
        releaseStarted?.();
        await new Promise<void>((resolve) => {
          context.signal?.addEventListener(
            'abort',
            () => {
              aborted = true;
              resolve();
            },
            { once: true },
          );
        });
        return { aborted };
      },
    });
    const handler = createMcpHandler({
      serverInfo: { name: 'modern-test', version: '1' },
      auth: () => ({}),
      services: [],
      runtimeTools: [slow],
    });
    const pending = handler.fetch(
      modernRequest(
        'tools/call',
        { name: 'slow_operation', arguments: {} },
        { 'mcp-name': 'slow_operation' },
      ),
    );
    await started;
    await handler.close();
    await pending.catch(() => undefined);
    expect(aborted).toBe(true);
  });
});
