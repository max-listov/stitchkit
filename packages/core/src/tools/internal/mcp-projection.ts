import type { ZodType } from 'zod';
import type { EndpointMcpPolicy } from '../../contract/tool-options';
import { toJsonSchema } from '../../json-schema/json-schema';
import type { StitchLogger } from '../../server/types';
import { validateMcpRoundPolicy } from '../mcp/round-policy';
import { assertUniqueToolName } from '../names';
import type { ToolPresentationSchema } from '../schema/flatten';
import { findNonPortableFormats } from '../schema/portable-formats';
import {
  buildToolPresentationSchema,
  isObjectPresentationSchema,
} from '../schema/presentation';
import { findUntypedProperties } from '../schema/untyped-properties';
import type {
  ProjectedTool,
  SurfaceRuntimeToolDefinition,
  ToolPresentationProjectionConfig,
} from './surface-projector';
import { toolSurfaceOutputSchema } from './tool-view';

/**
 * The MCP half of a projected surface: each candidate's advertised input document, checked against
 * the surface's schema-validation rules before anything is registered.
 */
/**
 * What to do with a tool whose schema fails MCP validation: `throw` stops the build, `skip`
 * leaves the tool out with a warning, `warn` keeps it and warns.
 */
export type IncompatibleSchemaPolicy = 'throw' | 'skip' | 'warn';

/**
 * Rules applied to every advertised MCP schema: the incompatibility `policy` plus optional
 * strict checks on untyped properties and non-portable string formats.
 */
export interface McpSchemaValidationConfig {
  policy?: IncompatibleSchemaPolicy;
  requireTypedProperties?: boolean;
  allowUntyped?: readonly string[];
  requirePortableFormats?: boolean;
  allowFormats?: readonly string[];
}

export interface McpProjectionPreparationConfig extends ToolPresentationProjectionConfig {
  schemaValidation?: McpSchemaValidationConfig;
  logger?: StitchLogger;
  multiRound?: { stateConfigured: boolean; maxRounds: number };
}

export interface McpProjectionCandidate<TTool> {
  tool: TTool;
  name: string;
  paramsSchema?: ZodType;
  inputSchema?: ZodType;
  /** A tool view's input defaults, stated in the advertised input schema. */
  inputDefaults?: Readonly<Record<string, unknown>>;
  /** The tool's own `tool.inputRecursionDepth`, over the surface's. */
  inputRecursionDepth?: number;
  /** The most levels the provider accepts in one input document; deeper nodes open. Absent: no limit. */
  inputNestingDepth?: number;
  /** The tool-surface answer's schema — a tool view's, when one is declared. */
  outputSchema?: ZodType;
  shouldExtend: boolean;
  mcp?: EndpointMcpPolicy;
}

export interface PreparedProjectedMcpTool<TTool> {
  tool: TTool;
  inputSchema: ToolPresentationSchema;
  outputSchema?: ZodType;
}

export function mcpProjectionCandidate<TRuntime extends SurfaceRuntimeToolDefinition>(
  tool: ProjectedTool<TRuntime>,
): McpProjectionCandidate<ProjectedTool<TRuntime>> {
  if (tool.kind === 'contract') {
    return {
      tool,
      name: tool.name,
      ...(tool.source.paramsSchema !== undefined && {
        paramsSchema: tool.source.paramsSchema,
      }),
      ...(tool.source.inputSchema !== undefined && {
        inputSchema: tool.source.inputSchema,
      }),
      ...(tool.source.toolView?.defaults !== undefined && {
        inputDefaults: tool.source.toolView.defaults,
      }),
      ...(tool.source.inputRecursionDepth !== undefined && {
        inputRecursionDepth: tool.source.inputRecursionDepth,
      }),
      ...(tool.source.inputNestingDepth !== undefined && {
        inputNestingDepth: tool.source.inputNestingDepth,
      }),
      ...(toolSurfaceOutputSchema(tool.source) !== undefined && {
        outputSchema: toolSurfaceOutputSchema(tool.source),
      }),
      shouldExtend: tool.shouldExtend,
      ...(tool.mcp !== undefined && { mcp: tool.mcp }),
    };
  }
  return {
    tool,
    name: tool.name,
    inputSchema: tool.source.input,
    ...(tool.source.output !== undefined && { outputSchema: tool.source.output }),
    shouldExtend: false,
    ...(tool.mcp !== undefined && { mcp: tool.mcp }),
  };
}

function reportIncompatible(
  message: string,
  policy: IncompatibleSchemaPolicy,
  logger: StitchLogger | undefined,
  failures: string[],
): void {
  if (policy === 'throw') failures.push(message);
  else if (policy === 'warn') {
    if (logger) logger.warn(`[stitchkit] ${message}`);
    else console.warn(`[stitchkit] ${message}`);
  }
}

/** Apply the exact MCP preparation profile to already projected tools. */
export function prepareProjectedMcpTools<TTool>(
  tools: readonly McpProjectionCandidate<TTool>[],
  config: McpProjectionPreparationConfig = {},
): PreparedProjectedMcpTool<TTool>[] {
  const policy = config.schemaValidation?.policy ?? 'throw';
  const failures: string[] = [];
  const prepared: PreparedProjectedMcpTool<TTool>[] = [];
  const names = new Set<string>();

  for (const tool of tools) {
    assertUniqueToolName(tool.name, names.has(tool.name), 'MCP tool name');
    names.add(tool.name);
    if (tool.mcp) validateMcpRoundPolicy(tool, tool.mcp, config.multiRound);
    let inputSchema: ToolPresentationSchema;
    // Paths the nesting limit opened accept any value on purpose; the typed check passes them.
    const openedByNestingLimit = new Set<string>();
    try {
      inputSchema = buildToolPresentationSchema({
        onInputNestingOpened: (path) => openedByNestingLimit.add(path),
        paramsSchema: tool.paramsSchema,
        inputSchema: tool.inputSchema,
        extendSchema: tool.shouldExtend && config.extend ? config.extend.schema : undefined,
        flattenUnionInput: config.flattenUnionInput,
        inputRecursionDepth: tool.inputRecursionDepth ?? config.inputRecursionDepth,
        inputNestingDepth: tool.inputNestingDepth ?? config.inputNestingDepth,
        unrepresentable: 'throw',
        defaults: tool.inputDefaults,
      });
    } catch (error) {
      reportIncompatible(
        `MCP tool "${tool.name}" — input schema is not JSON Schema-compatible: ${error instanceof Error ? error.message : String(error)}`,
        policy,
        config.logger,
        failures,
      );
      continue;
    }
    if (!isObjectPresentationSchema(inputSchema)) {
      reportIncompatible(
        `MCP tool "${tool.name}" — input must be an object schema; a union, discriminated union or scalar cannot be an MCP tool input (flatten it in the contract, or drop MCP from \`expose\`)`,
        policy,
        config.logger,
        failures,
      );
      continue;
    }

    if (config.schemaValidation?.requireTypedProperties) {
      const allowed = new Set(config.schemaValidation.allowUntyped ?? []);
      for (const untyped of findUntypedProperties(inputSchema)) {
        const path = `${tool.name}.${untyped.path}`;
        if (allowed.has(path) || openedByNestingLimit.has(untyped.path)) continue;
        const clue = untyped.description
          ? ` (only a description: "${untyped.description}")`
          : '';
        reportIncompatible(
          `MCP tool "${tool.name}" — input property "${untyped.path}" carries no type, enum or $ref${clue}. A model is given no way to know what to send. Use \`z.json()\` for an arbitrary JSON value — its schema refers to itself, so where the model provider refuses recursive schemas also set \`inputRecursionDepth\`; use \`allowUntyped\` only when the presentation value is genuinely not representable as JSON Schema.`,
          policy === 'skip' ? 'warn' : policy,
          config.logger,
          failures,
        );
      }
    }
    if (config.schemaValidation?.requirePortableFormats) {
      for (const finding of findNonPortableFormats(
        inputSchema,
        config.schemaValidation.allowFormats,
      )) {
        reportIncompatible(
          `MCP tool "${tool.name}" — input property "${finding.path}" uses non-portable JSON Schema format "${finding.format}". Use a portable pattern/schema, or list the format in \`allowFormats\` only when every MCP client supports it.`,
          policy === 'skip' ? 'warn' : policy,
          config.logger,
          failures,
        );
      }
    }

    const outputSchema = tool.outputSchema;
    let compatibleOutput: ZodType | undefined;
    if (outputSchema) {
      try {
        const output = toJsonSchema(outputSchema, 'output');
        compatibleOutput = outputSchema;
        if (config.schemaValidation?.requirePortableFormats) {
          for (const finding of findNonPortableFormats(
            output,
            config.schemaValidation.allowFormats,
          )) {
            reportIncompatible(
              `MCP tool "${tool.name}" — output property "${finding.path}" uses non-portable JSON Schema format "${finding.format}". Use a portable pattern/schema, or list the format in \`allowFormats\` only when every MCP client supports it.`,
              policy === 'skip' ? 'warn' : policy,
              config.logger,
              failures,
            );
          }
        }
      } catch (error) {
        reportIncompatible(
          `MCP tool "${tool.name}" — output schema is not JSON Schema-compatible: ${error instanceof Error ? error.message : String(error)}`,
          policy,
          config.logger,
          failures,
        );
      }
    }
    prepared.push({
      tool: tool.tool,
      inputSchema,
      ...(compatibleOutput !== undefined && { outputSchema: compatibleOutput }),
    });
  }

  if (failures.length > 0) {
    throw new Error(
      `[stitchkit] ${failures.length} problem(s) with MCP tool schemas:\n - ${failures.join('\n - ')}`,
    );
  }
  return prepared;
}
