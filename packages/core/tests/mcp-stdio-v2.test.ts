import { describe, expect, test } from 'bun:test';
import { Client } from '@modelcontextprotocol/client';
import { StdioClientTransport } from '@modelcontextprotocol/client/stdio';

const fixture = new URL('./fixtures/mcp-stdio-server.ts', import.meta.url).pathname;

describe('Stitchkit MCP v2 stdio entrypoint', () => {
  test('serves a modern list and real tool call through the official client transport', async () => {
    const transport = new StdioClientTransport({
      command: process.execPath,
      args: [fixture],
      stderr: 'pipe',
    });
    const client = new Client(
      { name: 'stitchkit-stdio-client', version: '1' },
      {
        versionNegotiation: { mode: { pin: '2026-07-28' } },
        capabilities: { elicitation: { form: {} } },
      },
    );
    client.setRequestHandler('elicitation/create', async () => ({
      action: 'accept',
      content: { confirmed: true },
    }));
    await client.connect(transport);
    const listed = await client.listTools();
    expect(listed.tools.map((tool) => tool.name)).toEqual([
      'echo_stdio',
      'values_stdio',
      'trace_stdio',
      'confirm_stdio',
    ]);
    const called = await client.callTool({
      name: 'echo_stdio',
      arguments: { text: 'modern stdio' },
    });
    expect(called.structuredContent).toEqual({ text: 'modern stdio' });
    const values = await client.callTool({ name: 'values_stdio', arguments: {} });
    expect(values.structuredContent).toEqual(['one', 'two']);
    const traceId = '4bf92f3577b34da6a3ce929d0e0e4736';
    const parentSpanId = '00f067aa0ba902b7';
    const traced = await client.callTool({
      name: 'trace_stdio',
      arguments: {},
      _meta: {
        traceparent: `00-${traceId}-${parentSpanId}-01`,
        tracestate: 'vendor=stdio',
        baggage: 'region=local',
      },
    });
    expect(traced.structuredContent).toMatchObject({
      traceId,
      parentSpanId,
      tracestate: 'vendor=stdio',
      baggage: 'region=local',
    });
    const confirmed = await client.callTool({
      name: 'confirm_stdio',
      arguments: { operation: 'modern stdio' },
    });
    expect(confirmed.structuredContent).toEqual({
      operation: 'modern stdio',
      confirmed: true,
    });
    await client.close();
  });

  test('keeps the official legacy stdio lane stateless and functional', async () => {
    const transport = new StdioClientTransport({
      command: process.execPath,
      args: [fixture],
      stderr: 'pipe',
    });
    const client = new Client(
      { name: 'stitchkit-stdio-legacy-client', version: '1' },
      {
        versionNegotiation: { mode: 'legacy' },
        capabilities: { elicitation: { form: {} } },
      },
    );
    client.setRequestHandler('elicitation/create', async () => ({
      action: 'accept',
      content: { confirmed: true },
    }));
    await client.connect(transport);
    expect(client.getNegotiatedProtocolVersion()).toBe('2025-11-25');
    const called = await client.callTool({
      name: 'echo_stdio',
      arguments: { text: 'legacy stdio' },
    });
    expect(called.structuredContent).toEqual({ text: 'legacy stdio' });
    const confirmed = await client.callTool({
      name: 'confirm_stdio',
      arguments: { operation: 'legacy stdio' },
    });
    expect(confirmed.structuredContent).toEqual({
      operation: 'legacy stdio',
      confirmed: true,
    });
    await client.close();
  });
});
