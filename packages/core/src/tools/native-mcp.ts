import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { type CallToolResult, CallToolResultSchema } from '@modelcontextprotocol/sdk/types.js';
import { z } from 'zod';
import type { EndpointToolAnnotations } from '../contract';
import { isRecord } from '../internal/typed';
import { executeToolMethod, type ToolCallHooks, type ToolLifecycle } from './execute';
import type { PreparedRuntimeMcpTool } from './mcp';
import { presentationMetadata } from './presentation';

interface NativeMcpRuntimeConfig {
  context?: Record<string, unknown>;
  hooks?: ToolCallHooks;
  lifecycle?: ToolLifecycle;
  coerceJsonArgs?: boolean;
  onOutputStrip?: (toolName: string, paths: string[]) => void;
  formatResult: (
    result: Awaited<ReturnType<typeof executeToolMethod>>,
    mode: PreparedRuntimeMcpTool['descriptor']['outputMode'],
    toolName: string,
  ) => CallToolResult;
}

function isCallToolResult(value: unknown): value is CallToolResult {
  return CallToolResultSchema.safeParse(value).success;
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

    server.registerTool(definition.name, toolConfig, async (rawArgs) => {
      const args = isRecord(rawArgs) ? rawArgs : {};
      const result = await executeToolMethod(
        mountable.method,
        definition.name,
        args,
        { ...config.context, source: 'mcp' },
        config.hooks,
        config.lifecycle,
        config.coerceJsonArgs ?? true,
        config.onOutputStrip
          ? (paths) => config.onOutputStrip?.(definition.name, paths)
          : undefined,
      );
      if (!result.ok || !definition.present?.mcp) {
        return config.formatResult(result, descriptor.outputMode, definition.name);
      }
      const presented = await definition.present.mcp(result.data);
      if ('structuredContent' in presented || 'isError' in presented) {
        return config.formatResult(
          {
            ok: false,
            code: 'INTERNAL_SERVER_ERROR',
            details: {
              message:
                'Runtime MCP presenter cannot set framework-owned structuredContent or isError',
            },
          },
          'none',
          definition.name,
        );
      }
      const structured = config.formatResult(
        result,
        descriptor.outputMode,
        definition.name,
      ).structuredContent;
      const response = {
        ...presented,
        ...(structured && { structuredContent: structured }),
      };
      if (isCallToolResult(response)) return response;
      return config.formatResult(
        {
          ok: false,
          code: 'INTERNAL_SERVER_ERROR',
          details: { message: 'Runtime MCP presenter returned an invalid CallToolResult' },
        },
        'none',
        definition.name,
      );
    });
  }
}
