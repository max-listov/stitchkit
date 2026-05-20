import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { normalizeError } from '../internal/errors';
import { isRecord } from '../internal/typed';
import type { ServiceDef } from '../server/types';
import type { ToolCallHooks, ToolResult } from './execute';
import { collectTools, createToolRunner, formatToolError, type ToolExtend } from './mount';

/** A single-element MCP text content block list. */
function textBlock(text: string): Array<{ type: 'text'; text: string }> {
  return [{ type: 'text', text }];
}

/**
 * Shape a `ToolResult` into an MCP tool response. Always emits a text `content`
 * block (the model reads it). Additionally emits `structuredContent` when the
 * tool declared an `outputSchema` — that is what an MCP App UI consumes.
 */
function formatMcpResult(result: ToolResult, hasOutputSchema: boolean) {
  if (result.ok) {
    const content = textBlock(JSON.stringify(result.data, null, 2));
    if (hasOutputSchema && isRecord(result.data)) {
      return { content, structuredContent: result.data };
    }
    return { content };
  }
  return {
    content: textBlock(JSON.stringify(formatToolError(result), null, 2)),
    isError: true,
  };
}

export interface McpMountConfig {
  context?: Record<string, unknown>;
  hooks?: ToolCallHooks;
  extend?: ToolExtend;
}

export function mountMcp(
  mcpServer: McpServer,
  services: ServiceDef | ServiceDef[],
  config: McpMountConfig = {},
): void {
  const serviceList = Array.isArray(services) ? services : [services];
  const runTool = createToolRunner({
    source: 'mcp',
    extend: config.extend,
    context: config.context,
    hooks: config.hooks,
  });

  for (const service of serviceList) {
    for (const mountable of collectTools(service, 'MCP', config.extend)) {
      try {
        z.toJSONSchema(mountable.schema);
      } catch (err) {
        console.error(
          `[stitchkit] SKIPPING MCP tool "${mountable.name}" — schema not JSON Schema-compatible: ${err instanceof Error ? err.message : err}`,
        );
        continue;
      }

      // An object `output` becomes the tool's `outputSchema` → results carry
      // `structuredContent` (consumed by MCP App UIs). Skipped if the schema is
      // not JSON Schema-compatible — the tool then stays text-only.
      let outputSchema: z.ZodObject<z.ZodRawShape> | undefined;
      if (mountable.method.outputSchema instanceof z.ZodObject) {
        try {
          z.toJSONSchema(mountable.method.outputSchema);
          outputSchema = mountable.method.outputSchema;
        } catch {
          outputSchema = undefined;
        }
      }

      const toolConfig: {
        description: string;
        inputSchema: z.ZodRawShape;
        outputSchema?: z.ZodRawShape;
      } = { description: mountable.method.desc, inputSchema: mountable.schema.shape };
      if (outputSchema) toolConfig.outputSchema = outputSchema.shape;

      mcpServer.registerTool(
        mountable.name,
        toolConfig,
        async (rawArgs: Record<string, unknown>) => {
          try {
            const result = await runTool(mountable, rawArgs);
            return formatMcpResult(result, outputSchema !== undefined);
          } catch (err) {
            const appErr = normalizeError(err);
            return formatMcpResult(
              { ok: false, code: appErr.code, details: appErr.details },
              false,
            );
          }
        },
      );
    }
  }
}

/**
 * Transport-neutral build config for an MCP server — everything needed to turn
 * contract services into a live `McpServer`, minus how the identity is
 * resolved. `createMcpHandler` (HTTP) and `createStdioMcpServer` (stdio) each
 * add their own `auth` on top.
 */
export interface McpServerBuildConfig<TAuth> {
  /** MCP server identity (name + version). */
  serverInfo: { name: string; version: string };
  /** Contract services exposed as MCP tools — may depend on the identity. */
  services: ServiceDef[] | ((auth: TAuth) => ServiceDef[]);
  /** Context merged into every contract handler (`mountMcp` context). */
  context?: (auth: TAuth) => Record<string, unknown>;
  /** Tool-call lifecycle hooks — `afterToolCall` fires for every result
   *  (success and error), so the consuming app can log MCP tool outcomes. */
  hooks?: ToolCallHooks;
  /** Register native (non-contract) MCP tools — receives the `McpServer`
   *  directly. For tools returning multimodal content, e.g. `mountViewFile`. */
  nativeTools?: (server: McpServer) => void;
  /** Server instructions — a short (≤2KB) hint to the host on when and how to
   *  use these tools. Surfaced to MCP tool-search. */
  instructions?: string;
}

/**
 * Build an `McpServer` from contract services for a resolved identity.
 * Transport-agnostic — the shared core behind every MCP transport.
 */
export function buildMcpServer<TAuth>(
  config: McpServerBuildConfig<TAuth>,
  auth: TAuth,
): McpServer {
  const server = new McpServer(
    config.serverInfo,
    config.instructions ? { instructions: config.instructions } : undefined,
  );
  const services =
    typeof config.services === 'function' ? config.services(auth) : config.services;
  const context = config.context?.(auth);
  mountMcp(server, services, { context, hooks: config.hooks });
  config.nativeTools?.(server);
  return server;
}
