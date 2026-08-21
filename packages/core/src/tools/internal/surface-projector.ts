import { type ZodObject, type ZodType, z } from 'zod';
import type {
  EndpointMcpPolicy,
  EndpointToolAnnotations,
  EndpointUiMeta,
  HttpMethod,
} from '../../contract';
import type { MethodDef, ServiceDef, StitchLogger } from '../../server/types';
import type { ToolPresentationSchema } from '../flatten';
import { toJsonSchema } from '../json-schema';
import { validateMcpRoundPolicy } from '../mcp-round-policy';
import { assertToolName, assertUniqueToolName, hasUsableChars, toToolName } from '../names';
import { findNonPortableFormats } from '../portable-formats';
import { buildToolPresentationSchema, isObjectPresentationSchema } from '../presentation';
import { mergeSchemas } from '../schema';
import { findUntypedProperties } from '../untyped-properties';

export type ProjectedToolTransport = 'MCP' | 'AGENT' | 'CLI';

/** Non-executable runtime-tool shape needed to project names and advertised schemas. */
export interface SurfaceRuntimeToolDefinition {
  name: string;
  description: string;
  identity: {
    serviceName: string;
    action: string;
    method: HttpMethod;
    scope?: string;
    meta?: Record<string, unknown>;
  };
  input: ZodObject;
  output?: ZodType;
  transports?: readonly ProjectedToolTransport[];
  annotations?: EndpointToolAnnotations;
  ui?: EndpointUiMeta;
  mcp?: EndpointMcpPolicy;
}

/** One peer-free structural extension shared by executable mounts and projections. */
export interface SurfaceToolExtension<
  TContext extends Record<string, unknown> = Record<string, unknown>,
> {
  schema: Record<string, ZodType>;
  resolve: (args: Record<string, unknown>) => Partial<TContext> | Promise<Partial<TContext>>;
  filter?: (service: ServiceDef, method: MethodDef) => boolean;
}

export interface ToolSurfaceProjection<
  TRuntime extends SurfaceRuntimeToolDefinition = SurfaceRuntimeToolDefinition,
> {
  services?: readonly ServiceDef[];
  runtimeTools?: readonly TRuntime[];
}

export interface ToolPresentationProjectionConfig {
  extend?: SurfaceToolExtension;
  flattenUnionInput?: boolean;
  assertNames?: boolean;
  assertUniqueNames?: boolean;
}

/** Canonical collision guard shared by executable extensions and projections. */
export function assertToolExtensionCompatible(
  base: ZodType,
  extra: Record<string, ZodType>,
): void {
  if (!(base instanceof z.ZodObject)) return;
  const conflicts = Object.keys(extra).filter((key) => key in base.shape);
  if (conflicts.length > 0) {
    throw new Error(
      `Tool extend conflict: ${conflicts.join(', ')} already declared by the contract`,
    );
  }
}

export interface ProjectedContractTool {
  kind: 'contract';
  source: MethodDef;
  serviceName: string;
  action: string;
  name: string;
  presentationSchema: ToolPresentationSchema;
  shouldExtend: boolean;
  mcp?: EndpointMcpPolicy;
}

export interface ProjectedRuntimeTool<
  TRuntime extends SurfaceRuntimeToolDefinition = SurfaceRuntimeToolDefinition,
> {
  kind: 'runtime';
  source: TRuntime;
  serviceName: string;
  action: string;
  name: string;
  presentationSchema: ToolPresentationSchema;
  shouldExtend: false;
  mcp?: EndpointMcpPolicy;
}

export type ProjectedTool<
  TRuntime extends SurfaceRuntimeToolDefinition = SurfaceRuntimeToolDefinition,
> = ProjectedContractTool | ProjectedRuntimeTool<TRuntime>;

/** Canonical runtime descriptor projection, independent of one transport's exposure filter. */
export function projectRuntimeTool<TRuntime extends SurfaceRuntimeToolDefinition>(
  definition: TRuntime,
  assertName = true,
): ProjectedRuntimeTool<TRuntime> {
  if (assertName) {
    assertProjectedName(
      definition.name,
      definition.identity.serviceName,
      definition.identity.action,
      'MCP',
      false,
    );
  }
  return {
    kind: 'runtime',
    source: definition,
    serviceName: definition.identity.serviceName,
    action: definition.identity.action,
    name: definition.name,
    presentationSchema: buildToolPresentationSchema({
      inputSchema: definition.input,
      unrepresentable: 'any',
    }),
    shouldExtend: false,
    ...(definition.mcp !== undefined && { mcp: definition.mcp }),
  };
}

export function projectedRuntimeToolSupports(
  definition: SurfaceRuntimeToolDefinition,
  transport: ProjectedToolTransport,
): boolean {
  if (definition.transports?.length === 0) {
    throw new Error(`Runtime tool "${definition.name}" must expose at least one transport`);
  }
  return definition.transports
    ? definition.transports.includes(transport)
    : transport !== 'CLI';
}

function duplicateLabel(
  transport: ProjectedToolTransport,
): 'MCP tool name' | 'agent tool name' | 'CLI command' {
  if (transport === 'MCP') return 'MCP tool name';
  if (transport === 'AGENT') return 'agent tool name';
  return 'CLI command';
}

function assertProjectedName(
  name: string,
  serviceName: string,
  action: string,
  transport: ProjectedToolTransport,
  derived: boolean,
): void {
  if (transport === 'CLI') return;
  if (derived && !hasUsableChars(serviceName)) {
    throw new Error(
      `Service prefix "${serviceName}" (method "${action}") has no characters usable in a tool name — set an explicit \`toolName\` or rename the prefix`,
    );
  }
  assertToolName(name, serviceName, action);
}

/** Canonical name/exposure/presentation projection shared by mounts and manifests. */
export function projectToolSurface<TRuntime extends SurfaceRuntimeToolDefinition>(
  surface: ToolSurfaceProjection<TRuntime>,
  transport: ProjectedToolTransport,
  config: ToolPresentationProjectionConfig = {},
): ProjectedTool<TRuntime>[] {
  const projected: ProjectedTool<TRuntime>[] = [];
  const names = new Set<string>();
  const append = (tool: ProjectedTool<TRuntime>): void => {
    if (config.assertUniqueNames ?? true) {
      assertUniqueToolName(tool.name, names.has(tool.name), duplicateLabel(transport));
    }
    names.add(tool.name);
    projected.push(tool);
  };

  for (const service of surface.services ?? []) {
    for (const [methodName, method] of Object.entries(service.methods)) {
      if (transport === 'CLI') {
        if (!method.expose?.includes('CLI')) continue;
      } else if (method.expose && !method.expose.includes(transport)) {
        continue;
      }
      if (method.multipart || method.rawBody || method.responseMeta || method.rawResponse) {
        continue;
      }
      const name = method.toolName ?? toToolName(service.name, methodName);
      if (config.assertNames ?? true) {
        assertProjectedName(name, service.name, methodName, transport, !method.toolName);
      }
      const shouldExtend =
        transport !== 'CLI' &&
        config.extend !== undefined &&
        (!config.extend.filter || config.extend.filter(service, method));
      if (shouldExtend && config.extend) {
        assertToolExtensionCompatible(
          mergeSchemas(method.paramsSchema, method.inputSchema),
          config.extend.schema,
        );
      }
      append({
        kind: 'contract',
        source: method,
        serviceName: method.serviceName,
        action: method.key,
        name,
        presentationSchema: buildToolPresentationSchema({
          paramsSchema: method.paramsSchema,
          inputSchema: method.inputSchema,
          extendSchema: shouldExtend ? config.extend?.schema : undefined,
          flattenUnionInput: config.flattenUnionInput,
          unrepresentable: 'any',
        }),
        shouldExtend,
        ...(method.mcp !== undefined && { mcp: method.mcp }),
      });
    }
  }

  for (const definition of surface.runtimeTools ?? []) {
    if (!projectedRuntimeToolSupports(definition, transport)) continue;
    if (config.assertNames ?? true) {
      assertProjectedName(
        definition.name,
        definition.identity.serviceName,
        definition.identity.action,
        transport,
        false,
      );
    }
    append(projectRuntimeTool(definition, false));
  }
  return projected;
}

export type IncompatibleSchemaPolicy = 'throw' | 'skip' | 'warn';

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
      ...(tool.source.outputSchema !== undefined && {
        outputSchema: tool.source.outputSchema,
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
    try {
      inputSchema = buildToolPresentationSchema({
        paramsSchema: tool.paramsSchema,
        inputSchema: tool.inputSchema,
        extendSchema: tool.shouldExtend && config.extend ? config.extend.schema : undefined,
        flattenUnionInput: config.flattenUnionInput,
        unrepresentable: 'throw',
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
        if (allowed.has(path)) continue;
        const clue = untyped.description
          ? ` (only a description: "${untyped.description}")`
          : '';
        reportIncompatible(
          `MCP tool "${tool.name}" — input property "${untyped.path}" carries no type, enum or $ref${clue}. A model is given no way to know what to send. Use \`z.json()\` for an arbitrary JSON value; use \`allowUntyped\` only when the presentation value is genuinely not representable as JSON Schema.`,
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
