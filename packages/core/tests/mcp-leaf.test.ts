import { expect, test } from 'bun:test';
import { Client, InMemoryTransport } from '@modelcontextprotocol/client';
import { z } from 'zod';
import {
  buildMcpServer,
  type RuntimeMcpToolPresenters,
  type RuntimeToolDefinitionWithOutput,
} from '../src/entrypoints/tools/mcp';
import { defineRuntimeTool } from '../src/tools/runtime-tool';

test('MCP leaf keeps canonical parsing and full SDK tool compatibility', async () => {
  const input = z.object({ value: z.number() });
  const output = z.object({ doubled: z.number() });
  const definition = {
    name: 'double',
    description: 'Double a number',
    identity: { serviceName: 'numbers', action: 'double', method: 'POST' },
    input,
    output,
    handler: ({ input }) => ({ doubled: input.value * 2 }),
    present: {
      mcp: ({ doubled }) => ({ content: [{ type: 'text', text: `answer:${doubled}` }] }),
    },
  } satisfies RuntimeToolDefinitionWithOutput<
    typeof input,
    typeof output,
    undefined,
    RuntimeMcpToolPresenters<z.output<typeof output>>
  >;
  const full = defineRuntimeTool({
    ...definition,
    present: { ...definition.present, agent: () => ({ type: 'text', value: 'shared' }) },
  });
  const server = buildMcpServer({
    serverInfo: { name: 'leaf', version: '1' },
    services: [],
    runtimeTools: [full],
  });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: 'leaf-test', version: '1' });
  try {
    await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
    expect((await client.listTools()).tools.map((tool) => tool.name)).toEqual(['double']);
    const result = await client.callTool({ name: 'double', arguments: { value: 4 } });
    expect(result.structuredContent).toEqual({ doubled: 8 });
    expect(result.content).toEqual([{ type: 'text', text: 'answer:8' }]);
    const invalid = await client.callTool({ name: 'double', arguments: { value: 'wrong' } });
    expect(invalid.isError).toBe(true);
  } finally {
    await client.close();
    await server.close();
  }
});
