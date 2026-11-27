import type { CallToolResult } from '@modelcontextprotocol/server';
import type { z } from 'zod';
import type { ServiceDef, StitchLogger } from '../../server/types';
import type { ErrorHintFn } from '../execute-hooks';
import type { ToolResult } from '../execute-result';
import { projectJsonSafe } from '../internal/json-projection';
import {
  type McpProjectionPreparationConfig,
  type McpSchemaValidationConfig,
  prepareProjectedMcpTools,
} from '../internal/mcp-projection';
import type { ToolSurfaceProjection } from '../internal/surface-projector';
import { toolSurfaceOutputSchema } from '../internal/tool-view';
import { collectTools, formatToolError, type MountableTool, type ToolExtend } from '../mount';
import type { RuntimeToolDefinition } from '../runtime-tool-declaration';
import type { ToolPresentationSchema } from '../schema/flatten';
import { collectToolSurface } from '../surface';

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
} from '../internal/mcp-projection';

/** Standalone schema-validation input, including the exact surface-shaping options. */
export interface ValidateMcpSchemasConfig extends McpSchemaValidationConfig {
  services: ServiceDef[];
  logger?: StitchLogger;
  extend?: ToolExtend;
  flattenUnionInput?: boolean;
  /** Validate the reference-free documents the live mount advertises. */
  inputRecursionDepth?: number;
  /** The most levels the provider accepts in one input document; deeper nodes open. Absent: no limit. */
  inputNestingDepth?: number;
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
    const projected = projectJsonSafe(result.data, 2);
    return { content: textBlock(projected.text), structuredContent: projected.value };
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
    tools.map((mountable) => {
      const outputSchema = toolSurfaceOutputSchema(mountable.method);
      return {
        tool: mountable,
        name: mountable.name,
        ...(mountable.method.paramsSchema !== undefined && {
          paramsSchema: mountable.method.paramsSchema,
        }),
        ...(mountable.method.inputSchema !== undefined && {
          inputSchema: mountable.method.inputSchema,
        }),
        ...(mountable.method.toolView?.defaults !== undefined && {
          inputDefaults: mountable.method.toolView.defaults,
        }),
        ...(mountable.method.inputRecursionDepth !== undefined && {
          inputRecursionDepth: mountable.method.inputRecursionDepth,
        }),
        ...(mountable.method.inputNestingDepth !== undefined && {
          inputNestingDepth: mountable.method.inputNestingDepth,
        }),
        // The advertised answer is the one the call returns: the tool view's
        // when one is declared. → ADR 0196.
        ...(outputSchema !== undefined && { outputSchema }),
        shouldExtend: mountable.shouldExtend,
        ...(mountable.method.mcp !== undefined && { mcp: mountable.method.mcp }),
      };
    }),
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
export interface McpSurfaceDefinition extends ToolSurfaceProjection<RuntimeToolDefinition> {
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
    inputRecursionDepth: config.inputRecursionDepth,
    inputNestingDepth: config.inputNestingDepth,
  })) {
    if (entry.kind === 'contract') {
      contractMountables.push(entry.mountable);
    } else {
      definitions.push(entry.definition);
      runtimeMountables.push(entry.mountable);
    }
  }

  const contractTools = prepareMcpTools(contractMountables, config);

  // Runtime tools are shaped like contract tools; only `extend` stays contract-only.
  const runtimeDescriptors = prepareMcpTools(runtimeMountables, {
    flattenUnionInput: config.flattenUnionInput,
    inputRecursionDepth: config.inputRecursionDepth,
    inputNestingDepth: config.inputNestingDepth,
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
