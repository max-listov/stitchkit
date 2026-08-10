import { describe, expect, test } from 'bun:test';
import { Client, InMemoryTransport } from '@modelcontextprotocol/client';
import type { McpServer } from '@modelcontextprotocol/server';
import { asSchema } from 'ai';
import { z } from 'zod';
import { defineContract } from '../src/contract';
import { isRecord } from '../src/internal/typed';
import { implement } from '../src/server';
import { mountAgent } from '../src/tools/agent';
import { buildMcpServer } from '../src/tools/mcp';
import { collectTools, createToolRunner } from '../src/tools/mount';
import { defineRuntimeTool } from '../src/tools/runtime-tool';

async function connect(server: McpServer): Promise<Client> {
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: 'single-parse', version: '1' });
  await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
  return client;
}

describe('one executable input parser per tool call', () => {
  test('MCP parses params and flattened nested input transforms once', async () => {
    const effects: string[] = [];
    const received: unknown[] = [];
    const operation = z.discriminatedUnion('kind', [
      z.object({
        kind: z.literal('write'),
        text: z.string().transform((value) => {
          effects.push(`input:${value}`);
          return `${value}!`;
        }),
      }),
      z.object({ kind: z.literal('delete'), id: z.string() }),
    ]);
    const contract = defineContract(
      { prefix: 'single' },
      {
        run: {
          method: 'POST',
          path: '/:id',
          desc: 'Run',
          params: z.object({
            id: z.string().transform((value) => {
              effects.push(`params:${value}`);
              return value.toUpperCase();
            }),
          }),
          input: z.object({ operation }),
        },
      },
    );
    const service = implement(contract, {
      run: (context) => {
        received.push({ params: context.params, input: context.input });
      },
    });
    const server = buildMcpServer(
      {
        serverInfo: { name: 'single', version: '1' },
        services: [service],
        flattenUnionInput: true,
      },
      undefined,
    );
    const client = await connect(server);
    await client.callTool({
      name: 'run_single',
      arguments: { id: 'abc', operation: { kind: 'write', text: 'x' } },
    });
    expect(effects).toEqual(['params:abc', 'input:x']);
    expect(received).toEqual([
      { params: { id: 'ABC' }, input: { operation: { kind: 'write', text: 'x!' } } },
    ]);
    await client.close();
  });

  test('agent identity validation does not execute defaults or transforms', async () => {
    const effects: string[] = [];
    const received: unknown[] = [];
    const contract = defineContract(
      { prefix: 'agent' },
      {
        run: {
          method: 'POST',
          path: '/',
          desc: 'Run',
          input: z.object({
            value: z
              .string()
              .default('default')
              .transform((value) => {
                effects.push(value);
                return `${value}!`;
              }),
          }),
        },
      },
    );
    const tools = mountAgent(
      implement(contract, { run: (context) => void received.push(context.input) }),
    );
    const mounted = tools.run_agent;
    if (!mounted || typeof mounted.execute !== 'function') throw new Error('expected tool');
    await Reflect.apply(mounted.execute, undefined, [
      {},
      { toolCallId: 'call', messages: [], abortSignal: undefined },
    ]);
    expect(effects).toEqual(['default']);
    expect(received).toEqual([{ value: 'default!' }]);
  });

  test('agent parses params and nested flattened transforms once', async () => {
    const effects: string[] = [];
    const received: unknown[] = [];
    const operation = z.discriminatedUnion('kind', [
      z.object({
        kind: z.literal('write'),
        payload: z.object({
          value: z.string().transform((value) => {
            effects.push(`input:${value}`);
            return `${value}!`;
          }),
        }),
      }),
      z.object({ kind: z.literal('delete'), id: z.string() }),
    ]);
    const service = implement(
      defineContract(
        { prefix: 'agent-flat' },
        {
          run: {
            method: 'POST',
            path: '/:id',
            desc: 'Run',
            params: z.object({
              id: z.string().transform((value) => {
                effects.push(`params:${value}`);
                return value.toUpperCase();
              }),
            }),
            input: z.object({ operation }),
          },
        },
      ),
      { run: (context) => void received.push(context) },
    );
    const mounted = mountAgent(service, { flattenUnionInput: true }).run_agent_flat;
    if (!mounted || typeof mounted.execute !== 'function') throw new Error('expected tool');
    await Reflect.apply(mounted.execute, undefined, [
      { id: 'abc', operation: { kind: 'write', payload: { value: 'x' } } },
      { toolCallId: 'call', messages: [], abortSignal: undefined },
    ]);
    expect(effects).toEqual(['params:abc', 'input:x']);
    expect(received).toEqual([
      {
        params: { id: 'ABC' },
        input: { operation: { kind: 'write', payload: { value: 'x!' } } },
        source: 'agent',
      },
    ]);
  });

  test('agent presentation uses the AI SDK draft-07 tuple vocabulary', async () => {
    const service = implement(
      defineContract(
        { prefix: 'tuple' },
        {
          run: {
            method: 'POST',
            path: '/',
            desc: 'Run',
            input: z.object({ pair: z.tuple([z.string(), z.number()]) }),
          },
        },
      ),
      { run: () => undefined },
    );
    const mounted = mountAgent(service).run_tuple;
    if (!mounted) throw new Error('expected tool');
    const schema = await asSchema(mounted.inputSchema).jsonSchema;
    expect(schema.$schema).toBe('http://json-schema.org/draft-07/schema#');
    expect(JSON.stringify(schema)).toContain('"items":[');
    expect(JSON.stringify(schema)).not.toContain('prefixItems');
  });

  test('ToolExtend parses its fields once, resolves transformed values and stays observable', async () => {
    const effects: string[] = [];
    const resolved: unknown[] = [];
    const received: unknown[] = [];
    const hooks: string[] = [];
    const hookTenants: unknown[] = [];
    const service = implement(
      defineContract(
        { prefix: 'extend' },
        {
          run: {
            method: 'POST',
            path: '/',
            desc: 'Run',
            input: z.object({ value: z.string() }),
          },
        },
      ),
      { run: (context) => void received.push(context) },
    );
    const extend = {
      schema: {
        tenant: z.string().transform((value) => {
          effects.push(value);
          return value.toUpperCase();
        }),
      },
      resolve: (args: Record<string, unknown>) => {
        resolved.push(args.tenant);
        return { tenant: args.tenant };
      },
    };
    const [tool] = collectTools(service, 'MCP', { extend });
    if (!tool) throw new Error('expected tool');
    const run = createToolRunner({
      source: 'mcp',
      extend,
      hooks: {
        beforeToolCall: ({ context }) => {
          hooks.push('before');
          hookTenants.push(context.tenant);
        },
        afterToolCall: ({ context }) => {
          hooks.push('after');
          hookTenants.push(context.tenant);
        },
      },
    });
    const result = await run(tool, { tenant: 'acme', value: 'x' });
    expect(result.ok).toBe(true);
    expect(effects).toEqual(['acme']);
    expect(resolved).toEqual(['ACME']);
    expect(hooks).toEqual(['before', 'after']);
    expect(hookTenants).toEqual(['ACME', 'ACME']);
    const context = received[0];
    expect(isRecord(context) && context.tenant).toBe('ACME');
    expect(isRecord(context) && context.input).toEqual({ value: 'x' });
  });

  test('ToolExtend owns required, default, coerce and refine semantics exactly once', async () => {
    const effects: string[] = [];
    const resolved: unknown[] = [];
    const service = implement(
      defineContract(
        { prefix: 'extend-matrix' },
        {
          run: {
            method: 'POST',
            path: '/',
            desc: 'Run',
            input: z.object({ value: z.string() }),
          },
        },
      ),
      { run: () => undefined },
    );
    const extend = {
      schema: {
        required: z.string(),
        defaulted: z.string().default('fallback'),
        coerced: z.coerce.number().transform((value) => {
          effects.push(`coerce:${value}`);
          return value + 1;
        }),
        refined: z.string().refine((value) => {
          effects.push(`refine:${value}`);
          return value === 'valid';
        }),
      },
      resolve: (args: Record<string, unknown>) => {
        resolved.push(args);
        return {};
      },
    };
    const [tool] = collectTools(service, 'AGENT', { extend });
    if (!tool) throw new Error('expected tool');
    const run = createToolRunner({ source: 'agent', extend });

    const success = await run(tool, {
      required: 'yes',
      coerced: '7',
      refined: 'valid',
      value: 'x',
    });
    expect(success.ok).toBe(true);
    expect(effects).toEqual(['coerce:7', 'refine:valid']);
    expect(resolved).toEqual([
      {
        required: 'yes',
        defaulted: 'fallback',
        coerced: 8,
        refined: 'valid',
        value: 'x',
      },
    ]);

    const events: string[] = [];
    const failed = await createToolRunner({
      source: 'agent',
      extend,
      hooks: {
        beforeToolCall: () => void events.push('before'),
        afterToolCall: ({ result }) => void events.push(`after:${result.ok}`),
      },
    })(tool, { coerced: '7', refined: 'invalid', value: 'x' });
    expect(failed).toMatchObject({ ok: false, code: 'VALIDATION_ERROR' });
    expect(events).toEqual(['before', 'after:false']);
    expect(resolved).toHaveLength(1);
  });

  test('protected native MCP input transforms once', async () => {
    const effects: string[] = [];
    const received: string[] = [];
    const server = buildMcpServer(
      {
        serverInfo: { name: 'native', version: '1' },
        services: [],
        runtimeTools: [
          defineRuntimeTool({
            name: 'native_once',
            description: 'Native',
            identity: { serviceName: 'native', action: 'once', method: 'POST' },
            input: z.object({
              value: z.string().transform((value) => {
                effects.push(value);
                return `${value}!`;
              }),
            }),
            handler: ({ input }) => {
              received.push(input.value);
            },
          }),
        ],
      },
      undefined,
    );
    const client = await connect(server);
    await client.callTool({ name: 'native_once', arguments: { value: 'x' } });
    expect(effects).toEqual(['x']);
    expect(received).toEqual(['x!']);
    await client.close();
  });

  test('refine, overwrite, pipe and catch effects are not replayed by MCP', async () => {
    const effects: string[] = [];
    const received: unknown[] = [];
    const input = z.object({
      refined: z.string().refine((value) => {
        effects.push(`refine:${value}`);
        return true;
      }),
      overwritten: z.string().overwrite((value) => {
        effects.push(`overwrite:${value}`);
        return `${value}!`;
      }),
      piped: z.string().pipe(
        z.string().transform((value) => {
          effects.push(`pipe:${value}`);
          return value.toUpperCase();
        }),
      ),
      coerced: z.coerce.number(),
      recovered: z.string().catch('fallback'),
    });
    const service = implement(
      defineContract(
        { prefix: 'effects' },
        { run: { method: 'POST', path: '/', desc: 'Run', input } },
      ),
      { run: (context) => void received.push(context.input) },
    );
    const [mountable] = collectTools(service, 'MCP');
    if (!mountable) throw new Error('expected tool');
    const properties = mountable.presentationSchema.properties;
    expect(isRecord(properties) && properties.coerced).toEqual({ type: 'number' });
    expect(isRecord(properties) && properties.recovered).toEqual({
      type: 'string',
      default: 'fallback',
    });
    const server = buildMcpServer(
      {
        serverInfo: { name: 'effects', version: '1' },
        services: [service],
      },
      undefined,
    );
    const client = await connect(server);
    await client.callTool({
      name: 'run_effect',
      arguments: {
        refined: 'r',
        overwritten: 'o',
        piped: 'p',
        coerced: '7',
        recovered: 42,
      },
    });
    expect(effects).toEqual(['refine:r', 'overwrite:o', 'pipe:p']);
    expect(received).toEqual([
      { refined: 'r', overwritten: 'o!', piped: 'P', coerced: 7, recovered: 'fallback' },
    ]);
    await client.close();
  });

  test('a thrown input effect reaches onToolError and afterToolCall', async () => {
    const thrown = new Error('effect exploded');
    const events: string[] = [];
    const service = implement(
      defineContract(
        { prefix: 'throwing' },
        {
          run: {
            method: 'POST',
            path: '/',
            desc: 'Run',
            input: z.object({
              value: z.string().transform(() => {
                throw thrown;
              }),
            }),
          },
        },
      ),
      { run: () => undefined },
    );
    const [tool] = collectTools(service, 'AGENT');
    if (!tool) throw new Error('expected tool');
    const result = await createToolRunner({
      source: 'agent',
      hooks: {
        beforeToolCall: () => void events.push('before'),
        onToolError: ({ error }) => {
          expect(error).toBe(thrown);
          events.push('error');
        },
        afterToolCall: ({ error }) => {
          expect(error).toBe(thrown);
          events.push('after');
        },
      },
    })(tool, { value: 'x' });
    expect(result.ok).toBe(false);
    expect(events).toEqual(['before', 'error', 'after']);
  });
});
