import assert from 'node:assert/strict';
import { Client, StreamableHTTPClientTransport } from '@modelcontextprotocol/client';
import { StdioClientTransport } from '@modelcontextprotocol/client/stdio';
import { defineContract } from 'stitchkit/contract';
import { implement } from 'stitchkit/server';
import { createMcpHandler } from 'stitchkit/tools';
import { z } from 'zod';

const contract = defineContract(
  { prefix: 'node-http', scope: 'public' },
  {
    echo: {
      method: 'POST',
      path: '/echo',
      desc: 'Echo through a packed Node HTTP consumer',
      expose: ['MCP'],
      toolName: 'echo_node_http',
      input: z.object({ text: z.string() }),
      output: z.object({ text: z.string() }),
    },
  },
);
const service = implement(contract, { echo: ({ input }) => input });
const handler = createMcpHandler({
  serverInfo: { name: 'packed-node-http', version: '1' },
  auth: () => ({}),
  security: { allowedHosts: ['consumer.test'] },
  services: [service],
});
const httpTransport = new StreamableHTTPClientTransport(new URL('http://consumer.test/mcp'), {
  fetch: (input, init) => handler.fetch(new Request(input, init)),
});
const httpClient = new Client(
  { name: 'packed-node-http', version: '1' },
  { versionNegotiation: { mode: { pin: '2026-07-28' } } },
);
await httpClient.connect(httpTransport);
assert.deepEqual(
  (
    await httpClient.callTool({
      name: 'echo_node_http',
      arguments: { text: 'packed Node HTTP' },
    })
  ).structuredContent,
  { text: 'packed Node HTTP' },
);
await httpClient.close();
await handler.close();

const stdioTransport = new StdioClientTransport({
  command: process.execPath,
  args: [new URL('./stdio-server.mjs', import.meta.url).pathname],
  stderr: 'pipe',
});
const stdioClient = new Client(
  { name: 'packed-node-stdio', version: '1' },
  { versionNegotiation: { mode: { pin: '2026-07-28' } } },
);
await stdioClient.connect(stdioTransport);
const result = await stdioClient.callTool({
  name: 'echo_node',
  arguments: { text: 'packed Node stdio' },
});
assert.deepEqual(result.structuredContent, { text: 'packed Node stdio' });
await stdioClient.close();

console.log('node consumer: ok (HTTP + stdio MCP)');
