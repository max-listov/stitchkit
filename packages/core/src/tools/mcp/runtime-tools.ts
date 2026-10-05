import type { CallToolResult, McpServer } from '@modelcontextprotocol/server';
import { isRecord } from '../../internal/typed';
import type { ToolCallHooks, ToolLifecycle } from '../execute-hooks';
import type { ToolResult } from '../execute-result';
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

type McpPresenter = (output: unknown) => unknown;

/**
 * A presenter was typed against its own tool's output when the tool was declared;
 * the canonical runner parses the output before calling it. This predicate
 * restores that type for the registration, which holds every presenter as `unknown`.
 */
function isMcpPresenter(value: unknown): value is McpPresenter {
  return typeof value === 'function';
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
    const { present: presenters } = definition;
    const present =
      isRecord(presenters) && isMcpPresenter(presenters.mcp) ? presenters.mcp : undefined;
    registerMcpTool(
      server,
      {
        name: definition.name,
        description: definition.description,
        annotations: definition.annotations,
        ui: definition.ui,
        ...(present && { present }),
      },
      descriptor,
      {
        runTool,
        formatResult: config.formatResult,
        catalog: config.catalog,
        multiRoundRuntime: config.multiRoundRuntime,
        hooks: config.hooks,
        context: config.context,
      },
    );
  }
}
