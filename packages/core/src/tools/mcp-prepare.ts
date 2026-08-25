import type { CallToolResult } from '@modelcontextprotocol/server';
import type { z } from 'zod';
import { redact } from '../observability/sanitize';
import type { ServiceDef, StitchLogger } from '../server/types';
import type { ErrorHintFn, ToolResult } from './execute';
import type { ToolPresentationSchema } from './flatten';
import {
  type McpProjectionPreparationConfig,
  type McpSchemaValidationConfig,
  prepareProjectedMcpTools,
} from './internal/surface-projector';
import { collectTools, formatToolError, type MountableTool, type ToolExtend } from './mount';
import type { RuntimeToolDefinition } from './runtime-tool';
import { collectToolSurface, type ToolSurfaceDefinition } from './surface';

/**
 * What to do when a tool's schema cannot be advertised on the MCP surface — a
 * union / discriminated-union input (MCP needs an object), or a construct
 * JSON Schema cannot represent (`z.date()`, `z.map()`, …):
 * - `throw` (default) — fail the build loudly, listing every bad tool. Better
 *   a failed deploy than a tool that silently vanishes from the MCP surface.
 * - `warn` — log and drop the tool.
 * - `skip` — drop the tool silently.
 */
/** One schema policy shared by validation, mounting and every MCP transport. */
export type {
  IncompatibleSchemaPolicy,
  McpSchemaValidationConfig,
} from './internal/surface-projector';

/** Standalone schema-validation input, including the exact surface-shaping options. */
export interface ValidateMcpSchemasConfig extends McpSchemaValidationConfig {
  services: ServiceDef[];
  logger?: StitchLogger;
  extend?: ToolExtend;
  flattenUnionInput?: boolean;
}

/** A single-element MCP text content block list. */
function textBlock(text: string): Array<{ type: 'text'; text: string }> {
  return [{ type: 'text', text }];
}

/** How a tool's result maps to MCP `structuredContent`. */
export type StructuredMode = 'none' | 'direct';

/**
 * Shape a `ToolResult` into an MCP tool response. Always emits a text `content`
 * block for declared output (the model reads it). Emits `structuredContent`
 * in the exact validated JSON shape whenever the tool declared an
 * `outputSchema`. The official SDK owns any protocol-era wire adaptation.
 */
export function formatMcpResult(
  result: ToolResult,
  mode: StructuredMode,
  toolName?: string,
  errorHint?: ErrorHintFn,
): CallToolResult {
  if (result.ok) {
    if (mode === 'none') return { content: [] };
    // A successful call must never be reported as `isError` because its data
    // cannot be serialised (a cycle, a bigint behind `z.unknown()`) — the
    // operation already ran and applied its side effects.
    let serialized: string | undefined;
    try {
      serialized = JSON.stringify(result.data, null, 2);
    } catch {
      serialized = undefined;
    }
    if (serialized === undefined) {
      // Project the value into a JSON-safe shape instead: cycles collapse to a
      // marker, bigints stringify. The never-matching pattern disables secret
      // masking — this is the tool's RESPONSE, not an audit row.
      const safe = redact(result.data, { sensitiveKeys: /(?!)/ });
      return { content: textBlock(JSON.stringify(safe, null, 2)), structuredContent: safe };
    }
    return { content: textBlock(serialized), structuredContent: result.data };
  }
  return {
    content: textBlock(JSON.stringify(formatToolError(result, toolName, errorHint), null, 2)),
    isError: true,
  };
}

/** One immutable descriptor cleared to register on any fresh MCP server. */
export interface PreparedMcpTool {
  mountable: MountableTool;
  inputSchema: ToolPresentationSchema;
  outputSchema?: z.ZodType;
  outputMode: StructuredMode;
}

export type PreparedMcpSurface = readonly PreparedMcpTool[];

export interface McpSurfacePreparationConfig extends McpProjectionPreparationConfig {
  extend?: ToolExtend;
  logger?: StitchLogger;
}

/**
 * Prepare the deterministic MCP surface once. No auth, context, hooks,
 * lifecycle closures, server or transport enters this value.
 */
export function prepareMcpSurface(
  services: ServiceDef | ServiceDef[],
  config: McpSurfacePreparationConfig = {},
): PreparedMcpSurface {
  const serviceList = Array.isArray(services) ? services : [services];
  const tools = serviceList.flatMap((service) => collectTools(service, 'MCP', config));
  return prepareMcpTools(tools, config);
}

/** Prepare already-resolved tool operations through the canonical MCP schema profile. */
function prepareMcpTools(
  tools: readonly MountableTool[],
  config: McpSurfacePreparationConfig = {},
): PreparedMcpSurface {
  const prepared = prepareProjectedMcpTools(
    tools.map((mountable) => ({
      tool: mountable,
      name: mountable.name,
      ...(mountable.method.paramsSchema !== undefined && {
        paramsSchema: mountable.method.paramsSchema,
      }),
      ...(mountable.method.inputSchema !== undefined && {
        inputSchema: mountable.method.inputSchema,
      }),
      ...(mountable.method.outputSchema !== undefined && {
        outputSchema: mountable.method.outputSchema,
      }),
      shouldExtend: mountable.shouldExtend,
      ...(mountable.method.mcp !== undefined && { mcp: mountable.method.mcp }),
    })),
    config,
  ).map((entry) => {
    Object.freeze(entry.tool);
    return Object.freeze({
      mountable: entry.tool,
      inputSchema: entry.inputSchema,
      ...(entry.outputSchema !== undefined && { outputSchema: entry.outputSchema }),
      outputMode: entry.outputSchema === undefined ? 'none' : 'direct',
    });
  });
  return Object.freeze(prepared);
}

/** One immutable, framework-managed MCP surface selected as a unit. */
export interface McpSurfaceDefinition extends ToolSurfaceDefinition {
  services: ServiceDef[];
}

/** A finite set of surfaces known when the server/handler is constructed. */
export type McpSurfaceRegistry = Record<string, McpSurfaceDefinition>;

/** A runtime definition paired with its already validated MCP descriptor. */
export interface PreparedRuntimeMcpTool {
  definition: RuntimeToolDefinition;
  descriptor: PreparedMcpTool;
}

/** Complete immutable tool descriptors for one fresh MCP server runtime. */
export interface PreparedMcpServerSurface {
  contractTools: PreparedMcpSurface;
  runtimeTools: readonly PreparedRuntimeMcpTool[];
}

/**
 * Prepare contracts and framework runtime tools as one collision-checked unit.
 * No auth, request context, lifecycle, hooks, SDK server or transport is stored.
 */
export function prepareMcpServerSurface(
  surface: McpSurfaceDefinition,
  config: McpSurfacePreparationConfig = {},
): PreparedMcpServerSurface {
  const contractMountables: MountableTool[] = [];
  const definitions: RuntimeToolDefinition[] = [];
  const runtimeMountables: MountableTool[] = [];

  for (const entry of collectToolSurface({
    surface,
    transport: 'MCP',
    extend: config.extend,
    flattenUnionInput: config.flattenUnionInput,
  })) {
    if (entry.kind === 'contract') {
      contractMountables.push(entry.mountable);
    } else {
      definitions.push(entry.definition);
      runtimeMountables.push(entry.mountable);
    }
  }

  const contractTools = prepareMcpTools(contractMountables, config);

  const runtimeDescriptors = prepareMcpTools(runtimeMountables, {
    schemaValidation: config.schemaValidation,
    logger: config.logger,
    multiRound: config.multiRound,
  });
  const descriptorsByName = new Map(
    runtimeDescriptors.map((descriptor) => [descriptor.mountable.name, descriptor]),
  );
  const runtimeTools: PreparedRuntimeMcpTool[] = [];
  for (const definition of definitions) {
    const descriptor = descriptorsByName.get(definition.name);
    if (descriptor) runtimeTools.push(Object.freeze({ definition, descriptor }));
  }

  return Object.freeze({ contractTools, runtimeTools: Object.freeze(runtimeTools) });
}
