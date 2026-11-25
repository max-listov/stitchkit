import { afterEach, describe, expect, test } from 'bun:test';
import { z } from 'zod';
import { AppError, defineContract } from '../src/entrypoints/contract';
import { isAgentToolError } from '../src/entrypoints/tools';
import {
  ConnectionBudgetExceededError,
  defineMcpClientConnection,
  type McpConnectionCatalogEntry,
  type McpConnectionCatalogStore,
  mountConnections,
  type SkippedConnectionTool,
} from '../src/entrypoints/tools/connections';
import { createMcpHandler } from '../src/entrypoints/tools/mcp';
import { isRecord } from '../src/internal/typed';
import { createImplement } from '../src/server/implement';
import {
  type FakeMcpTool,
  type McpCallEnvelope,
  mountOperationOrigins,
  type OperationOrigin,
  startMcp,
} from './support/operation-origins';
import {
  ALL_RESULT_TRANSPORTS,
  openTransportHarness,
  type ResultTransport,
  type TransportHarness,
} from './support/operation-transports';

const stops: Array<() => Promise<void>> = [];
afterEach(async () => {
  await Promise.all(stops.splice(0).map((stop) => stop()));
});

async function mountFakeMcpHarness(
  name: string,
  tools: readonly (FakeMcpTool | Record<string, unknown>)[],
  envelope?: McpCallEnvelope,
): Promise<{ harness: TransportHarness; skipped: SkippedConnectionTool[] }> {
  const server = startMcp(tools, envelope);
  stops.push(server.stop);
  const skipped: SkippedConnectionTool[] = [];
  const runtimeTools = await mountConnections(
    [
      defineMcpClientConnection({
        name,
        transport: { url: server.url },
        expose: ['CLI', 'MCP', 'AGENT'],
      }),
    ],
    { onSkippedTool: (entry) => skipped.push(entry) },
  );
  const harness = await openTransportHarness({ runtimeTools });
  stops.push(harness.close);
  return { harness, skipped };
}

async function expectStructuredOnTransports(
  harness: TransportHarness,
  call: { name: string; args?: Record<string, unknown> },
  expected: Record<string, unknown>,
  transports: readonly ResultTransport[] = ALL_RESULT_TRANSPORTS,
): Promise<void> {
  for (const transport of transports) {
    const result = await harness.invoke(transport, call);
    if (result.transport === 'agent') {
      expect(result.output).toEqual(expected);
    } else if (result.transport === 'mcp-structured') {
      expect(result.isError).toBe(false);
      expect(result.structuredContent).toEqual(expected);
    } else if (result.transport === 'mcp-content') {
      expect(result.isError).toBe(false);
      expect(Array.isArray(result.content)).toBe(true);
      const first = Array.isArray(result.content) ? result.content[0] : undefined;
      expect(
        isRecord(first) && typeof first.text === 'string' && JSON.parse(first.text),
      ).toEqual(expected);
    } else {
      expect(result.code).toBe(0);
      expect(JSON.parse(result.out)).toEqual(expected);
    }
  }
}

async function expectErrorOnTransports(
  harness: TransportHarness,
  call: { name: string; args?: Record<string, unknown> },
  expected: { code: string; status?: number; noMcpStructuredContent?: boolean },
): Promise<void> {
  let agentError: unknown;
  try {
    await harness.invoke('agent', call);
  } catch (error) {
    agentError = error;
  }
  expect(isAgentToolError(agentError)).toBe(true);
  if (isAgentToolError(agentError)) {
    expect(agentError.output.error).toBe(expected.code);
    if (expected.status !== undefined) {
      const cause: unknown = agentError.cause;
      expect(cause).toBeInstanceOf(AppError);
      if (cause instanceof AppError) {
        expect(cause.code).toBe(expected.code);
        expect(cause.status).toBe(expected.status);
      }
    }
  }

  const mcpResult = await harness.invoke('mcp-content', call);
  expect(mcpResult.transport).toBe('mcp-content');
  if (mcpResult.transport === 'mcp-content') {
    expect(mcpResult.isError).toBe(true);
    if (expected.noMcpStructuredContent) {
      expect(mcpResult.rawResult.structuredContent).toBeUndefined();
    }
    const first = Array.isArray(mcpResult.content) ? mcpResult.content[0] : undefined;
    expect(
      isRecord(first) && typeof first.text === 'string' && JSON.parse(first.text),
    ).toMatchObject({ error: expected.code });
  }

  const cliResult = await harness.invoke('cli', call);
  expect(cliResult.transport).toBe('cli');
  if (cliResult.transport === 'cli') {
    expect(cliResult.code).not.toBe(0);
    expect(JSON.parse(cliResult.err)).toMatchObject({ error: expected.code });
  }
}

describe('discovered MCP tool with outputSchema returns validated structuredContent', () => {
  test('origin x transport matrix returns structuredContent on MCP, AGENT, and CLI (live and cached)', async () => {
    const mounted = await mountOperationOrigins({
      serviceName: 'items',
      origins: ['discovered-mcp', 'managed-cli-catalog'],
      specs: [
        {
          name: 'get_item',
          description: 'Fetch one item',
          method: 'GET',
          input: z.object({ id: z.string() }),
          output: z.object({
            id: z.string(),
            status: z.enum(['active', 'archived']),
            count: z.number(),
          }),
          handler: (input) => ({ id: String(input.id), status: 'active', count: 3 }),
        },
      ],
    });
    stops.push(mounted.close);

    for (const origin of [
      'discovered-mcp',
      'managed-cli-catalog',
    ] as const satisfies readonly OperationOrigin[]) {
      const surface = mounted.byOrigin.get(origin);
      if (!surface) throw new Error(`missing mounted origin ${origin}`);
      if (origin === 'managed-cli-catalog') expect(surface.catalogCacheHit).toBe(true);
      const harness = await openTransportHarness(surface);
      stops.push(harness.close);
      await expectStructuredOnTransports(
        harness,
        { name: surface.commandName('get_item'), args: { id: 'it-42' } },
        { id: 'it-42', status: 'active', count: 3 },
      );
    }
  });

  test('declared outputSchema without structuredContent fails with MCP_STRUCTURED_CONTENT_MISSING (502) across transports', async () => {
    const { harness } = await mountFakeMcpHarness(
      'remote',
      [
        {
          name: 'broken_structured',
          description: 'Declares outputSchema but omits structuredContent',
          inputSchema: {
            type: 'object',
            properties: { id: { type: 'string' } },
            required: ['id'],
          },
          outputSchema: {
            type: 'object',
            properties: { id: { type: 'string' }, ok: { type: 'boolean' } },
            required: ['id', 'ok'],
          },
        },
      ],
      () => ({ content: [{ type: 'text', text: JSON.stringify({ id: 'x', ok: true }) }] }),
    );
    await expectErrorOnTransports(
      harness,
      { name: 'broken_structured', args: { id: 'x' } },
      { code: 'MCP_STRUCTURED_CONTENT_MISSING', status: 502 },
    );
  });

  test('isError response with declared outputSchema relays upstream error instead of MCP_STRUCTURED_CONTENT_MISSING', async () => {
    const { harness } = await mountFakeMcpHarness(
      'errsrv',
      [
        {
          name: 'failing_structured',
          description: 'Declares outputSchema and returns isError without structuredContent',
          inputSchema: { type: 'object', properties: {} },
          outputSchema: {
            type: 'object',
            properties: { id: { type: 'string' } },
            required: ['id'],
          },
        },
      ],
      () => ({
        isError: true,
        content: [
          { type: 'text', text: JSON.stringify({ error: 'NOT_FOUND', retryable: false }) },
        ],
      }),
    );
    await expectErrorOnTransports(
      harness,
      { name: 'failing_structured', args: {} },
      { code: 'NOT_FOUND', status: 502 },
    );
  });

  test('structuredContent violating declared outputSchema fails output validation on AGENT, MCP, and CLI', async () => {
    const { harness } = await mountFakeMcpHarness(
      'badshape',
      [
        {
          name: 'invalid_shape',
          description: 'Returns structuredContent violating outputSchema',
          inputSchema: { type: 'object', properties: {} },
          outputSchema: {
            type: 'object',
            properties: { id: { type: 'string' }, count: { type: 'number' } },
            required: ['id', 'count'],
          },
        },
      ],
      () => ({
        content: [{ type: 'text', text: '{"id":123}' }],
        structuredContent: { id: 123 },
      }),
    );
    await expectErrorOnTransports(
      harness,
      { name: 'invalid_shape', args: {} },
      { code: 'INTERNAL_SERVER_ERROR', noMcpStructuredContent: true },
    );
  });

  test('object outputSchemas compiled to ZodPipe/ZodIntersection (z.record, minProperties, allOf) mount and return structuredContent', async () => {
    const mounted = await mountOperationOrigins({
      serviceName: 'records',
      origins: ['discovered-mcp'],
      specs: [
        {
          name: 'score_map',
          description: 'Return string-to-number map',
          method: 'GET',
          input: z.object({}),
          output: z.record(z.string(), z.number()),
          handler: () => ({ alpha: 1, beta: 2 }),
        },
      ],
    });
    stops.push(mounted.close);
    const recordSurface = mounted.byOrigin.get('discovered-mcp');
    if (!recordSurface) throw new Error('missing discovered-mcp origin');
    const recordHarness = await openTransportHarness(recordSurface);
    stops.push(recordHarness.close);
    await expectStructuredOnTransports(
      recordHarness,
      { name: 'score_map', args: {} },
      { alpha: 1, beta: 2 },
      ['agent', 'mcp-structured', 'cli'],
    );

    const { harness, skipped } = await mountFakeMcpHarness(
      'complex',
      [
        {
          name: 'min_props',
          description: 'Object with minProperties',
          inputSchema: { type: 'object', properties: {} },
          outputSchema: {
            type: 'object',
            properties: { a: { type: 'string' } },
            minProperties: 1,
          },
        },
        {
          name: 'all_of_obj',
          description: 'Object composed via allOf',
          inputSchema: { type: 'object', properties: {} },
          outputSchema: {
            allOf: [
              { type: 'object', properties: { a: { type: 'string' } }, required: ['a'] },
              { type: 'object', properties: { b: { type: 'number' } }, required: ['b'] },
            ],
          },
        },
      ],
      (_args, name) =>
        name === 'min_props'
          ? { content: [{ type: 'text', text: '{"a":"ok"}' }], structuredContent: { a: 'ok' } }
          : {
              content: [{ type: 'text', text: '{"a":"x","b":2}' }],
              structuredContent: { a: 'x', b: 2 },
            },
    );
    expect(skipped).toEqual([]);
    await expectStructuredOnTransports(harness, { name: 'min_props', args: {} }, { a: 'ok' }, [
      'agent',
      'mcp-structured',
      'cli',
    ]);
    await expectStructuredOnTransports(
      harness,
      { name: 'all_of_obj', args: {} },
      { a: 'x', b: 2 },
      ['agent', 'mcp-structured', 'cli'],
    );
  });

  test('maxSchemaBytes budget accounts for outputSchema bytes', async () => {
    const inputSchema = { type: 'object', properties: { q: { type: 'string' } } };
    const outputSchema = {
      type: 'object',
      properties: { summary: { type: 'string', description: 'a'.repeat(400) } },
      required: ['summary'],
    };
    const totalBytes =
      new TextEncoder().encode(JSON.stringify(inputSchema)).byteLength +
      new TextEncoder().encode(JSON.stringify(outputSchema)).byteLength;
    const server = startMcp([
      { name: 'big_out', description: 'Large outputSchema', inputSchema, outputSchema },
    ]);
    stops.push(server.stop);
    const conn = defineMcpClientConnection({
      name: 'budgeted',
      transport: { url: server.url },
    });

    await expect(
      mountConnections([conn], { budget: { maxSchemaBytes: totalBytes - 1 } }),
    ).rejects.toBeInstanceOf(ConnectionBudgetExceededError);
    const mounted = await mountConnections([conn], { budget: { maxSchemaBytes: totalBytes } });
    expect(mounted.map((tool) => tool.name)).toEqual(['big_out']);
  });

  test('catalog cache stores and restores outputSchema without a second tools/list', async () => {
    const implement = createImplement();
    const contract = defineContract(
      { prefix: 'cached', scope: 'public' },
      {
        lookup: {
          method: 'GET',
          path: '/lookup',
          desc: 'Lookup cached item',
          expose: ['MCP'],
          input: z.object({ id: z.string() }),
          output: z.object({ id: z.string(), label: z.string() }),
        },
      },
    );
    const handler = createMcpHandler({
      access: { open: 'local-operator' },
      serverInfo: { name: 'cached-srv', version: '1.0.0' },
      security: { allowedHosts: ['127.0.0.1', 'localhost'] },
      auth: () => ({}),
      services: [
        implement(contract, {
          lookup: ({ input }) => ({ id: input.id, label: `label-${input.id}` }),
        }),
      ],
    });
    let listCalls = 0;
    const server = Bun.serve({
      port: 0,
      hostname: '127.0.0.1',
      fetch: async (req) => {
        const text = await req.text();
        const body: unknown = text ? JSON.parse(text) : null;
        if (isRecord(body) && body.method === 'tools/list') listCalls += 1;
        return handler.fetch(
          new Request(req.url, { method: req.method, headers: req.headers, body: text }),
        );
      },
    });
    stops.push(async () => {
      await server.stop(true);
      await handler.close();
    });

    let stored: McpConnectionCatalogEntry | undefined;
    const catalog: McpConnectionCatalogStore = {
      load: () => stored,
      store: (entry) => {
        stored = JSON.parse(JSON.stringify(entry));
      },
    };
    const conn = defineMcpClientConnection({
      name: 'cached',
      transport: { url: `http://127.0.0.1:${server.port}/mcp` },
      catalog,
      expose: ['CLI', 'MCP', 'AGENT'],
    });

    await mountConnections([conn]);
    expect(listCalls).toBe(1);
    const cachedTools = await mountConnections([conn]);
    expect(listCalls).toBe(1);

    const harness = await openTransportHarness({ runtimeTools: cachedTools });
    stops.push(harness.close);
    await expectStructuredOnTransports(
      harness,
      { name: 'lookup_cached', args: { id: '7' } },
      { id: '7', label: 'label-7' },
      ['agent'],
    );
  });

  test('non-object, empty, malformed, or refused-keyword outputSchema is skipped via onSkippedTool with reason', async () => {
    const server = startMcp([
      {
        name: 'non_object_output',
        inputSchema: { type: 'object', properties: {} },
        outputSchema: { type: 'string' },
      },
      {
        name: 'empty_output',
        inputSchema: { type: 'object', properties: {} },
        outputSchema: {},
      },
      {
        name: 'unknown_keyword_output',
        inputSchema: { type: 'object', properties: {} },
        outputSchema: { type: 'object', bogusKeyword: true },
      },
      {
        name: 'non_record_output',
        inputSchema: { type: 'object', properties: {} },
        outputSchema: 'string',
      },
      {
        name: 'refused_keyword_output',
        inputSchema: { type: 'object', properties: {} },
        outputSchema: { type: 'object', $dynamicRef: '#meta' },
      },
      {
        name: 'valid_tool',
        inputSchema: { type: 'object', properties: {} },
        outputSchema: {
          type: 'object',
          properties: { ok: { type: 'boolean' } },
          required: ['ok'],
        },
      },
    ]);
    stops.push(server.stop);

    const skipped: SkippedConnectionTool[] = [];
    const mounted = await mountConnections(
      [defineMcpClientConnection({ name: 'mixed', transport: { url: server.url } })],
      { onSkippedTool: (entry) => skipped.push(entry) },
    );
    expect(mounted.map((tool) => tool.name)).toEqual(['valid_tool']);
    const reasons = new Map(skipped.map((entry) => [entry.tool, entry.reason]));
    expect([...reasons.keys()].sort()).toEqual([
      'empty_output',
      'non_object_output',
      'non_record_output',
      'refused_keyword_output',
      'unknown_keyword_output',
    ]);
    expect(reasons.get('non_object_output')).toMatch(/object schema/i);
    expect(reasons.get('empty_output')).toMatch(/object schema/i);
    expect(reasons.get('non_record_output')).toMatch(/object/i);
    expect(reasons.get('unknown_keyword_output')).toMatch(/bogusKeyword/);
    expect(reasons.get('refused_keyword_output')).toMatch(/\$dynamicRef/);
  });

  test('server without outputSchema keeps previous behaviour on MCP, AGENT, and CLI', async () => {
    const { harness } = await mountFakeMcpHarness(
      'plain',
      [
        {
          name: 'plain_echo',
          description: 'No outputSchema declared',
          inputSchema: {
            type: 'object',
            properties: { value: { type: 'string' } },
            required: ['value'],
          },
        },
      ],
      (args) => ({ content: [{ type: 'text', text: JSON.stringify({ echoed: args }) }] }),
    );
    const expectedEnvelope = {
      content: [{ type: 'text', text: JSON.stringify({ echoed: { value: 'hi' } }) }],
    };
    for (const transport of [
      'agent',
      'mcp-structured',
      'cli',
    ] as const satisfies readonly ResultTransport[]) {
      const result = await harness.invoke(transport, {
        name: 'plain_echo',
        args: { value: 'hi' },
      });
      if (result.transport === 'agent') expect(result.output).toEqual(expectedEnvelope);
      else if (result.transport === 'mcp-structured') {
        expect(result.isError).toBe(false);
        expect(result.structuredContent).toEqual({ result: expectedEnvelope });
      } else if (result.transport === 'cli') {
        expect(result.code).toBe(0);
        expect(JSON.parse(result.out)).toEqual({ echoed: { value: 'hi' } });
      }
    }
  });
});
