import type { CallToolResult } from '@modelcontextprotocol/server';
import type { z } from 'zod';
import { redact } from '../observability/sanitize';
import type { ServiceDef, StitchLogger } from '../server/types';
import type { ErrorHintFn, ToolResult } from './execute';
import type { ToolPresentationSchema } from './flatten';
import { type JsonSchemaIo, toJsonSchema } from './json-schema';
import { validateMcpRoundPolicy } from './mcp-round';
import { collectTools, formatToolError, type MountableTool, type ToolExtend } from './mount';
import { assertUniqueToolName } from './names';
import { findNonPortableFormats } from './portable-formats';
import { buildToolPresentationSchema, isObjectPresentationSchema } from './presentation';
import type { RuntimeToolDefinition } from './runtime-tool';
import { collectToolSurface, type ToolSurfaceDefinition } from './surface';
import { findUntypedProperties } from './untyped-properties';

/**
 * What to do when a tool's schema cannot be advertised on the MCP surface — a
 * union / discriminated-union input (MCP needs an object), or a construct
 * JSON Schema cannot represent (`z.date()`, `z.map()`, …):
 * - `throw` (default) — fail the build loudly, listing every bad tool. Better
 *   a failed deploy than a tool that silently vanishes from the MCP surface.
 * - `warn` — log and drop the tool.
 * - `skip` — drop the tool silently.
 */
export type IncompatibleSchemaPolicy = 'throw' | 'skip' | 'warn';

/** One schema policy shared by validation, mounting and every MCP transport. */
export interface McpSchemaValidationConfig {
  /** What to do when a tool schema fails the profile. Default `'throw'`. */
  policy?: IncompatibleSchemaPolicy;
  /** Require every advertised input property to carry usable type information. */
  requireTypedProperties?: boolean;
  /** Dotted `tool.property` paths deliberately left unconstrained. */
  allowUntyped?: readonly string[];
  /** Reject formats outside the portable JSON Schema/AJV baseline. */
  requirePortableFormats?: boolean;
  /** Custom formats known to every client used by this server. */
  allowFormats?: readonly string[];
}

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

/** Probe a schema through the canonical converter — `null` if ok, else the error message. */
function probeSchema(schema: z.ZodType, io: JsonSchemaIo): string | null {
  try {
    toJsonSchema(schema, io);
    return null;
  } catch (err) {
    return err instanceof Error ? err.message : String(err);
  }
}

/**
 * Resolve a method's `output` to the exact schema MCP advertises. Modern MCP
 * accepts every JSON root type; the official SDK adapts older wire eras.
 */
function resolveOutputSchema(
  outputSchema: z.ZodType | undefined,
): { schema: z.ZodType; mode: Exclude<StructuredMode, 'none'> } | null {
  if (!outputSchema) return null;
  return { schema: outputSchema, mode: 'direct' };
}

/** Apply the incompatible-schema policy to one failure. */
function reportIncompatible(
  message: string,
  policy: IncompatibleSchemaPolicy,
  logger: StitchLogger | undefined,
  failures: string[],
): void {
  if (policy === 'throw') {
    failures.push(message);
  } else if (policy === 'warn') {
    if (logger) logger.warn(`[stitchkit] ${message}`);
    else console.warn(`[stitchkit] ${message}`);
  }
  // 'skip' — drop the tool silently.
}

/** Throw the one aggregated build error if any tool was incompatible. */
function throwIfFailures(failures: string[]): void {
  if (failures.length > 0) {
    throw new Error(
      `[stitchkit] ${failures.length} problem(s) with MCP tool schemas:\n - ${failures.join('\n - ')}`,
    );
  }
}

/** One immutable descriptor cleared to register on any fresh MCP server. */
export interface PreparedMcpTool {
  mountable: MountableTool;
  inputSchema: ToolPresentationSchema;
  outputSchema?: z.ZodType;
  outputMode: StructuredMode;
}

export type PreparedMcpSurface = readonly PreparedMcpTool[];

export interface McpSurfacePreparationConfig {
  extend?: ToolExtend;
  flattenUnionInput?: boolean;
  schemaValidation?: McpSchemaValidationConfig;
  logger?: StitchLogger;
  /** Multi-round capability available to this prepared surface. */
  multiRound?: { stateConfigured: boolean; maxRounds: number };
}

/**
 * Vet one tool for the MCP surface — cross-service name collision, an
 * object-shaped input, and JSON Schema-compatible input / output. Records any
 * problem through the policy and returns `null` when the tool must be dropped.
 * The shared front half of `mountMcp` and `validateMcpSchemas`, so the two
 * cannot drift.
 */
function prepareMcpTool(
  mountable: MountableTool,
  config: McpSurfacePreparationConfig,
  validation: McpSchemaValidationConfig,
  logger: StitchLogger | undefined,
  failures: string[],
  seen: Set<string>,
): PreparedMcpTool | null {
  const policy = validation.policy ?? 'throw';
  assertUniqueToolName(mountable.name, seen.has(mountable.name), 'MCP tool name');
  seen.add(mountable.name);

  if (mountable.method.mcp) {
    validateMcpRoundPolicy(mountable, mountable.method.mcp, config.multiRound);
  }

  let inputJsonSchema: ToolPresentationSchema;
  try {
    inputJsonSchema = buildToolPresentationSchema({
      paramsSchema: mountable.method.paramsSchema,
      inputSchema: mountable.method.inputSchema,
      extendSchema: mountable.shouldExtend && config.extend ? config.extend.schema : undefined,
      flattenUnionInput: config.flattenUnionInput,
      unrepresentable: 'throw',
    });
  } catch (err) {
    reportIncompatible(
      `MCP tool "${mountable.name}" — input schema is not JSON Schema-compatible: ${err instanceof Error ? err.message : String(err)}`,
      policy,
      logger,
      failures,
    );
    return null;
  }

  if (!isObjectPresentationSchema(inputJsonSchema)) {
    reportIncompatible(
      `MCP tool "${mountable.name}" — input must be an object schema; a union, discriminated union or scalar cannot be an MCP tool input (flatten it in the contract, or drop MCP from \`expose\`)`,
      policy,
      logger,
      failures,
    );
    return null;
  }

  if (validation.requireTypedProperties) {
    const allowed = new Set(validation.allowUntyped ?? []);
    for (const untyped of findUntypedProperties(inputJsonSchema)) {
      const path = `${mountable.name}.${untyped.path}`;
      if (allowed.has(path)) continue;
      const clue = untyped.description
        ? ` (only a description: "${untyped.description}")`
        : '';
      reportIncompatible(
        `MCP tool "${mountable.name}" — input property "${untyped.path}" carries no type, enum or $ref${clue}. ` +
          'A model is given no way to know what to send. Widen the contract, or list it in `allowUntyped` if it is deliberately free-form.',
        policy === 'skip' ? 'warn' : policy,
        logger,
        failures,
      );
    }
  }
  if (validation.requirePortableFormats) {
    for (const finding of findNonPortableFormats(inputJsonSchema, validation.allowFormats)) {
      reportIncompatible(
        `MCP tool "${mountable.name}" — input property "${finding.path}" uses non-portable JSON Schema format "${finding.format}". ` +
          'Use a portable pattern/schema, or list the format in `allowFormats` only when every MCP client supports it.',
        policy === 'skip' ? 'warn' : policy,
        logger,
        failures,
      );
    }
  }

  // Every JSON `output` becomes the tool's `outputSchema` directly. An
  // incompatible output is reported but the tool still registers, text-only.
  const resolved = resolveOutputSchema(mountable.method.outputSchema);
  if (!resolved) return { mountable, inputSchema: inputJsonSchema, outputMode: 'none' };

  const outputError = probeSchema(resolved.schema, 'output');
  if (outputError) {
    reportIncompatible(
      `MCP tool "${mountable.name}" — output schema is not JSON Schema-compatible: ${outputError}`,
      policy,
      logger,
      failures,
    );
    return { mountable, inputSchema: inputJsonSchema, outputMode: 'none' };
  }
  if (validation.requirePortableFormats) {
    for (const finding of findNonPortableFormats(
      toJsonSchema(resolved.schema, 'output'),
      validation.allowFormats,
    )) {
      reportIncompatible(
        `MCP tool "${mountable.name}" — output property "${finding.path}" uses non-portable JSON Schema format "${finding.format}". ` +
          'Use a portable pattern/schema, or list the format in `allowFormats` only when every MCP client supports it.',
        policy === 'skip' ? 'warn' : policy,
        logger,
        failures,
      );
    }
  }
  return {
    mountable,
    inputSchema: inputJsonSchema,
    outputSchema: resolved.schema,
    outputMode: resolved.mode,
  };
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
export function prepareMcpTools(
  tools: readonly MountableTool[],
  config: McpSurfacePreparationConfig = {},
): PreparedMcpSurface {
  const seen = new Set<string>();
  const failures: string[] = [];
  const prepared: PreparedMcpTool[] = [];

  for (const mountable of tools) {
    const tool = prepareMcpTool(
      mountable,
      config,
      config.schemaValidation ?? {},
      config.logger,
      failures,
      seen,
    );
    if (tool) {
      Object.freeze(tool.mountable);
      prepared.push(Object.freeze(tool));
    }
  }

  throwIfFailures(failures);
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
