import { describe, expect, test } from 'bun:test';
import { Client, InMemoryTransport } from '@modelcontextprotocol/client';
import type { McpServer } from '@modelcontextprotocol/server';
import { z } from 'zod';
import { AppError, defineContract } from '../src/contract';
import {
  createObservability,
  type RequestEvent,
  runWithRequestContext,
  setRequestDimensions,
} from '../src/observability';
import { implement } from '../src/server';
import {
  buildMcpServer,
  defineRuntimeTool,
  mountAgent,
  type ToolCallHooks,
} from '../src/tools';

async function connect(server: McpServer): Promise<Client> {
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: 'runtime-tool-test', version: '1' });
  await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
  return client;
}

function executable(tools: ReturnType<typeof mountAgent>, name: string) {
  const execute = tools[name]?.execute;
  if (!execute) throw new Error(`expected executable tool ${name}`);
  return execute;
}

const inputSchema = z.object({ id: z.string(), fail: z.boolean().default(false) });
const outputSchema = z.object({ id: z.string(), ok: z.boolean() });

describe('framework runtime tools', () => {
  test('Agent uses the canonical runner for parsing, lifecycle, failures and output strips', async () => {
    const terminal: Array<{ ok: boolean; code?: string }> = [];
    const stripped: string[][] = [];
    let handlerCalls = 0;
    const runtimeTool = defineRuntimeTool({
      name: 'runtime_update',
      description: 'Update a runtime entity',
      identity: {
        serviceName: 'runtimeTools',
        action: 'update',
        scope: 'admin',
        method: 'PATCH',
      },
      input: inputSchema,
      output: outputSchema,
      handler: ({ input }) => {
        handlerCalls += 1;
        if (input.fail) throw new Error('handler exploded');
        return { id: input.id, ok: true, internal: 'removed' };
      },
    });
    const tools = mountAgent([], {
      runtimeTools: [runtimeTool],
      lifecycle: {
        beforeHandle: (_context, endpoint) => {
          expect(endpoint).toMatchObject({
            serviceName: 'runtimeTools',
            key: 'update',
            scope: 'admin',
            method: 'PATCH',
          });
        },
      },
      hooks: {
        afterToolCall: ({ result }) => {
          terminal.push(result.ok ? { ok: true } : { ok: false, code: result.code });
        },
      },
      onOutputStrip: (_name, paths) => stripped.push(paths),
    });
    const execute = executable(tools, 'runtime_update');

    const success = await execute(
      { id: 'one' },
      { toolCallId: 'one', messages: [], context: undefined },
    );
    const invalid = await execute(
      { id: 42 },
      { toolCallId: 'invalid', messages: [], context: undefined },
    );
    const originalError = console.error;
    console.error = () => undefined;
    const failed = await execute(
      { id: 'two', fail: true },
      { toolCallId: 'two', messages: [], context: undefined },
    );
    console.error = originalError;

    expect(success).toEqual({ id: 'one', ok: true });
    expect(invalid).toMatchObject({ error: 'VALIDATION_ERROR' });
    expect(failed).toMatchObject({ error: 'INTERNAL_SERVER_ERROR' });
    expect(handlerCalls).toBe(2);
    expect(stripped).toEqual([['internal']]);
    expect(terminal).toEqual([
      { ok: true },
      { ok: false, code: 'VALIDATION_ERROR' },
      { ok: false, code: 'INTERNAL_SERVER_ERROR' },
    ]);
  });

  test('parallel Agent calls keep audit dimensions and identities isolated', async () => {
    const events: RequestEvent[] = [];
    const audit = createObservability({
      tools: { write: (event) => void events.push(event) },
    });
    const runtimeTool = defineRuntimeTool({
      name: 'runtime_parallel',
      description: 'Run in parallel',
      identity: { serviceName: 'runtimeTools', action: 'parallel', method: 'POST' },
      input: z.object({ id: z.string(), delay: z.number() }),
      output: z.object({ id: z.string() }),
      handler: async ({ input }) => {
        await new Promise((resolve) => setTimeout(resolve, input.delay));
        return { id: input.id };
      },
    });
    const tools = mountAgent([], {
      runtimeTools: [runtimeTool],
      hooks: audit.toolCall,
      lifecycle: {
        beforeHandle: (context) => {
          const input = z.object({ id: z.string() }).passthrough().parse(context.input);
          setRequestDimensions({ entityId: input.id });
        },
      },
    });
    const execute = executable(tools, 'runtime_parallel');

    await runWithRequestContext(
      {
        source: 'http',
        method: 'POST',
        path: '/agent',
        startedAt: process.hrtime.bigint(),
        trace: { traceId: 'a'.repeat(32), spanId: 'b'.repeat(16) },
      },
      () =>
        Promise.all([
          execute(
            { id: 'slow', delay: 8 },
            { toolCallId: 'slow', messages: [], context: undefined },
          ),
          execute(
            { id: 'fast', delay: 1 },
            { toolCallId: 'fast', messages: [], context: undefined },
          ),
        ]),
    );

    expect(
      events
        .map((event) => ({
          entityId: event.dimensions?.entityId,
          serviceName: event.serviceName,
          action: event.action,
          method: event.httpMethod,
        }))
        .sort((left, right) => String(left.entityId).localeCompare(String(right.entityId))),
    ).toEqual([
      {
        entityId: 'fast',
        serviceName: 'runtimeTools',
        action: 'parallel',
        method: 'POST',
      },
      {
        entityId: 'slow',
        serviceName: 'runtimeTools',
        action: 'parallel',
        method: 'POST',
      },
    ]);
  });

  test('one definition preserves rich MCP and Agent presentations', async () => {
    const identities: Array<{ source: string; serviceName: string; action: string }> = [];
    const hooks: ToolCallHooks = {
      afterToolCall: ({ context, endpoint }) => {
        identities.push({
          source: context.source,
          serviceName: endpoint.serviceName,
          action: endpoint.key,
        });
      },
    };
    const definition = defineRuntimeTool({
      name: 'runtime_preview',
      description: 'Render a preview',
      identity: { serviceName: 'mediaTools', action: 'preview', method: 'POST' },
      input: z.object({ prompt: z.string() }),
      output: z.object({ assetId: z.string() }),
      handler: ({ input }) => ({ assetId: `asset:${input.prompt}` }),
      present: {
        mcp: (output) => ({
          content: [
            { type: 'text', text: output.assetId },
            { type: 'image', data: 'aGVsbG8=', mimeType: 'image/png' },
          ],
          _meta: { surface: 'mcp' },
        }),
        agent: (output) => ({
          type: 'content',
          value: [
            { type: 'text', text: output.assetId },
            {
              type: 'file',
              data: { type: 'data', data: 'aGVsbG8=' },
              mediaType: 'image/png',
              filename: 'preview.png',
            },
          ],
        }),
      },
    });

    const mcpServer = buildMcpServer(
      {
        serverInfo: { name: 'runtime', version: '1' },
        services: [],
        hooks,
        runtimeTools: [definition],
      },
      undefined,
    );
    const client = await connect(mcpServer);
    const mcp = await client.callTool({
      name: 'runtime_preview',
      arguments: { prompt: 'forest' },
    });

    const agentTools = mountAgent([], { runtimeTools: [definition], hooks });
    const execute = executable(agentTools, 'runtime_preview');
    const output = await execute(
      { prompt: 'forest' },
      { toolCallId: 'preview', messages: [], context: undefined },
    );
    const toModelOutput = agentTools.runtime_preview?.toModelOutput;
    if (!toModelOutput) throw new Error('expected an Agent model-output presenter');
    const agent = await toModelOutput({
      toolCallId: 'preview',
      input: { prompt: 'forest' },
      output,
    });

    expect(mcp.structuredContent).toEqual({ assetId: 'asset:forest' });
    expect(mcp.content).toEqual([
      { type: 'text', text: 'asset:forest' },
      { type: 'image', data: 'aGVsbG8=', mimeType: 'image/png' },
    ]);
    expect(mcp._meta).toEqual({ surface: 'mcp' });
    expect(agent).toEqual({
      type: 'content',
      value: [
        { type: 'text', text: 'asset:forest' },
        {
          type: 'file',
          data: { type: 'data', data: 'aGVsbG8=' },
          mediaType: 'image/png',
          filename: 'preview.png',
        },
      ],
    });
    expect(identities).toEqual([
      { source: 'mcp', serviceName: 'mediaTools', action: 'preview' },
      { source: 'agent', serviceName: 'mediaTools', action: 'preview' },
    ]);
    await client.close();
  });

  test('lifecycle denial emits one terminal event and never calls the handler', async () => {
    let handlerCalls = 0;
    let terminalCalls = 0;
    const definition = defineRuntimeTool({
      name: 'runtime_denied',
      description: 'Denied operation',
      identity: {
        serviceName: 'runtimeTools',
        action: 'denied',
        scope: 'admin',
        method: 'POST',
      },
      input: z.object({}),
      handler: () => {
        handlerCalls += 1;
      },
    });
    const tools = mountAgent([], {
      runtimeTools: [definition],
      lifecycle: {
        beforeHandle: () => {
          throw new AppError('FORBIDDEN', 'denied', 403);
        },
      },
      hooks: {
        afterToolCall: () => {
          terminalCalls += 1;
        },
      },
    });

    const result = await executable(tools, 'runtime_denied')(
      {},
      { toolCallId: 'denied', messages: [], context: undefined },
    );

    expect(result).toMatchObject({ error: 'FORBIDDEN' });
    expect(handlerCalls).toBe(0);
    expect(terminalCalls).toBe(1);
  });

  test('transport filters and duplicate-name ratchets cover runtime and contract tools', () => {
    const mcpOnly = defineRuntimeTool({
      name: 'mcp_only',
      description: 'MCP only',
      identity: { serviceName: 'runtimeTools', action: 'mcpOnly', method: 'GET' },
      input: z.object({}),
      transports: ['MCP'],
      handler: () => undefined,
    });
    expect(Object.keys(mountAgent([], { runtimeTools: [mcpOnly] }))).toEqual([]);

    const contract = defineContract(
      { prefix: 'runtime' },
      {
        duplicate: {
          method: 'POST',
          path: '/duplicate',
          desc: 'Duplicate',
          input: z.object({}),
          output: z.object({ ok: z.boolean() }),
          expose: ['AGENT', 'MCP'],
          toolName: 'duplicate_name',
        },
      },
    );
    const service = implement(contract, { duplicate: () => ({ ok: true }) });
    const duplicate = defineRuntimeTool({
      name: 'duplicate_name',
      description: 'Duplicate runtime name',
      identity: { serviceName: 'runtimeTools', action: 'duplicate', method: 'POST' },
      input: z.object({}),
      handler: () => undefined,
    });

    expect(() => mountAgent(service, { runtimeTools: [duplicate] })).toThrow(
      /Duplicate agent tool name "duplicate_name"/,
    );
    expect(() =>
      buildMcpServer(
        {
          serverInfo: { name: 'runtime', version: '1' },
          services: [service],
          runtimeTools: [duplicate],
        },
        undefined,
      ),
    ).toThrow(/Duplicate MCP tool name "duplicate_name"/);
  });
});
