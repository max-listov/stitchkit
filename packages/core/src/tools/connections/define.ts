import { connectionMaxResponseBytes, connectionTimeoutMs } from './limits';
import { resolveMcpLimits } from './operation-limits';
import { assertConnectionUrl } from './ssrf';
import type {
  McpClientConnection,
  McpClientConnectionConfig,
  OpenApiConnection,
  OpenApiConnectionConfig,
} from './types';

/** Define one external MCP server connection. */
export function defineMcpClientConnection(
  config: McpClientConnectionConfig,
): McpClientConnection {
  if (!config.name.trim()) throw new Error('MCP connection requires a name');
  assertConnectionUrl(config.transport.url, config.name);
  resolveMcpLimits(config);
  return { ...config, kind: 'mcp' };
}

/** Define one external OpenAPI connection. */
export function defineOpenApiConnection(config: OpenApiConnectionConfig): OpenApiConnection {
  if (!config.name.trim()) throw new Error('OpenAPI connection requires a name');
  if (config.baseUrl) assertConnectionUrl(config.baseUrl, config.name);
  connectionTimeoutMs(config.timeoutMs);
  connectionMaxResponseBytes(config.maxResponseBytes);
  return { ...config, kind: 'openapi' };
}
