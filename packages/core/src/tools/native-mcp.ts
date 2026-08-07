import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { type CallToolResult, CallToolResultSchema } from '@modelcontextprotocol/sdk/types.js';
import { z } from 'zod';
import type { EndpointToolAnnotations } from '../contract';
import { isRecord } from '../internal/typed';
import { executeToolMethod, type ToolCallHooks, type ToolLifecycle } from './execute';
import type { PreparedMcpSurface } from './mcp';
import { assertUniqueToolName } from './names';
import { presentationMetadata } from './presentation';
import {
  type RuntimeToolDefinition,
  type RuntimeToolDefinitionWithOutput,
  type RuntimeToolDefinitionWithoutOutput,
  runtimeToolMountable,
  runtimeToolSupports,
} from './runtime-tool';

export interface NativeMcpRegistrar {
  /** Register through stitchkit validation, lifecycle, context and tool hooks. */
  registerTool<TInput extends z.ZodObject, TOutput extends z.ZodType>(
    definition: RuntimeToolDefinitionWithOutput<TInput, TOutput>,
  ): void;
  registerTool<TInput extends z.ZodObject>(
    definition: RuntimeToolDefinitionWithoutOutput<TInput>,
  ): void;
  /**
   * Explicit SDK escape hatch. Registrations made here do not run stitchkit
   * validation, lifecycle, per-call context or tool hooks.
   */
  readonly rawServer: McpServer;
}

interface NativeMcpRuntimeConfig {
  context?: Record<string, unknown>;
  hooks?: ToolCallHooks;
  lifecycle?: ToolLifecycle;
  coerceJsonArgs?: boolean;
  onOutputStrip?: (toolName: string, paths: string[]) => void;
  takenNames: Set<string>;
  prepare: (tool: ReturnType<typeof runtimeToolMountable>) => PreparedMcpSurface;
  formatResult: (
    result: Awaited<ReturnType<typeof executeToolMethod>>,
    mode: PreparedMcpSurface[number]['outputMode'],
    toolName: string,
  ) => CallToolResult;
}

function isCallToolResult(value: unknown): value is CallToolResult {
  return CallToolResultSchema.safeParse(value).success;
}

/** Build the protected registrar for one fresh MCP server/runtime. */
export function createNativeMcpRegistrar(
  server: McpServer,
  config: NativeMcpRuntimeConfig,
): NativeMcpRegistrar {
  return {
    rawServer: server,
    registerTool: (definition: RuntimeToolDefinition) => {
      if (!runtimeToolSupports(definition, 'MCP')) return;
      assertUniqueToolName(
        definition.name,
        config.takenNames.has(definition.name),
        'MCP tool name',
      );
      config.takenNames.add(definition.name);
      const mountable = runtimeToolMountable(definition);
      const [prepared] = config.prepare(mountable);
      if (!prepared) return;

      const toolConfig: {
        description: string;
        inputSchema: z.ZodType;
        outputSchema?: z.ZodType;
        annotations?: EndpointToolAnnotations;
        _meta?: Record<string, unknown>;
      } = {
        description: definition.description,
        inputSchema: z.looseObject({}).meta(presentationMetadata(prepared.inputSchema)),
      };
      if (prepared.outputSchema) toolConfig.outputSchema = prepared.outputSchema;
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
          return config.formatResult(result, prepared.outputMode, definition.name);
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
          prepared.outputMode,
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
    },
  };
}
