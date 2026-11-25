import { z } from 'zod';
import { AppError } from '../../contract/errors';
import { isRecord } from '../../internal/typed';
import { assertNoLegacyTransports } from '../internal/expose';
import { readDiscoveredToolAnnotations } from '../read-operation';
import { defineRuntimeTool, type RuntimeToolDefinition } from '../runtime-tool';
import { listMcpCatalog } from './catalog-cache';
import { McpHttpClient } from './mcp-client';
import { mcpToolFailure, unwrapMcpResult } from './mcp-envelope';
import {
  type ConnectionToolSkipReporter,
  mountToolsTolerantly,
  withConnectionToken,
  zodObjectFromJsonSchema,
  zodOutputFromJsonSchema,
} from './runtime';
import { jsonSchemaBytes, recordForeignSchemaBytes } from './schema-budget';
import { assertAllowedHost, assertConnectionUrl, connectionAllowedHosts } from './ssrf';
import type { DiscoveredMcpTool, McpClientConnection, McpToolFilter } from './types';

interface DiscoveredMcpEntry extends DiscoveredMcpTool {
  invalidOutputSchema?: string;
}

/** Discover and mount every tool one MCP connection exposes. */
export async function mountMcpConnection(
  connection: McpClientConnection,
  instanceId: string,
  onSkipped: ConnectionToolSkipReporter,
): Promise<RuntimeToolDefinition[]> {
  assertNoLegacyTransports(connection, `MCP connection "${connection.name}"`);
  const url = assertConnectionUrl(connection.transport.url, connection.name);
  const allowedHosts = connectionAllowedHosts(url, connection.allowHosts);
  assertAllowedHost(url, allowedHosts, connection.name);

  const createClient = () =>
    new McpHttpClient(connection.name, instanceId, {
      transport: connection.transport,
      allowedHosts,
      ...(connection.timeoutMs !== undefined && { timeoutMs: connection.timeoutMs }),
      ...(connection.maxResponseBytes !== undefined && {
        maxResponseBytes: connection.maxResponseBytes,
      }),
      ...(connection.limits && { limits: connection.limits }),
    });
  const discovery = createClient();
  const listed = await withConnectionToken(
    { instanceId, provider: connection.token, client: discovery },
    async (token) => {
      await discovery.initialize(token);
      return listMcpCatalog({
        store: connection.catalog,
        served: discovery.servedCatalog(),
        list: () => discovery.request('tools/list', {}, token),
      });
    },
  ).finally(() => discovery.teardown());

  const discovered = readDiscoveredTools(listed, connection.name);
  const filtered = filterMcpTools(discovered, connection.tools);

  return mountToolsTolerantly(
    filtered,
    connection.name,
    (tool) => tool.name,
    (tool) => {
      const name = tool.name;
      if (tool.invalidOutputSchema) throw new Error(tool.invalidOutputSchema);
      const description = tool.description ?? `External MCP tool "${name}"`;
      const input = zodObjectFromJsonSchema(tool.inputSchema, { dialect: 'mcp' });
      const hasOutputSchema = tool.outputSchema !== undefined;
      const output = tool.outputSchema
        ? zodOutputFromJsonSchema(tool.outputSchema, { dialect: 'mcp' })
        : z.unknown();
      const definition = defineRuntimeTool({
        name,
        description,
        // Calling an MCP tool is a POST whatever the tool does; whether it only
        // reads is the server's published hint, carried as it was given.
        identity: { serviceName: connection.name, action: name, method: 'POST' },
        ...(tool.annotations && { annotations: tool.annotations }),
        ...(connection.expose && { expose: connection.expose }),
        input,
        output,
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
              // The failure is relayed on every transport, not just the CLI:
              // a lost error code is missing information, not a presentation
              // choice.
              if (isRecord(result) && result.isError === true)
                throw mcpToolFailure(name, result);
              if (hasOutputSchema) {
                if (!isRecord(result) || result.structuredContent === undefined) {
                  throw new AppError('MCP_STRUCTURED_CONTENT_MISSING', {
                    message: `External MCP tool "${name}" declared outputSchema but returned no structuredContent`,
                    status: 502,
                  });
                }
                return result.structuredContent;
              }
              // The CLI prints, pipes and aggregates this value, so on that
              // transport the answer is the answer — not the envelope carrying
              // it. Every other transport keeps the parts it needs.
              return context.source === 'cli' ? unwrapMcpResult(result) : result;
            },
          ).finally(() => client.teardown());
        },
      });
      recordForeignSchemaBytes(
        definition,
        jsonSchemaBytes(tool.inputSchema) + jsonSchemaBytes(tool.outputSchema),
      );
      return definition;
    },
    onSkipped,
  );
}

function readDiscoveredTools(listed: unknown, connectionName: string): DiscoveredMcpEntry[] {
  if (!isRecord(listed) || !Array.isArray(listed.tools)) {
    throw new Error(`MCP connection "${connectionName}" returned no tools list`);
  }
  const tools: DiscoveredMcpEntry[] = [];
  for (const raw of listed.tools) {
    if (!isRecord(raw) || typeof raw.name !== 'string') continue;
    const annotations = readDiscoveredToolAnnotations(raw.annotations);
    const hasInvalidOutputSchema =
      raw.outputSchema !== undefined &&
      raw.outputSchema !== null &&
      !isRecord(raw.outputSchema);
    tools.push({
      name: raw.name,
      ...(typeof raw.description === 'string' && { description: raw.description }),
      ...(isRecord(raw.inputSchema) && { inputSchema: raw.inputSchema }),
      ...(isRecord(raw.outputSchema) && { outputSchema: raw.outputSchema }),
      ...(hasInvalidOutputSchema && {
        invalidOutputSchema: 'Output JSON Schema must be an object',
      }),
      ...(annotations && { annotations }),
    });
  }
  return tools;
}

function filterMcpTools(
  tools: readonly DiscoveredMcpEntry[],
  filter: McpToolFilter | undefined,
): DiscoveredMcpEntry[] {
  const allow = filter?.allow ? new Set(filter.allow) : undefined;
  const block = new Set(filter?.block ?? []);
  return tools.filter(
    (tool) => (allow === undefined || allow.has(tool.name)) && !block.has(tool.name),
  );
}
