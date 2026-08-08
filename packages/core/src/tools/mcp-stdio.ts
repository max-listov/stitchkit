import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { buildMcpServer, type McpServerBuildConfig, type McpSurfaceRegistry } from './mcp';

/**
 * Config for a stdio MCP server. Unlike the HTTP handler, a stdio server is a
 * single process serving one client — identity is resolved ONCE at startup
 * (from an env var / CLI arg), not per request.
 */
export interface StdioAuthConfig<TAuth> {
  /** Identity for the single stdio session — a value or a promise of one. */
  auth: TAuth | Promise<TAuth>;
}

export type StdioMcpServerConfig<
  TAuth,
  TSurfaces extends McpSurfaceRegistry = McpSurfaceRegistry,
> = McpServerBuildConfig<TAuth, TSurfaces> & StdioAuthConfig<TAuth>;

/**
 * Build an MCP server and connect it over stdio — the server runs as a
 * subprocess of the MCP client, on the client's machine, so it can reach the
 * client's local filesystem.
 *
 * Same contract pipeline as `createMcpHandler` (`buildMcpServer`); only the
 * transport differs. For a local CLI: resolve the identity from `process.env`
 * and pass it as `auth`.
 *
 * Note: stdout is reserved for the JSON-RPC stream — the caller MUST keep all
 * logging on stderr (`console.error`), never `console.log`.
 */
export async function createStdioMcpServer<TAuth>(
  config: StdioMcpServerConfig<TAuth>,
): Promise<McpServer> {
  const auth = await config.auth;
  const server = buildMcpServer(config, auth);
  await server.connect(new StdioServerTransport());
  return server;
}
