import {
  type CallToolResult,
  createRequestStateCodec,
  McpServer,
  type RequestStateCodec,
  type ServerOptions,
} from '@modelcontextprotocol/server';
import { z } from 'zod';
import type { EndpointToolAnnotations } from '../contract';
import { isRecord } from '../internal/typed';
import type { ServiceDef, StitchLogger } from '../server/types';
import {
  type ErrorHintFn,
  type ToolCallHooks,
  type ToolLifecycle,
  type ToolResult,
  toolResultFromError,
} from './execute';
import type { ToolPresentationSchema } from './flatten';
import { type JsonSchemaIo, toJsonSchema } from './json-schema';
import { type McpResourceDef, RESOURCE_MIME_TYPE } from './mcp-app';
import { type McpRoundRuntime, type McpRoundState, resolveMcpRound } from './mcp-round';
import { runInMcpRequestContext } from './mcp-trace';
import {
  collectTools,
  createToolRunner,
  formatToolError,
  type MountableTool,
  type ToolExtend,
} from './mount';
import { assertUniqueToolName } from './names';
import { mountPreparedRuntimeMcp } from './native-mcp';
import { findNonPortableFormats } from './portable-formats';
import {
  buildToolPresentationSchema,
  isObjectPresentationSchema,
  presentationMetadata,
} from './presentation';
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
type StructuredMode = 'none' | 'direct';

/**
 * Shape a `ToolResult` into an MCP tool response. Always emits a text `content`
 * block for declared output (the model reads it). Emits `structuredContent`
 * in the exact validated JSON shape whenever the tool declared an
 * `outputSchema`. The official SDK owns any protocol-era wire adaptation.
 */
function formatMcpResult(
  result: ToolResult,
  mode: StructuredMode,
  toolName?: string,
  errorHint?: ErrorHintFn,
): CallToolResult {
  if (result.ok) {
    if (mode === 'none') return { content: [] };
    const serialized = JSON.stringify(result.data, null, 2);
    if (serialized === undefined) {
      throw new Error(
        `[stitchkit] MCP tool "${toolName ?? 'unknown'}" produced a non-JSON output`,
      );
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

export interface McpMountConfig {
  context?: Record<string, unknown>;
  /** Tool-call observability hooks. */
  hooks?: ToolCallHooks;
  /**
   * Auth / scope gate and result transform for every tool call — the tool-side
   * twin of `createServer`'s `beforeHandle` / `afterHandle`. Pass the same
   * `createAuthHook` result here as on the HTTP server to guard tools too;
   * without it a tool call bypasses the HTTP `beforeHandle` auth gate.
   */
  lifecycle?: ToolLifecycle;
  extend?: ToolExtend;
  /** Validation policy applied to the exact advertised MCP schemas. */
  schemaValidation?: McpSchemaValidationConfig;
  /** Logger for the `'warn'` policy — defaults to `console`. */
  logger?: StitchLogger;
  /** Coerce JSON-stringified arrays/objects in tool arguments. Default: true. */
  coerceJsonArgs?: boolean;
  /** Flatten discriminated union inputs into a single object. Default: false. */
  flattenUnionInput?: boolean;
  /** Global error hint injected into every failed tool result. */
  errorHint?: ErrorHintFn;
  /** Report output keys the contract schema removed — → ADR 0037. */
  onOutputStrip?: (toolName: string, paths: string[]) => void;
}

interface PreparedMcpMountConfig extends McpMountConfig {
  multiRoundRuntime?: McpRoundRuntime;
}

/**
 * Validate that every contract tool in `services` can be advertised on the MCP
 * surface — object-shaped, JSON Schema-compatible input / output, no tool-name
 * collision across services. The build-time check behind `mountMcp` — also
 * callable on its own (a startup assertion, a test) to fail a deploy before
 * the first request.
 */
export function validateMcpSchemas(config: ValidateMcpSchemasConfig): void {
  prepareMcpSurface(config.services, {
    extend: config.extend,
    flattenUnionInput: config.flattenUnionInput,
    schemaValidation: config,
    logger: config.logger,
  });
}

export function mountMcp(
  mcpServer: McpServer,
  services: ServiceDef | ServiceDef[],
  config: McpMountConfig = {},
): void {
  const prepared = prepareMcpSurface(services, {
    extend: config.extend,
    flattenUnionInput: config.flattenUnionInput,
    schemaValidation: config.schemaValidation,
    logger: config.logger,
  });
  mountPreparedMcp(mcpServer, prepared, config);
}

/** Register a prepared immutable surface onto one fresh server/runtime. */
export function mountPreparedMcp(
  mcpServer: McpServer,
  prepared: PreparedMcpSurface,
  config: PreparedMcpMountConfig = {},
): void {
  const runTool = createToolRunner({
    source: 'mcp',
    extend: config.extend,
    context: config.context,
    hooks: config.hooks,
    lifecycle: config.lifecycle,
    errorHint: config.errorHint,
    coerceJsonArgs: config.coerceJsonArgs,
    onOutputStrip: config.onOutputStrip,
  });

  for (const descriptor of prepared) {
    const { mountable } = descriptor;

    const toolConfig: {
      description: string;
      inputSchema: z.ZodType;
      outputSchema?: z.ZodType;
      annotations?: EndpointToolAnnotations;
      _meta?: Record<string, unknown>;
    } = {
      description: mountable.method.desc,
      inputSchema: z.looseObject({}).meta(presentationMetadata(descriptor.inputSchema)),
    };
    if (descriptor.outputSchema) toolConfig.outputSchema = descriptor.outputSchema;
    // MCP `ToolAnnotations` — behavioural hints a host reads to group tools
    // (read-only vs destructive), pick permission defaults and show a title.
    if (mountable.method.annotations) {
      toolConfig.annotations = mountable.method.annotations;
    }
    // MCP Apps (SEP-1865): carry `_meta.ui` so a host renders the named
    // `ui://` resource as an interactive widget for this tool's results. The
    // legacy flat `ui/resourceUri` key is set alongside — some hosts still
    // read it (matches the ext-apps `registerAppTool` normalization).
    if (mountable.method.ui) {
      toolConfig._meta = {
        ui: mountable.method.ui,
        'ui/resourceUri': mountable.method.ui.resourceUri,
      };
    }

    mcpServer.registerTool(mountable.name, toolConfig, async (rawArgs, mcpContext) =>
      runInMcpRequestContext(mcpContext, mountable.name, async () => {
        const args = isRecord(rawArgs) ? rawArgs : {};
        try {
          const round = await resolveMcpRound({
            tool: mountable,
            rawArgs: args,
            context: mcpContext,
            policy: mountable.method.mcp,
            runtime: config.multiRoundRuntime,
            runTool,
            formatFailure: (result) =>
              formatMcpResult(result, 'none', mountable.name, config.errorHint),
          });
          if (round.kind === 'response') return round.response;
          const result = await runTool(mountable, args, round.context);
          return formatMcpResult(
            result,
            descriptor.outputMode,
            mountable.name,
            config.errorHint,
          );
        } catch (err) {
          return formatMcpResult(
            toolResultFromError(err),
            'none',
            mountable.name,
            config.errorHint,
          );
        }
      }),
    );
  }
}

/**
 * Transport-neutral build config for an MCP server — everything needed to turn
 * contract services into a live `McpServer`, minus how the identity is
 * resolved. `createMcpHandler` (HTTP) and `createStdioMcpServer` (stdio) each
 * add their own `auth` on top.
 */
export interface McpServerSharedConfig<TAuth> {
  /** MCP server identity (name + version). */
  serverInfo: { name: string; version: string };
  /** Context merged into every contract handler (`mountMcp` context). */
  context?: (auth: TAuth) => Record<string, unknown>;
  /** Tool-call observability hooks — `afterToolCall` fires for every result
   *  (success and error), so the consuming app can log MCP tool outcomes;
   *  `onToolError` adds the raw thrown value behind a failed one. */
  hooks?: ToolCallHooks;
  /** Auth / scope gate and result transform for every tool call — pass the
   *  same `createAuthHook` result used for the HTTP `beforeHandle` to guard
   *  tools with the identical rules. */
  lifecycle?: ToolLifecycle;
  /** Add extra tool arguments resolved into handler context (e.g. a `tenantId`
   *  for one API key serving many tenants). Same `ToolExtend` accepted by
   *  `mountMcp` — without this, the batteries-path (`createMcpHandler`) could not
   *  reach it and a consumer had to hand-wrap every service. */
  extend?: ToolExtend;
  /** Validation policy applied to the exact advertised MCP schemas. */
  schemaValidation?: McpSchemaValidationConfig;
  /** Logger for schema-incompatibility warnings — defaults to `console`. */
  logger?: StitchLogger;
  /** Explicit unprotected SDK escape hatch. Prefer `runtimeTools`; registrations
   *  here do not receive stitchkit validation, lifecycle, context or hooks. */
  rawTools?: (server: McpServer, auth: TAuth) => void;
  /** MCP Apps UI resources (`ui://…`) served for tools that declare `ui`. */
  resources?: McpResourceDef[];
  /** Server instructions — a short (≤2KB) hint to the host on when and how to
   *  use these tools. Surfaced to MCP tool-search. */
  instructions?: string;
  /** Explicit modern MCP cache policy. Omitted operations stay zero/private. */
  cache?: {
    operations?: NonNullable<ServerOptions['cacheHints']>;
  };
  /** Signed multi-round continuation policy for tools declaring `mcp.inputRequired`. */
  multiRound?: {
    state: {
      /** Shared HMAC key, at least 32 bytes. */
      key: Uint8Array | string;
      /** Continuation lifetime. Default 10 minutes. */
      ttlSeconds?: number;
      /** Stable authenticated principal bound into every continuation. */
      principal: (auth: TAuth) => string;
    };
    /** Legacy stdio shim and round limits owned by the official SDK. */
    serving?: NonNullable<ServerOptions['inputRequired']>;
  };
  /** Coerce JSON-stringified arrays/objects in tool arguments. Default: true. */
  coerceJsonArgs?: boolean;
  /** Flatten discriminated union inputs into a single object. Default: false. */
  flattenUnionInput?: boolean;
  /** Global error hint injected into every failed tool result. */
  errorHint?: ErrorHintFn;
  /** Report output keys the contract schema removed — → ADR 0037. */
  onOutputStrip?: (toolName: string, paths: string[]) => void;
}

export interface DirectMcpSurfaceConfig<TAuth> {
  /** Contract services exposed as MCP tools — may depend on the identity. */
  services: ServiceDef[] | ((auth: TAuth) => ServiceDef[]);
  /** Framework-managed runtime tools — may depend on the identity. */
  runtimeTools?:
    | readonly RuntimeToolDefinition[]
    | ((auth: TAuth) => readonly RuntimeToolDefinition[]);
  surfaces?: never;
  selectSurface?: never;
}

export interface FiniteMcpSurfaceConfig<TAuth, TSurfaces extends McpSurfaceRegistry> {
  /** Finite immutable surfaces, all prepared eagerly exactly once. */
  surfaces: TSurfaces;
  /** Select one declared surface for the resolved identity. */
  selectSurface: (auth: TAuth) => Extract<keyof TSurfaces, string>;
  services?: never;
  runtimeTools?: never;
}

/**
 * Transport-neutral MCP build config. Use direct services for a static or truly
 * identity-dynamic surface; use `surfaces` for a bounded role/plan registry.
 */
export type McpServerBuildConfig<
  TAuth,
  TSurfaces extends McpSurfaceRegistry = McpSurfaceRegistry,
> = McpServerSharedConfig<TAuth> &
  (DirectMcpSurfaceConfig<TAuth> | FiniteMcpSurfaceConfig<TAuth, TSurfaces>);

/**
 * Build an `McpServer` from contract services for a resolved identity.
 * Transport-agnostic — the shared core behind every MCP transport.
 */
export function buildMcpServer<TAuth>(
  config: McpServerBuildConfig<TAuth>,
  auth: TAuth,
): McpServer {
  let surface: McpSurfaceDefinition;
  if (config.surfaces) {
    const key = config.selectSurface(auth);
    if (!Object.hasOwn(config.surfaces, key)) {
      throw new Error(`[stitchkit] Unknown MCP surface "${key}"`);
    }
    const selected = config.surfaces[key];
    if (!selected) throw new Error(`[stitchkit] Unknown MCP surface "${key}"`);
    surface = selected;
  } else {
    const services =
      typeof config.services === 'function' ? config.services(auth) : config.services;
    const runtimeTools =
      typeof config.runtimeTools === 'function'
        ? config.runtimeTools(auth)
        : config.runtimeTools;
    surface = { services, runtimeTools };
  }
  const prepared = prepareMcpServerSurface(surface, {
    extend: config.extend,
    flattenUnionInput: config.flattenUnionInput,
    schemaValidation: config.schemaValidation,
    logger: config.logger,
  });
  return buildMcpServerFromPrepared(config, auth, prepared);
}

/** Build one fresh server from a deterministic surface prepared by its owner. */
export function buildMcpServerFromPrepared<TAuth>(
  config: McpServerBuildConfig<TAuth>,
  auth: TAuth,
  prepared: PreparedMcpServerSurface,
): McpServer {
  let roundCodec: RequestStateCodec<McpRoundState> | undefined;
  if (config.multiRound) {
    const principal = config.multiRound.state.principal(auth);
    roundCodec = createRequestStateCodec({
      key: config.multiRound.state.key,
      ttlSeconds: config.multiRound.state.ttlSeconds,
      bind: (mcpContext) => `${mcpContext.mcpReq.method}\0${principal}`,
    });
  }
  const dynamicSurface =
    !config.surfaces &&
    (typeof config.services === 'function' || typeof config.runtimeTools === 'function');
  const serverOptions: ServerOptions = {
    ...(config.instructions !== undefined && { instructions: config.instructions }),
    ...(!dynamicSurface &&
      config.cache?.operations !== undefined && {
        cacheHints: config.cache.operations,
      }),
    ...(config.multiRound?.serving !== undefined && {
      inputRequired: config.multiRound.serving,
    }),
    ...(roundCodec !== undefined && {
      requestState: { verify: roundCodec.verify },
    }),
  };
  const server = new McpServer(config.serverInfo, serverOptions);
  const context = config.context?.(auth);
  mountPreparedMcp(server, prepared.contractTools, {
    context,
    hooks: config.hooks,
    lifecycle: config.lifecycle,
    extend: config.extend,
    schemaValidation: config.schemaValidation,
    logger: config.logger,
    coerceJsonArgs: config.coerceJsonArgs,
    flattenUnionInput: config.flattenUnionInput,
    errorHint: config.errorHint,
    onOutputStrip: config.onOutputStrip,
    ...(roundCodec !== undefined && {
      multiRoundRuntime: {
        codec: roundCodec,
        maxRounds: config.multiRound?.serving?.maxRounds ?? 10,
      },
    }),
  });
  mountPreparedRuntimeMcp(server, prepared.runtimeTools, {
    context,
    hooks: config.hooks,
    lifecycle: config.lifecycle,
    coerceJsonArgs: config.coerceJsonArgs,
    onOutputStrip: config.onOutputStrip,
    formatResult: (result, mode, toolName) =>
      formatMcpResult(result, mode, toolName, config.errorHint),
    ...(roundCodec !== undefined && {
      multiRoundRuntime: {
        codec: roundCodec,
        maxRounds: config.multiRound?.serving?.maxRounds ?? 10,
      },
    }),
  });
  config.rawTools?.(server, auth);
  for (const resource of config.resources ?? []) {
    mountMcpResource(server, resource);
  }
  return server;
}

/**
 * Register one MCP Apps UI resource on an `McpServer`. The `read` callback's
 * HTML is served under the resource `uri` with the apps MIME type; any `ui`
 * metadata (CSP, border, domain) is attached to the content's `_meta.ui`.
 */
export function mountMcpResource(server: McpServer, resource: McpResourceDef): void {
  server.registerResource(
    resource.name,
    resource.uri,
    {
      mimeType: resource.mimeType ?? RESOURCE_MIME_TYPE,
      ...(resource.cacheHint !== undefined && { cacheHint: resource.cacheHint }),
    },
    async () => ({
      contents: [
        {
          uri: resource.uri,
          mimeType: resource.mimeType ?? RESOURCE_MIME_TYPE,
          text: await resource.read(),
          ...(resource.ui && { _meta: { ui: resource.ui } }),
        },
      ],
    }),
  );
}
