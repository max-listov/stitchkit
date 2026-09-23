import {
  type CallToolResult,
  isCallToolResult,
  type McpServer,
} from '@modelcontextprotocol/server';
import { z } from 'zod';
import { AppError } from '../../contract/errors';
import type { EndpointToolAnnotations, EndpointUiMeta } from '../../contract/tool-options';
import { isRecord } from '../../internal/typed';
import type { ToolExecutionOptions } from '../execute';
import { type ToolResult, toolResultFromError } from '../execute-result';
import type { MountableTool } from '../mount';
import { presentationMetadata } from '../schema/presentation';
import { type McpCatalogStamp, stampToolRegistration, stampToolResult } from './catalog';
import type { PreparedMcpTool } from './prepare';
import { type McpRoundRuntime, resolveMcpRound } from './round';
import { runInMcpRequestContext } from './trace';

/** What the host is told about a tool — contract endpoints and runtime tools alike. */
export interface McpToolPresentation {
  name: string;
  description: string;
  annotations?: EndpointToolAnnotations;
  ui?: EndpointUiMeta;
  /** A runtime tool's own MCP answer, built from its validated output. */
  present?: (data: unknown) => unknown | Promise<unknown>;
}

/** The runner every registered tool calls through — `createToolRunner`'s. */
export type McpToolRunner = (
  tool: MountableTool,
  rawArgs: Record<string, unknown>,
  context?: Record<string, unknown>,
  options?: Pick<ToolExecutionOptions, 'finalizeOutput'>,
) => Promise<ToolResult>;

export interface McpToolRegistrationConfig {
  runTool: McpToolRunner;
  formatResult: (
    result: ToolResult,
    mode: PreparedMcpTool['outputMode'],
    toolName: string,
  ) => CallToolResult;
  catalog?: McpCatalogStamp;
  multiRoundRuntime?: McpRoundRuntime;
}

/**
 * Register one prepared tool on one MCP server — the only place a tool's
 * listing, `_meta`, catalog stamp, request context and elicitation rounds are
 * assembled. Contract endpoints and runtime tools differ in where their
 * description and hints come from and in whether a presenter shapes the answer;
 * they never differ in protocol. A failure thrown anywhere in the call answers
 * as an `isError` tool result: MCP reserves JSON-RPC errors for the protocol, and
 * a tool's own failure is a result the model can read.
 */
export function registerMcpTool(
  server: McpServer,
  presentation: McpToolPresentation,
  descriptor: PreparedMcpTool,
  config: McpToolRegistrationConfig,
): void {
  const { mountable } = descriptor;
  const toolConfig: {
    description: string;
    inputSchema: z.ZodType;
    outputSchema?: z.ZodType;
    annotations?: EndpointToolAnnotations;
    _meta?: Record<string, unknown>;
  } = {
    description: presentation.description,
    inputSchema: z.looseObject({}).meta(presentationMetadata(descriptor.inputSchema)),
  };
  if (descriptor.outputSchema) toolConfig.outputSchema = descriptor.outputSchema;
  // MCP `ToolAnnotations` — behavioural hints a host reads to group tools
  // (read-only vs destructive), pick permission defaults and show a title.
  if (presentation.annotations) toolConfig.annotations = presentation.annotations;
  // MCP Apps (SEP-1865): carry `_meta.ui` so a host renders the named `ui://`
  // resource as an interactive widget for this tool's results. The legacy flat
  // `ui/resourceUri` key is set alongside — some hosts still read it (matches
  // the ext-apps `registerAppTool` normalization).
  if (presentation.ui) {
    toolConfig._meta = {
      ui: presentation.ui,
      'ui/resourceUri': presentation.ui.resourceUri,
    };
  }
  const { name } = presentation;
  const format = config.formatResult;

  server.registerTool(
    name,
    stampToolRegistration(toolConfig, config.catalog),
    async (rawArgs, mcpContext) =>
      stampToolResult(
        await runInMcpRequestContext(mcpContext, name, async () => {
          const args = isRecord(rawArgs) ? rawArgs : {};
          try {
            const round = await resolveMcpRound({
              tool: mountable,
              rawArgs: args,
              context: mcpContext,
              policy: mountable.method.mcp,
              runtime: config.multiRoundRuntime,
              runTool: config.runTool,
              formatFailure: (result) => format(result, 'none', name),
            });
            if (round.kind === 'response') return round.response;
            const { present } = presentation;
            if (!present) {
              const result = await config.runTool(mountable, args, round.context);
              return format(result, descriptor.outputMode, name);
            }
            const result = await config.runTool(mountable, args, round.context, {
              finalizeOutput: async (data) => {
                const presented = await present(data);
                if (!isRecord(presented)) {
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
                const structured = format(
                  { ok: true, data },
                  descriptor.outputMode,
                  name,
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
            });
            if (!result.ok) return format(result, 'none', name);
            if (!isCallToolResult(result.data)) {
              throw new Error('[stitchkit] Runtime MCP presenter invariant failed');
            }
            return result.data;
          } catch (err) {
            return format(toolResultFromError(err), 'none', name);
          }
        }),
        config.catalog,
      ),
  );
}
