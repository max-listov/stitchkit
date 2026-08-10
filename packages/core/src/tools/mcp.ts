import {
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
  toolResultFromError,
} from './execute';
import { type McpResourceDef, RESOURCE_MIME_TYPE } from './mcp-app';
import {
  formatMcpResult,
  type McpSchemaValidationConfig,
  type McpSurfaceDefinition,
  type McpSurfaceRegistry,
  type PreparedMcpServerSurface,
  type PreparedMcpSurface,
  prepareMcpServerSurface,
  prepareMcpSurface,
  type ValidateMcpSchemasConfig,
} from './mcp-prepare';
import { type McpRoundRuntime, type McpRoundState, resolveMcpRound } from './mcp-round';
import { runInMcpRequestContext } from './mcp-trace';
import { createToolRunner, type ToolExtend } from './mount';
import { mountPreparedRuntimeMcp } from './native-mcp';
import { presentationMetadata } from './presentation';
import type { RuntimeToolDefinition } from './runtime-tool';

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
    multiRound: {
      stateConfigured: config.multiRound !== undefined,
      maxRounds: config.multiRound?.serving?.maxRounds ?? 10,
    },
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
