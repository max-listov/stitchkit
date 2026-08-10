import { serveStdio } from '@modelcontextprotocol/server/stdio';
import { buildMcpServer, type McpServerBuildConfig, type McpSurfaceRegistry } from './mcp';
import type { McpLegacyPolicy } from './mcp-handler';

export interface StdioAuthConfig<TAuth> {
  /** Identity for the single stdio connection. */
  auth: TAuth | Promise<TAuth>;
  /** Serve a legacy opening handshake or require the modern protocol. Default: `serve`. */
  legacy?: McpLegacyPolicy;
}

export type StdioMcpServerConfig<
  TAuth,
  TSurfaces extends McpSurfaceRegistry = McpSurfaceRegistry,
> = McpServerBuildConfig<TAuth, TSurfaces> & StdioAuthConfig<TAuth>;

/** Framework-owned lifecycle handle for one stdio MCP connection. */
export interface McpStdioHandle {
  close(): Promise<void>;
}

/**
 * Serve one dual-era MCP connection over process stdio. The official SDK owns
 * opening-era negotiation and transport shutdown; Stitchkit owns the surface.
 */
export async function createStdioMcpServer<TAuth>(
  config: StdioMcpServerConfig<TAuth>,
): Promise<McpStdioHandle> {
  const auth = await config.auth;
  return serveStdio(() => buildMcpServer(config, auth), {
    legacy: config.legacy ?? 'serve',
    maxSubscriptions: 0,
  });
}
