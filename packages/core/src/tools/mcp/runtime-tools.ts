import type { CallToolResult, McpServer } from '@modelcontextprotocol/server';
import type { ToolCallHooks, ToolLifecycle, ToolResult } from '../execute';
import { createToolRunner } from '../mount';
import type { McpCatalogStamp } from './catalog';
import type { PreparedRuntimeMcpTool } from './prepare';
import { registerMcpTool } from './register';
import type { McpRoundRuntime } from './round';

interface NativeMcpRuntimeConfig {
  context?: Record<string, unknown>;
  hooks?: ToolCallHooks;
  lifecycle?: ToolLifecycle;
  coerceJsonArgs?: boolean;
  onOutputStrip?: (toolName: string, paths: string[]) => void;
  multiRoundRuntime?: McpRoundRuntime;
  /** The catalog this surface advertises, stamped onto listings and results. */
  catalog?: McpCatalogStamp;
  formatResult: (
    result: ToolResult,
    mode: PreparedRuntimeMcpTool['descriptor']['outputMode'],
    toolName: string,
  ) => CallToolResult;
}

/**
 * Mount immutable runtime-tool descriptors onto one fresh MCP server/runtime —
 * through the same runner and the same registration as contract endpoints; a
 * runtime tool only brings its own description, hints and MCP presenter.
 */
export function mountPreparedRuntimeMcp(
  server: McpServer,
  tools: readonly PreparedRuntimeMcpTool[],
  config: NativeMcpRuntimeConfig,
): void {
  const runTool = createToolRunner({
    source: 'mcp',
    toolSurface: true,
    context: config.context,
    hooks: config.hooks,
    lifecycle: config.lifecycle,
    coerceJsonArgs: config.coerceJsonArgs,
    onOutputStrip: config.onOutputStrip,
  });
  for (const { definition, descriptor } of tools) {
    const present = definition.present?.mcp;
    registerMcpTool(
      server,
      {
        name: definition.name,
        description: definition.description,
        annotations: definition.annotations,
        ui: definition.ui,
        ...(present && { present: (data: unknown) => present(data) }),
      },
      descriptor,
      {
        runTool,
        formatResult: config.formatResult,
        catalog: config.catalog,
        multiRoundRuntime: config.multiRoundRuntime,
      },
    );
  }
}
