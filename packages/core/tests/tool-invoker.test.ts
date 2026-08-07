import { describe, expect, test } from 'bun:test';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { AppError, defineContract } from '../src/contract';
import {
  getRequestContext,
  runWithRequestContext,
  setRequestDimensions,
} from '../src/observability';
import { implement } from '../src/server';
import { mountAgent } from '../src/tools/agent';
import { createToolInvoker, type ToolInvocationOptions } from '../src/tools/invoker';
import { mountMcp } from '../src/tools/mcp';

const MathInput = z.object({ left: z.number(), right: z.number() });
const MathOutput = z.object({ total: z.number() });
const IdInput = z.object({ id: z.string() });
const IdOutput = z.object({ id: z.string(), tenantId: z.string().optional() });

const operations = defineContract(
  { prefix: 'operations' },
  {
    add: {
      method: 'POST',
      path: '/add',
      desc: 'Add two numbers',
      input: MathInput,
      output: MathOutput,
      toolName: 'math_add',
    },
    inspect: {
      method: 'POST',
      path: '/inspect',
      desc: 'Inspect one call',
      input: IdInput,
      output: IdOutput,
      toolName: 'inspect_call',
    },
    explode: {
      method: 'POST',
      path: '/explode',
      desc: 'Throw an error',
      input: IdInput,
      toolName: 'explode_call',
    },
    agentOnly: {
      method: 'GET',
      path: '/agent',
      desc: 'Agent only',
      expose: ['AGENT'],
      toolName: 'agent_only',
    },
    mcpOnly: {
      method: 'GET',
      path: '/mcp',
      desc: 'MCP only',
      expose: ['MCP'],
      toolName: 'mcp_only',
    },
  },
);

const service = implement(operations, {
  add: ({ input }) => ({ total: input.left + input.right }),
  inspect: async ({ input, tenantId }) => {
    await Bun.sleep(input.id === 'A' ? 8 : 2);
    return {
      id: input.id,
      ...(typeof tenantId === 'string' && { tenantId }),
      internal: true,
    };
  },
  explode: ({ input }) => {
    if (input.id === 'app') {
      throw new AppError(
        'ENTITY_LOCKED',
        'Entity is locked',
        423,
        { entityId: 'app' },
        'Wait',
      );
    }
    throw new Error('boom');
  },
  agentOnly: () => undefined,
  mcpOnly: () => undefined,
});

async function connect(server: McpServer): Promise<Client> {
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: 'invoker-test', version: '1' });
  await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
  return client;
}

describe('createToolInvoker', () => {
  test('runs typed input/output through the shared runner', async () => {
    const invoker = createToolInvoker(service, { transport: 'AGENT' });
    expect(await invoker.invoke('math_add', { left: 2, right: 3 })).toEqual({
      ok: true,
      data: { total: 5 },
    });
  });

  test('honours exposure policy and fails first on unknown or duplicate names', async () => {
    const agent = createToolInvoker(service, { transport: 'AGENT' });
    const mcp = createToolInvoker(service, { transport: 'MCP' });
    expect(agent.names).toContain('agent_only');
    expect(agent.names).not.toContain('mcp_only');
    expect(mcp.names).toContain('mcp_only');
    expect(mcp.names).not.toContain('agent_only');

    try {
      await agent.invoke('missing', {});
      throw new Error('expected unknown tool failure');
    } catch (error) {
      expect(AppError.is(error)).toBe(true);
      if (AppError.is(error)) expect(error.code).toBe('NOT_FOUND');
    }

    expect(() => createToolInvoker([service, service], { transport: 'AGENT' })).toThrow(
      'Duplicate in-process tool name',
    );
  });

  test('reports validation, lifecycle, throws and invalid output canonically', async () => {
    const inputFailure = createToolInvoker(service, { transport: 'AGENT' });
    expect(await inputFailure.invoke('math_add', { left: '2', right: 3 })).toMatchObject({
      ok: false,
      code: 'VALIDATION_ERROR',
    });

    const denied = createToolInvoker(service, { transport: 'AGENT' });
    expect(
      await denied.invoke(
        'math_add',
        { left: 2, right: 3 },
        {
          lifecycle: {
            beforeHandle: () => {
              throw new AppError('FORBIDDEN', 'denied', 403);
            },
          },
        },
      ),
    ).toMatchObject({
      ok: false,
      code: 'FORBIDDEN',
    });

    expect(await inputFailure.invoke('explode_call', { id: 'x' })).toMatchObject({
      ok: false,
      code: 'INTERNAL_SERVER_ERROR',
    });

    const invalidOutput = createToolInvoker(service, { transport: 'AGENT' });
    expect(
      await invalidOutput.invoke(
        'math_add',
        { left: 2, right: 3 },
        {
          lifecycle: {
            afterHandle: (_context, result, endpoint) =>
              endpoint.key === 'add' ? { total: 'wrong' } : result,
          },
        },
      ),
    ).toMatchObject({
      ok: false,
      code: 'INTERNAL_SERVER_ERROR',
    });
  });

  test('throws the retained normalized AppError after one terminal hook event', async () => {
    const terminal: boolean[] = [];
    const invoker = createToolInvoker(service, { transport: 'AGENT' });
    const options: ToolInvocationOptions = {
      hooks: {
        afterToolCall: ({ result }) => {
          terminal.push(result.ok);
        },
      },
    };

    expect(await invoker.invokeOrThrow('math_add', { left: 2, right: 3 }, options)).toEqual({
      total: 5,
    });
    try {
      await invoker.invokeOrThrow('explode_call', { id: 'app' }, options);
      throw new Error('expected application failure');
    } catch (error) {
      expect(AppError.is(error)).toBe(true);
      if (AppError.is(error)) {
        expect({
          code: error.code,
          message: error.message,
          status: error.status,
          details: error.details,
          hint: error.hint,
        }).toEqual({
          code: 'ENTITY_LOCKED',
          message: 'Entity is locked',
          status: 423,
          details: { entityId: 'app' },
          hint: 'Wait',
        });
      }
    }
    expect(terminal).toEqual([true, false]);
  });

  test('throws framework failures with their canonical status', async () => {
    const invoker = createToolInvoker(service, { transport: 'AGENT' });
    try {
      await invoker.invokeOrThrow('math_add', { left: 'wrong', right: 3 });
      throw new Error('expected validation failure');
    } catch (error) {
      expect(AppError.is(error)).toBe(true);
      if (AppError.is(error)) {
        expect(error.code).toBe('VALIDATION_ERROR');
        expect(error.status).toBe(400);
      }
    }
  });

  test('runs extension resolution and one terminal hook event per call', async () => {
    const terminal: string[] = [];
    const stripped: Array<{ toolName: string; paths: string[] }> = [];
    const invoker = createToolInvoker(service, {
      transport: 'AGENT',
      flattenUnionInput: true,
      extend: {
        schema: { tenant: z.string() },
        resolve: ({ tenant }) => ({ tenantId: tenant }),
      },
    });
    expect(
      await invoker.invoke(
        'inspect_call',
        { id: 'A', tenant: 'tenant-1' },
        {
          hooks: {
            afterToolCall: ({ toolName, result, endpoint, durationMs }) => {
              terminal.push(`${toolName}:${endpoint.key}:${result.ok}:${durationMs >= 0}`);
            },
          },
          onOutputStrip: (toolName, paths) => stripped.push({ toolName, paths }),
        },
      ),
    ).toEqual({
      ok: true,
      data: { id: 'A', tenantId: 'tenant-1' },
    });
    expect(terminal).toEqual(['inspect_call:inspect:true:true']);
    expect(stripped).toEqual([{ toolName: 'inspect_call', paths: ['internal'] }]);
  });

  test('reuses one registry with isolated per-call identity context', async () => {
    const invoker = createToolInvoker(service, { transport: 'AGENT' });
    const observed: string[] = [];
    const call = (id: string, tenantId: string) =>
      invoker.invoke(
        'inspect_call',
        { id },
        {
          context: { tenantId },
          hooks: {
            afterToolCall: ({ context }) => {
              if (typeof context.tenantId === 'string') observed.push(context.tenantId);
            },
          },
        },
      );

    const [alpha, beta] = await Promise.all([call('A', 'alpha'), call('B', 'beta')]);
    expect(alpha).toEqual({ ok: true, data: { id: 'A', tenantId: 'alpha' } });
    expect(beta).toEqual({ ok: true, data: { id: 'B', tenantId: 'beta' } });
    expect(observed.sort()).toEqual(['alpha', 'beta']);
  });

  test('parallel and nested calls isolate request-context writes', async () => {
    const observed: Array<{ id: string; dimension?: string }> = [];
    const invoker = createToolInvoker(service, { transport: 'AGENT' });
    const options: ToolInvocationOptions = {
      lifecycle: {
        beforeHandle: (context, endpoint) => {
          if (endpoint.key !== 'inspect') return;
          const parsed = IdInput.parse(context.input);
          setRequestDimensions({ entityId: parsed.id });
        },
      },
      hooks: {
        afterToolCall: ({ args, endpoint }) => {
          if (endpoint.key !== 'inspect') return;
          const parsed = IdInput.parse(args);
          observed.push({
            id: parsed.id,
            dimension: getRequestContext()?.dimensions?.entityId,
          });
        },
      },
    };

    await runWithRequestContext(
      {
        source: 'http',
        method: 'POST',
        path: '/invoke',
        startedAt: 0n,
        trace: { traceId: 'a'.repeat(32), spanId: 'b'.repeat(16) },
      },
      async () => {
        await Promise.all([
          invoker.invoke('inspect_call', { id: 'A' }, options),
          invoker.invoke('inspect_call', { id: 'B' }, options),
        ]);
        await invoker.invoke('inspect_call', { id: 'nested' }, options);
      },
    );

    expect(observed).toContainEqual({ id: 'A', dimension: 'A' });
    expect(observed).toContainEqual({ id: 'B', dimension: 'B' });
    expect(observed).toContainEqual({ id: 'nested', dimension: 'nested' });
  });

  test('a handler can recursively invoke another compiled operation', async () => {
    let nestedInvoker: ReturnType<typeof createToolInvoker> | undefined;
    const dimensions: Array<{ key: string; entityId?: string }> = [];
    const options: ToolInvocationOptions = {
      lifecycle: {
        beforeHandle: (context, endpoint) => {
          const input = IdInput.parse(context.input);
          setRequestDimensions({ entityId: `${endpoint.key}:${input.id}` });
        },
      },
      hooks: {
        afterToolCall: ({ endpoint }) => {
          dimensions.push({
            key: endpoint.key,
            entityId: getRequestContext()?.dimensions?.entityId,
          });
        },
      },
    };
    const nestedContract = defineContract(
      { prefix: 'nested' },
      {
        inner: {
          method: 'POST',
          path: '/inner',
          desc: 'Inner operation',
          input: IdInput,
          output: IdOutput,
          toolName: 'nested_inner',
        },
        outer: {
          method: 'POST',
          path: '/outer',
          desc: 'Outer operation',
          input: IdInput,
          output: IdOutput,
          toolName: 'nested_outer',
        },
      },
    );
    const nestedService = implement(nestedContract, {
      inner: ({ input }) => ({ id: input.id }),
      outer: async ({ input }) => {
        if (!nestedInvoker) throw new Error('nested invoker is not initialized');
        return IdOutput.parse(
          await nestedInvoker.invokeOrThrow('nested_inner', { id: input.id }, options),
        );
      },
    });
    nestedInvoker = createToolInvoker(nestedService, { transport: 'AGENT' });

    await runWithRequestContext(
      {
        source: 'http',
        method: 'POST',
        path: '/invoke',
        startedAt: 0n,
        trace: { traceId: 'c'.repeat(32), spanId: 'd'.repeat(16) },
      },
      () => nestedInvoker?.invoke('nested_outer', { id: 'x' }, options) ?? Promise.resolve(),
    );

    expect(dimensions).toEqual([
      { key: 'inner', entityId: 'inner:x' },
      { key: 'outer', entityId: 'outer:x' },
    ]);
  });

  test('matches the same operation through agent and MCP mounts', async () => {
    const invoker = createToolInvoker(service, { transport: 'AGENT' });
    const internal = await invoker.invoke('math_add', { left: 4, right: 6 });

    const agentTools = mountAgent(service);
    const execute = agentTools.math_add?.execute;
    if (!execute) throw new Error('missing agent tool');
    const agent = await execute(
      { left: 4, right: 6 },
      { toolCallId: 'add', messages: [], context: undefined },
    );

    const mcpServer = new McpServer({ name: 'invoker-test', version: '1' });
    mountMcp(mcpServer, service);
    const client = await connect(mcpServer);
    const mcp = await client.callTool({
      name: 'math_add',
      arguments: { left: 4, right: 6 },
    });
    await client.close();

    expect(internal).toEqual({ ok: true, data: { total: 10 } });
    expect(agent).toEqual({ total: 10 });
    expect(mcp.structuredContent).toEqual({ total: 10 });
  });

  test('compiles an immutable lookup once', () => {
    const invoker = createToolInvoker(service, { transport: 'AGENT' });
    const before = invoker.names;
    expect(Object.isFrozen(invoker)).toBe(true);
    expect(Object.isFrozen(invoker.names)).toBe(true);
    expect(invoker.names).toBe(before);
  });
});
