import { z } from 'zod';
import { isRecord } from '../../internal/typed';
import { defineRuntimeTool, type RuntimeToolDefinition } from '../runtime-tool';
import { connectionMaxResponseBytes, connectionTimeoutMs } from './limits';
import { McpHttpClient } from './mcp-client';
import { withConnectionToken, zodObjectFromJsonSchema } from './runtime';
import { jsonSchemaBytes, recordForeignSchemaBytes } from './schema-budget';
import { assertAllowedHost, assertConnectionUrl, connectionAllowedHosts } from './ssrf';
import type { McpClientConnection, McpToolFilter } from './types';

interface DiscoveredMcpTool {
  name: string;
  description?: string;
  inputSchema?: Record<string, unknown>;
}

/** Discover and mount every tool one MCP connection exposes. */
export async function mountMcpConnection(
  connection: McpClientConnection,
  instanceId: string,
): Promise<RuntimeToolDefinition[]> {
  const url = assertConnectionUrl(connection.transport.url, connection.name);
  const allowedHosts = connectionAllowedHosts(url, connection.allowHosts);
  assertAllowedHost(url, allowedHosts, connection.name);

  const createClient = () =>
    new McpHttpClient(connection.name, instanceId, {
      transport: connection.transport,
      allowedHosts,
      timeoutMs: connectionTimeoutMs(connection.timeoutMs),
      maxResponseBytes: connectionMaxResponseBytes(connection.maxResponseBytes),
    });
  const discovery = createClient();
  const listed = await withConnectionToken(
    { instanceId, provider: connection.token, client: discovery },
    async (token) => {
      await discovery.initialize(token);
      return discovery.request('tools/list', {}, token);
    },
  ).finally(() => discovery.teardown());

  const discovered = readDiscoveredTools(listed, connection.name);
  const filtered = filterMcpTools(discovered, connection.tools);

  return filtered.map((tool) => {
    const name = tool.name;
    const description = tool.description ?? `External MCP tool "${name}"`;
    const input = zodObjectFromJsonSchema(tool.inputSchema);
    const definition = defineRuntimeTool({
      name,
      description,
      identity: { serviceName: connection.name, action: name, method: 'POST' },
      input,
      output: z.unknown(),
      handler: (context) => {
        const client = createClient();
        return withConnectionToken(
          { instanceId, provider: connection.token, client, context },
          async (token) => {
            await client.initialize(token, context.signal);
            const result = await client.request(
              'tools/call',
              { name, arguments: context.input },
              token,
              context.signal,
            );
            if (isRecord(result) && result.isError === true) {
              throw new Error(`External MCP tool "${name}" returned an error`);
            }
            return result;
          },
        ).finally(() => client.teardown());
      },
    });
    recordForeignSchemaBytes(definition, jsonSchemaBytes(tool.inputSchema));
    return definition;
  });
}

function readDiscoveredTools(listed: unknown, connectionName: string): DiscoveredMcpTool[] {
  if (!isRecord(listed) || !Array.isArray(listed.tools)) {
    throw new Error(`MCP connection "${connectionName}" returned no tools list`);
  }
  const tools: DiscoveredMcpTool[] = [];
  for (const raw of listed.tools) {
    if (!isRecord(raw) || typeof raw.name !== 'string') continue;
    tools.push({
      name: raw.name,
      ...(typeof raw.description === 'string' && { description: raw.description }),
      ...(isRecord(raw.inputSchema) && { inputSchema: raw.inputSchema }),
    });
  }
  return tools;
}

function filterMcpTools(
  tools: readonly DiscoveredMcpTool[],
  filter: McpToolFilter | undefined,
): DiscoveredMcpTool[] {
  const allow = filter?.allow ? new Set(filter.allow) : undefined;
  const block = new Set(filter?.block ?? []);
  return tools.filter(
    (tool) => (allow === undefined || allow.has(tool.name)) && !block.has(tool.name),
  );
}
