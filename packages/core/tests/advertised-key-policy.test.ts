import { describe, expect, test } from 'bun:test';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { asSchema } from 'ai';
import { z } from 'zod';
import { defineContract } from '../src/contract';
import { isRecord } from '../src/internal/typed';
import { implement } from '../src/server';
import { mountAgent } from '../src/tools/agent';
import { mountMcp } from '../src/tools/mcp';

function serviceFor(input: z.ZodType, receive: (value: unknown) => void) {
  const contract = defineContract(
    { prefix: 'flow' },
    { patch: { method: 'POST', path: '/', desc: 'Patch', input } },
  );
  return implement(contract, {
    patch: (context) => {
      receive(context.input);
      return undefined;
    },
  });
}

async function roundTrip(
  input: z.ZodType,
  args: Record<string, unknown>,
  options: Parameters<typeof mountMcp>[2] = {},
) {
  const received: unknown[] = [];
  const server = new McpServer({ name: 'test', version: '1' });
  mountMcp(
    server,
    serviceFor(input, (value) => received.push(value)),
    options,
  );
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: 'client', version: '1' });
  await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
  const result = await client.callTool({ name: 'patch_flow', arguments: args });
  await client.close();
  return { result, received };
}

describe('presentation schemas never execute contract effects', () => {
  test('MCP validates a strict input in the framework runner and fires both hooks', async () => {
    const fired: string[] = [];
    const { result, received } = await roundTrip(
      z.object({ value: z.string() }).strict(),
      { value: 'x', dirt: true },
      {
        hooks: {
          beforeToolCall: () => void fired.push('before'),
          afterToolCall: () => void fired.push('after'),
        },
      },
    );
    expect(result.isError).toBe(true);
    expect(JSON.stringify(result)).toContain('dirt');
    expect(received).toEqual([]);
    expect(fired).toEqual(['before', 'after']);
  });

  test('MCP keeps loose keys until the original contract parser handles them', async () => {
    const { result, received } = await roundTrip(z.object({ value: z.string() }).loose(), {
      value: 'x',
      extra: 7,
    });
    expect(result.isError).not.toBe(true);
    expect(received).toEqual([{ value: 'x', extra: 7 }]);
  });

  test('MCP advertises the prepared document but its carrier returns raw args', async () => {
    const calls: string[] = [];
    const input = z.object({
      value: z.string().transform((value) => {
        calls.push(value);
        return `${value}!`;
      }),
    });
    const { received } = await roundTrip(input, { value: 'x' });
    expect(calls).toEqual(['x']);
    expect(received).toEqual([{ value: 'x!' }]);
  });

  test('AI SDK validator is identity-only and execute reaches the runner once', async () => {
    const calls: string[] = [];
    const received: unknown[] = [];
    const tools = mountAgent(
      serviceFor(
        z.object({
          value: z.string().transform((value) => {
            calls.push(value);
            return `${value}!`;
          }),
        }),
        (value) => received.push(value),
      ),
    );
    const agentTool = tools.patch_flow;
    if (!agentTool) throw new Error('expected tool');
    const validated = await asSchema(agentTool.inputSchema).validate?.({ value: 'x' });
    expect(validated).toEqual({ success: true, value: { value: 'x' } });
    expect(calls).toEqual([]);
    if (typeof agentTool.execute !== 'function') throw new Error('expected executable tool');
    await Reflect.apply(agentTool.execute, undefined, [
      { value: 'x' },
      { toolCallId: 'call', messages: [], abortSignal: undefined },
    ]);
    expect(calls).toEqual(['x']);
    expect(received).toEqual([{ value: 'x!' }]);
  });

  test('MCP tools/list exposes the real JSON Schema metadata', async () => {
    const server = new McpServer({ name: 'test', version: '1' });
    mountMcp(
      server,
      serviceFor(z.object({ value: z.string() }).strict(), () => undefined),
    );
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    const client = new Client({ name: 'client', version: '1' });
    await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
    const listed = await client.listTools();
    const schema = listed.tools[0]?.inputSchema;
    expect(isRecord(schema) && schema.additionalProperties).toBe(false);
    await client.close();
  });
});
