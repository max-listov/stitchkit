/**
 * `stitchkit/tools/connections` — consume external MCP servers and OpenAPI
 * specs as typed tools.
 *
 * This is a server-only subexport of `stitchkit/tools`: a connection pulls in no
 * peer package into the stable tools import, but mounts its foreign operations
 * as plain `RuntimeToolDefinition`s, so `mountAgent({ runtimeTools })` runs them
 * through the same lifecycle, hooks and approval path as our own.
 *
 * A connection URL is application configuration, not a trust boundary: every
 * outbound request is checked against the connection's own host (plus any
 * explicit `allowHosts`), and credentials are resolved separately for each call.
 */

export { defineMcpClientConnection, defineOpenApiConnection } from './define';
export {
  ConnectionAuthorizationRequiredError,
  ConnectionBudgetExceededError,
  ConnectionRequestError,
  ConnectionUrlError,
} from './errors';
export { mountConnections } from './mount';
export type { ConnectionTokenProvider } from './runtime';
export type {
  ConnectionBudget,
  ConnectionDefinition,
  ConnectionMountOptions,
  McpClientConnection,
  McpClientConnectionConfig,
  McpConnectionTransport,
  McpToolFilter,
  OpenApiConnection,
  OpenApiConnectionConfig,
} from './types';
