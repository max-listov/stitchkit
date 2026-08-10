import {
  type CallToolResult,
  isCallToolResult,
  type McpServer,
} from '@modelcontextprotocol/server';
import { z } from 'zod';
import { AppError, type EndpointToolAnnotations } from '../contract';
import { isRecord } from '../internal/typed';
import { executeToolMethod, type ToolCallHooks, type ToolLifecycle } from './execute';
import type { PreparedRuntimeMcpTool } from './mcp-prepare';
import type { McpRoundRuntime } from './mcp-round';
import { resolveMcpRound } from './mcp-round';
import { runInMcpRequestContext } from './mcp-trace';
import { presentationMetadata } from './presentation';

interface NativeMcpRuntimeConfig {
  context?: Record<string, unknown>;
  hooks?: ToolCallHooks;
  lifecycle?: ToolLifecycle;
  coerceJsonArgs?: boolean;
  onOutputStrip?: (toolName: string, paths: string[]) => void;
  multiRoundRuntime?: McpRoundRuntime;
  formatResult: (
    result: Awaited<ReturnType<typeof executeToolMethod>>,
    mode: PreparedRuntimeMcpTool['descriptor']['outputMode'],
    toolName: string,
  ) => CallToolResult;
}

/** Mount immutable runtime-tool descriptors onto one fresh MCP server/runtime. */
export function mountPreparedRuntimeMcp(
  server: McpServer,
  tools: readonly PreparedRuntimeMcpTool[],
  config: NativeMcpRuntimeConfig,
): void {
  for (const { definition, descriptor } of tools) {
    const { mountable } = descriptor;

    const toolConfig: {
      description: string;
      inputSchema: z.ZodType;
      outputSchema?: z.ZodType;
      annotations?: EndpointToolAnnotations;
      _meta?: Record<string, unknown>;
    } = {
      description: definition.description,
      inputSchema: z.looseObject({}).meta(presentationMetadata(descriptor.inputSchema)),
    };
    if (descriptor.outputSchema) toolConfig.outputSchema = descriptor.outputSchema;
    if (definition.annotations) toolConfig.annotations = definition.annotations;
    if (definition.ui) {
      toolConfig._meta = {
        ui: definition.ui,
        'ui/resourceUri': definition.ui.resourceUri,
      };
    }

    server.registerTool(definition.name, toolConfig, async (rawArgs, mcpContext) =>
      runInMcpRequestContext(mcpContext, definition.name, async () => {
        const args = isRecord(rawArgs) ? rawArgs : {};
        const runTool = (
          tool: typeof mountable,
          toolArgs: Record<string, unknown>,
          roundContext?: Record<string, unknown>,
        ) =>
          executeToolMethod(
            tool.method,
            definition.name,
            toolArgs,
            { ...config.context, ...roundContext, source: 'mcp' },
            config.hooks,
            config.lifecycle,
            config.coerceJsonArgs ?? true,
            config.onOutputStrip
              ? (paths) => config.onOutputStrip?.(definition.name, paths)
              : undefined,
          );
        const round = await resolveMcpRound({
          tool: mountable,
          rawArgs: args,
          context: mcpContext,
          policy: mountable.method.mcp,
          runtime: config.multiRoundRuntime,
          runTool,
          formatFailure: (result) => config.formatResult(result, 'none', definition.name),
        });
        if (round.kind === 'response') return round.response;
        if (!definition.present?.mcp) {
          const result = await runTool(mountable, args, round.context);
          return config.formatResult(result, descriptor.outputMode, definition.name);
        }
        const presentedResult = await executeToolMethod(
          mountable.method,
          definition.name,
          args,
          { ...config.context, ...round.context, source: 'mcp' },
          config.hooks,
          config.lifecycle,
          config.coerceJsonArgs ?? true,
          config.onOutputStrip
            ? (paths) => config.onOutputStrip?.(definition.name, paths)
            : undefined,
          undefined,
          async (data) => {
            const presented = await definition.present?.mcp?.(data);
            if (!presented) {
              throw new AppError(
                'INTERNAL_SERVER_ERROR',
                'Runtime MCP presenter did not return a result',
                500,
              );
            }
            if ('structuredContent' in presented || 'isError' in presented) {
              throw new AppError(
                'INTERNAL_SERVER_ERROR',
                'Runtime MCP presenter cannot set framework-owned structuredContent or isError',
                500,
              );
            }
            const structured = config.formatResult(
              { ok: true, data },
              descriptor.outputMode,
              definition.name,
            ).structuredContent;
            const response =
              structured === undefined
                ? presented
                : { ...presented, structuredContent: structured };
            if (!isCallToolResult(response)) {
              throw new AppError(
                'INTERNAL_SERVER_ERROR',
                'Runtime MCP presenter returned an invalid CallToolResult',
                500,
              );
            }
            return response;
          },
        );
        if (!presentedResult.ok) {
          return config.formatResult(presentedResult, 'none', definition.name);
        }
        if (!isCallToolResult(presentedResult.data)) {
          throw new Error('[stitchkit] Runtime MCP presenter invariant failed');
        }
        return presentedResult.data;
      }),
    );
  }
}
