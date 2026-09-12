import type { RuntimeToolDefinition } from '../runtime-tool';
import { ConnectionBudgetExceededError } from './errors';
import { connectionInstanceId } from './instance';
import { mountMcpConnection } from './mcp';
import { mountOpenApiConnection } from './openapi';
import { foreignSchemaBytes } from './schema-budget';
import type { ConnectionDefinition, ConnectionMountOptions } from './types';

/**
 * Mount external MCP servers and OpenAPI specs as the same
 * `RuntimeToolDefinition`s our own operations produce, so `mountAgent` runs
 * them through the canonical lifecycle, hooks and approval path.
 *
 * Discovery is a network read, so the returned promise resolves once every
 * connection has answered its `tools/list` or `processes` its document.
 */
export async function mountConnections(
  connections: readonly ConnectionDefinition[],
  options: ConnectionMountOptions = {},
): Promise<readonly RuntimeToolDefinition[]> {
  const tools: RuntimeToolDefinition[] = [];
  for (const connection of connections) {
    const instanceId = instanceIdOf(connection);
    const mounted =
      connection.kind === 'mcp'
        ? await mountMcpConnection(connection, instanceId)
        : await mountOpenApiConnection(connection, instanceId);
    tools.push(...mounted);
  }
  const limit = options.budget?.maxTools;
  if (limit !== undefined && tools.length > limit) {
    throw new ConnectionBudgetExceededError(limit, tools.length);
  }
  const schemaLimit = options.budget?.maxSchemaBytes;
  if (schemaLimit !== undefined) {
    const schemaBytes = tools.reduce((total, tool) => total + foreignSchemaBytes(tool), 0);
    if (schemaBytes > schemaLimit) {
      throw new ConnectionBudgetExceededError(schemaLimit, schemaBytes, 'schema bytes');
    }
  }
  return tools;
}

function instanceIdOf(connection: ConnectionDefinition): string {
  let url: string;
  if (connection.kind === 'mcp') {
    url = connection.transport.url;
  } else if (connection.baseUrl) {
    url = connection.baseUrl;
  } else if (typeof connection.spec === 'string') {
    url = connection.spec;
  } else {
    url = JSON.stringify(connection.spec);
  }
  return connectionInstanceId(connection.name, url, connection.instanceKey);
}
