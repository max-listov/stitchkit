import { afterEach, describe, expect, test } from 'bun:test';
import { Client, InMemoryTransport } from '@modelcontextprotocol/client';
import { z } from 'zod';
import {
  defineMcpClientConnection,
  mountConnections,
} from '../src/entrypoints/tools/connections';
import { isRecord } from '../src/internal/typed';
import { mountAgent } from '../src/tools/agent';
import { zodObjectFromJsonSchema } from '../src/tools/connections/runtime';
import { executeToolMethod } from '../src/tools/execute';
import { parseToolCallArguments } from '../src/tools/execute-args';
import { projectRuntimeTool } from '../src/tools/internal/surface-projector';
import { buildMcpServer } from '../src/tools/mcp/mount';
import { defineRuntimeTool, runtimeToolMountable } from '../src/tools/runtime-tool';
import { localVerdict } from '../src/tools/schema/json-schema-origin';

function failure(schema: z.ZodType, value: unknown): z.ZodError {
  const result = schema.safeParse(value);
  if (result.success) throw new Error('Expected this control to fail validation');
  return result.error;
}

function restore(schema: z.ZodObject): z.ZodObject {
  return zodObjectFromJsonSchema(z.toJSONSchema(schema));
}

test.each([
  { name: 'datetime', field: z.iso.datetime(), value: '2026-10-12' },
  { name: 'email', field: z.email(), value: 'missing-at' },
  { name: 'URL', field: z.url(), value: 'relative-path' },
  { name: 'UUID', field: z.uuid(), value: 'not-a-uuid' },
  { name: 'pattern', field: z.string().regex(/^item_[0-9]+$/), value: 'wrong' },
])('a restored $name refusal belongs to the remote', ({ field, value }) => {
  const schema = restore(z.strictObject({ value: field }));
  const error = failure(schema, { value });
  expect(error.issues.every((issue) => issue.code === 'invalid_format')).toBe(true);
  expect(localVerdict(schema, error)).toBeNull();
});

test('nested arrays, optional fields and record values leave their formats to the remote', () => {
  const schema = restore(
    z.object({
      rows: z.array(z.object({ at: z.iso.datetime().nullable() })).optional(),
      values: z.record(z.string(), z.email()),
    }),
  );
  const error = failure(schema, {
    rows: [{ at: '2026-10-12' }, { at: null }],
    values: { first: 'wrong' },
  });
  expect(error.issues.map((issue) => issue.path)).toContainEqual(['rows', 0, 'at']);
  expect(error.issues.map((issue) => issue.path)).toContainEqual(['values', 'first']);
  expect(localVerdict(schema, error)).toBeNull();
});

test('format-only record key containers belong to the remote', () => {
  const schema = restore(z.object({ values: z.record(z.email(), z.string()) }));
  const error = failure(schema, { values: { wrong: 'value' } });
  expect(error.issues.map((issue) => issue.code)).toEqual(['invalid_key']);
  expect(localVerdict(schema, error)).toBeNull();
});

test('a mixed record key retains its bounds and metadata without format children', () => {
  const schema = restore(z.object({ values: z.record(z.email().min(10), z.string()) }));
  const error = failure(schema, { values: { bad: 'value' } });
  const original = error.issues[0];
  if (original?.code !== 'invalid_key') throw new Error('Expected a record key refusal');
  const refused = localVerdict(schema, error);
  const issue = refused?.issues[0];
  if (issue?.code !== 'invalid_key') throw new Error('Expected retained key bounds');
  expect(refused).not.toBe(error);
  expect(refused?.issues).toHaveLength(1);
  expect(issue).toEqual({
    ...original,
    issues: original.issues.filter((child) => child.code === 'too_small'),
  });
  expect(issue.issues.map((child) => child.code)).toEqual(['too_small']);
  expect(original.issues.some((child) => child.code === 'invalid_format')).toBe(true);
});

test('a structural record key keeps its original error and issue identity', () => {
  const schema = restore(z.object({ values: z.record(z.string().min(10), z.number()) }));
  const error = failure(schema, { values: { short: 1 } });
  expect(error.issues[0]?.code).toBe('invalid_key');
  expect(localVerdict(schema, error)).toBe(error);
  expect(localVerdict(schema, error)?.issues[0]).toBe(error.issues[0]);
});

test('reported structural issues keep their order and paths beside format and union failures', () => {
  const schema = restore(
    z.strictObject({
      at: z.iso.datetime(),
      branch: z.union([z.string(), z.number()]),
      mode: z.enum(['safe', 'fast']),
      required: z.string(),
      rows: z.array(z.iso.datetime()),
    }),
  );
  const error = failure(schema, {
    at: '2026-10-12',
    branch: false,
    mode: 'unknown',
    rows: ['2026-10-12', 123],
    extra: true,
  });
  const expected = error.issues.filter(
    (issue) => issue.code !== 'invalid_format' && issue.code !== 'invalid_union',
  );
  expect(expected.map((issue) => issue.code)).toEqual([
    'invalid_value',
    'invalid_type',
    'invalid_type',
    'unrecognized_keys',
  ]);
  expect(localVerdict(schema, error)?.issues).toEqual(expected);
  expect(localVerdict(schema, error)?.issues.map((issue) => issue.path)).toEqual([
    ['mode'],
    ['required'],
    ['rows', 1],
    [],
  ]);
});

test('enum keys and scalar bounds remain local', () => {
  for (const [schema, value] of [
    [restore(z.object({ key: z.string().min(3) })), { key: '' }],
    [restore(z.object({ count: z.number().min(1) })), { count: 0 }],
    [
      restore(z.object({ values: z.record(z.enum(['allowed']), z.string()) })),
      { values: { extra: 'x' } },
    ],
  ] satisfies Array<[z.ZodObject, unknown]>) {
    const error = failure(schema, value);
    expect(localVerdict(schema, error)).toBe(error);
  }
});

test('an authored schema keeps its entire verdict and parses transforms once', () => {
  let transforms = 0;
  const schema = z.object({
    at: z.iso.datetime({ error: 'Use a full UTC timestamp' }),
    key: z.string(),
    count: z.number().transform((value) => {
      transforms += 1;
      return value + 1;
    }),
  });
  const args = { at: '2026-10-12', count: 1 };
  const error = failure(schema, args);
  expect(localVerdict(schema, error)).toBe(error);
  expect(error.issues.map((issue) => issue.code)).toEqual(['invalid_format', 'invalid_type']);
  transforms = 0;
  const result = parseToolCallArguments(
    {
      serviceName: 'local',
      key: 'check',
      desc: 'Check local arguments',
      method: 'POST',
      inputSchema: schema,
      handler: () => undefined,
    },
    args,
  );
  expect(result.ok).toBe(false);
  if (result.ok) throw new Error('The authored schema must refuse locally');
  expect(result.message).toContain('Use a full UTC timestamp');
  expect(result.message).toContain('key');
  expect(transforms).toBe(1);
});

test('delegation forwards coerced arguments rather than partially parsed defaults', () => {
  const schema = restore(
    z.object({ rows: z.array(z.iso.datetime()), limit: z.number().default(5) }),
  );
  const result = parseToolCallArguments(
    {
      serviceName: 'remote',
      key: 'check',
      desc: 'Check remote arguments',
      method: 'POST',
      inputSchema: schema,
      handler: () => undefined,
    },
    { rows: '["2026-10-12"]' },
    { coerceJson: true },
  );
  expect(result).toEqual({ ok: true, params: undefined, input: { rows: ['2026-10-12'] } });
});

describe('remote outputSchema verdict across executeToolMethod, mountMcp and mountAgent', () => {
  const stops: Array<() => void> = [];
  afterEach(() => {
    for (const stop of stops.splice(0)) stop();
  });

  function startRemoteMcp(structuredContent: () => Record<string, unknown>): string {
    const server = Bun.serve({
      port: 0,
      hostname: '127.0.0.1',
      fetch: async (request) => {
        if (request.method === 'GET') return new Response('', { status: 404 });
        const body = (await request.json()) as { id?: number; method: string };
        if (body.id === undefined) return new Response(null, { status: 202 });
        const result =
          body.method === 'initialize'
            ? {
                protocolVersion: '2024-11-05',
                capabilities: {},
                serverInfo: { name: 'remote-output', version: '1.0.0' },
              }
            : body.method === 'tools/list'
              ? {
                  tools: [
                    {
                      name: 'fetch_link',
                      description: 'Fetch a link with a count',
                      inputSchema: { type: 'object', properties: {} },
                      outputSchema: {
                        type: 'object',
                        properties: {
                          link: { type: 'string', format: 'uri-reference' },
                          count: { type: 'number' },
                        },
                        required: ['link', 'count'],
                      },
                    },
                  ],
                }
              : {
                  content: [{ type: 'text', text: JSON.stringify(structuredContent()) }],
                  structuredContent: structuredContent(),
                };
        return new Response(JSON.stringify({ jsonrpc: '2.0', id: body.id, result }), {
          headers: { 'content-type': 'application/json' },
        });
      },
    });
    stops.push(() => void server.stop(true));
    return `http://127.0.0.1:${server.port}/mcp`;
  }

  test('uri-reference relative path succeeds through executeToolMethod, re-exposed mountMcp, and mountAgent with presenter', async () => {
    const payload = { link: '/relative/path', count: 1 };
    const url = startRemoteMcp(() => payload);
    const tools = await mountConnections([
      defineMcpClientConnection({
        name: 'upstream',
        transport: { url },
        expose: ['MCP', 'AGENT'],
      }),
    ]);
    const discovered = tools[0];
    if (!discovered) throw new Error('Expected discovered MCP tool');

    // (a1) executeToolMethod / invokeToolHandler
    const executed = await executeToolMethod(
      runtimeToolMountable(projectRuntimeTool(discovered)).method,
      {
        toolName: discovered.name,
        rawArgs: {},
        context: { source: 'agent' },
      },
    );
    expect(executed).toEqual({ ok: true, data: payload });

    // (a2) re-exposed MCP server (real McpServer + Client over InMemoryTransport)
    const reexportServer = buildMcpServer({
      serverInfo: { name: 'reexport', version: '1.0.0' },
      access: { open: 'local-operator' },
      services: [],
      runtimeTools: [discovered],
    });
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    const client = new Client({ name: 'reexport-client', version: '1.0.0' });
    await Promise.all([
      reexportServer.connect(serverTransport),
      client.connect(clientTransport),
    ]);
    try {
      const listed = await client.listTools();
      const listedTool = listed.tools.find((entry) => entry.name === 'fetch_link');
      expect(listedTool).toBeDefined();
      const outSchema = listedTool?.outputSchema;
      if (!isRecord(outSchema) || !isRecord(outSchema.properties)) {
        throw new Error('Expected listed outputSchema with properties');
      }
      expect(outSchema.properties.link).toEqual({ type: 'string', format: 'uri-reference' });

      const called = await client.callTool({ name: 'fetch_link', arguments: {} });
      expect(called.isError).not.toBe(true);
      expect(called.structuredContent).toEqual(payload);
    } finally {
      await client.close();
    }

    // (a3) mountAgent with presenter
    const presentedTool = Object.assign({}, discovered, {
      present: {
        agent: (data: unknown) => {
          if (!isRecord(data)) throw new Error('Expected record');
          return {
            type: 'text' as const,
            value: `PRESENTED:${String(data.link)}:${String(data.count)}`,
          };
        },
      },
    });
    const agentTools = mountAgent([], {
      access: { open: 'local-operator' },
      runtimeTools: [presentedTool],
    });
    const agentTool = agentTools.fetch_link;
    if (!agentTool?.execute || !agentTool.toModelOutput) {
      throw new Error('Expected mounted agent tool with execute and toModelOutput');
    }
    const rawOutput = await agentTool.execute(
      {},
      { toolCallId: 'call-1', messages: [], context: undefined },
    );
    expect(rawOutput).toEqual(payload);
    const modelOutput = await agentTool.toModelOutput({
      toolCallId: 'call-1',
      input: {},
      output: rawOutput,
    });
    expect(modelOutput).toEqual({ type: 'text', value: 'PRESENTED:/relative/path:1' });
  });

  test('mixed uri-reference and structural output violation reports only the structural field', async () => {
    const url = startRemoteMcp(() => ({ link: '/relative/path', count: 'bad' }));
    const tools = await mountConnections([
      defineMcpClientConnection({
        name: 'upstream',
        transport: { url },
        expose: ['MCP', 'AGENT'],
      }),
    ]);
    const discovered = tools[0];
    if (!discovered) throw new Error('Expected discovered MCP tool');

    const executed = await executeToolMethod(
      runtimeToolMountable(projectRuntimeTool(discovered)).method,
      {
        toolName: discovered.name,
        rawArgs: {},
        context: { source: 'agent' },
      },
    );
    expect(executed.ok).toBe(false);
    if (executed.ok) throw new Error('Expected structural output refusal');
    expect(executed.code).toBe('INTERNAL_SERVER_ERROR');
    const message = isRecord(executed.details) ? String(executed.details.message ?? '') : '';
    expect(message).toContain('count');
    expect(message).not.toContain('Invalid URL');
    expect(message).not.toContain('link');

    // Re-exposed MCP also fails reporting only count
    const reexportServer = buildMcpServer({
      serverInfo: { name: 'reexport', version: '1.0.0' },
      access: { open: 'local-operator' },
      services: [],
      runtimeTools: [discovered],
    });
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    const client = new Client({ name: 'reexport-client', version: '1.0.0' });
    await Promise.all([
      reexportServer.connect(serverTransport),
      client.connect(clientTransport),
    ]);
    try {
      const called = await client.callTool({ name: 'fetch_link', arguments: {} });
      expect(called.isError).toBe(true);
      const text = JSON.stringify(called.content);
      expect(text).toContain('count');
      expect(text).not.toContain('Invalid URL');
    } finally {
      await client.close();
    }
  });

  test('negative control: authored z.object({ link: z.url() }) still fails INTERNAL_SERVER_ERROR on relative path', async () => {
    let presenterCalled = false;
    const authored = defineRuntimeTool({
      name: 'authored_link',
      description: 'Authored tool with strict URL output',
      identity: { serviceName: 'local', action: 'authored_link', method: 'POST' },
      input: z.object({}),
      output: z.object({ link: z.url(), count: z.number() }),
      expose: ['MCP', 'AGENT'],
      handler: () => ({ link: '/relative/path', count: 1 }),
      present: {
        agent: (data) => {
          presenterCalled = true;
          return { type: 'text', value: `AUTHORED:${data.link}` };
        },
      },
    });

    const executed = await executeToolMethod(
      runtimeToolMountable(projectRuntimeTool(authored)).method,
      {
        toolName: authored.name,
        rawArgs: {},
        context: { source: 'agent' },
      },
    );
    expect(executed.ok).toBe(false);
    if (executed.ok) throw new Error('Authored z.url() must refuse relative path');
    expect(executed.code).toBe('INTERNAL_SERVER_ERROR');
    const authoredMessage = isRecord(executed.details)
      ? String(executed.details.message ?? '')
      : '';
    expect(authoredMessage).toContain('link');

    const server = buildMcpServer({
      serverInfo: { name: 'authored', version: '1.0.0' },
      access: { open: 'local-operator' },
      services: [],
      runtimeTools: [authored],
    });
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    const client = new Client({ name: 'authored-client', version: '1.0.0' });
    await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
    try {
      const called = await client.callTool({ name: 'authored_link', arguments: {} });
      expect(called.isError).toBe(true);
    } finally {
      await client.close();
    }

    const agentTools = mountAgent([], {
      access: { open: 'local-operator' },
      runtimeTools: [authored],
    });
    const agentTool = agentTools.authored_link;
    if (!agentTool?.toModelOutput) throw new Error('Expected toModelOutput');
    const modelOutput = await agentTool.toModelOutput({
      toolCallId: 'call-neg',
      input: {},
      output: { link: '/relative/path', count: 1 },
    });
    expect(presenterCalled).toBe(false);
    expect(modelOutput).toEqual({
      type: 'text',
      value: JSON.stringify({ link: '/relative/path', count: 1 }),
    });
  });
});
