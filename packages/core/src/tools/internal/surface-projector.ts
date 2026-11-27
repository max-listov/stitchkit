import { type ZodObject, type ZodType, z } from 'zod';
import type { HttpMethod, ToolTransport } from '../../contract/define';
import { isHttpOnlyEndpoint } from '../../contract/endpoint-capabilities';
import type {
  EndpointMcpPolicy,
  EndpointToolAnnotations,
  EndpointUiMeta,
} from '../../contract/tool-options';
import type { MethodDef, ServiceDef } from '../../server/types';
import { assertToolName, assertUniqueToolName, hasUsableChars, toToolName } from '../names';
import type { ToolPresentationSchema } from '../schema/flatten';
import { buildToolPresentationSchema } from '../schema/presentation';
import { mergeSchemas } from '../schema/schema';
import { assertNoLegacyTransports } from './expose';

/**
 * Non-executable runtime-tool shape needed to project names and advertised schemas.
 */
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
  expose?: readonly ToolTransport[];
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

/**
 * Shared surface container; each executable mount supplies its own typed definition.
 */
export interface ToolSurfaceProjection<TRuntime> {
  services?: readonly ServiceDef[];
  runtimeTools?: readonly TRuntime[];
}

/** How a surface shapes every input document it advertises, runtime tools included. */
export interface ToolInputProjection {
  flattenUnionInput?: boolean;
  /**
   * Write every `$ref` out and unroll recursion this many levels; a tool's own
   * `tool.inputRecursionDepth` wins over it. → ADR 0319.
   */
  inputRecursionDepth?: number;
  /** The most levels the provider accepts in one input document; deeper nodes open. Absent: no limit. */
  inputNestingDepth?: number;
}

export interface ToolPresentationProjectionConfig extends ToolInputProjection {
  extend?: SurfaceToolExtension;
  assertNames?: boolean;
  assertUniqueNames?: boolean;
}

/** One runtime-tool projection: the surface's input shaping plus whether to check the name. */
export interface RuntimeToolProjectionOptions extends ToolInputProjection {
  assertName?: boolean;
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

/**
 * Canonical runtime descriptor projection, independent of one transport's exposure filter.
 */
export function projectRuntimeTool<TRuntime extends SurfaceRuntimeToolDefinition>(
  definition: TRuntime,
  options: RuntimeToolProjectionOptions = {},
): ProjectedRuntimeTool<TRuntime> {
  if (options.assertName ?? true) {
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
      flattenUnionInput: options.flattenUnionInput,
      inputRecursionDepth: options.inputRecursionDepth,
      inputNestingDepth: options.inputNestingDepth,
      unrepresentable: 'any',
    }),
    shouldExtend: false,
    ...(definition.mcp !== undefined && { mcp: definition.mcp }),
  };
}

export function projectedRuntimeToolSupports(
  definition: SurfaceRuntimeToolDefinition,
  transport: ToolTransport,
): boolean {
  assertNoLegacyTransports(definition, `Runtime tool "${definition.name}"`);
  if (definition.expose?.length === 0) {
    throw new Error(`Runtime tool "${definition.name}" must expose at least one transport`);
  }
  return definition.expose ? definition.expose.includes(transport) : transport !== 'CLI';
}

function duplicateLabel(
  transport: ToolTransport,
): 'MCP tool name' | 'agent tool name' | 'CLI command' {
  if (transport === 'MCP') return 'MCP tool name';
  if (transport === 'AGENT') return 'agent tool name';
  return 'CLI command';
}

function assertProjectedName(
  name: string,
  serviceName: string,
  action: string,
  transport: ToolTransport,
  derived: boolean,
): void {
  if (transport === 'CLI') return;
  if (derived && !hasUsableChars(serviceName)) {
    throw new Error(
      `Service prefix "${serviceName}" (method "${action}") has no characters usable in a tool name — set an explicit \`tool.name\` or rename the prefix`,
    );
  }
  assertToolName(name, serviceName, action);
}

/** The exposed name can be inspected before building its argument or presentation schema. */
export function projectedContractToolName(
  serviceName: string,
  methodName: string,
  method: MethodDef,
  transport: ToolTransport,
): string | undefined {
  const exposed = method.expose?.includes(transport) ?? transport !== 'CLI';
  if (!exposed || isHttpOnlyEndpoint(method)) return undefined;
  return method.toolName ?? toToolName(serviceName, methodName);
}

/** Canonical name/exposure/presentation projection shared by mounts and manifests. */
export function projectToolSurface<TRuntime extends SurfaceRuntimeToolDefinition>(
  surface: ToolSurfaceProjection<TRuntime>,
  transport: ToolTransport,
  config: ToolPresentationProjectionConfig = {},
): ProjectedTool<TRuntime>[] {
  const projected: ProjectedTool<TRuntime>[] = [];
  const names = new Set<string>();
  const origins = new Map<string, string>();
  const append = (tool: ProjectedTool<TRuntime>): void => {
    if (config.assertUniqueNames ?? true) {
      if (names.has(tool.name)) {
        const previous = origins.get(tool.name) ?? 'unknown';
        const current = `${tool.serviceName}.${tool.action}`;
        throw new Error(
          `Duplicate ${duplicateLabel(transport)} "${tool.name}" across mounted operations: ${previous}, ${current}`,
        );
      }
      assertUniqueToolName(tool.name, false, duplicateLabel(transport));
    }
    names.add(tool.name);
    origins.set(tool.name, `${tool.serviceName}.${tool.action}`);
    projected.push(tool);
  };

  for (const service of surface.services ?? []) {
    for (const [methodName, method] of Object.entries(service.methods)) {
      const name = projectedContractToolName(service.name, methodName, method, transport);
      if (name === undefined) continue;
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
          defaults: method.toolView?.defaults,
          extendSchema: shouldExtend ? config.extend?.schema : undefined,
          flattenUnionInput: config.flattenUnionInput,
          inputRecursionDepth: method.inputRecursionDepth ?? config.inputRecursionDepth,
          inputNestingDepth: method.inputNestingDepth ?? config.inputNestingDepth,
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
    append(
      projectRuntimeTool(definition, {
        assertName: false,
        flattenUnionInput: config.flattenUnionInput,
        inputRecursionDepth: config.inputRecursionDepth,
        inputNestingDepth: config.inputNestingDepth,
      }),
    );
  }
  return projected;
}
