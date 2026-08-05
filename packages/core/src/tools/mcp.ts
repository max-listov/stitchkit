import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
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
import { type JsonSchemaIo, toJsonSchema } from './json-schema';
import { type McpResourceDef, RESOURCE_MIME_TYPE } from './mcp-app';
import {
  collectTools,
  createToolRunner,
  formatToolError,
  type MountableTool,
  type ToolExtend,
} from './mount';
import { assertUniqueToolName } from './names';

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

/** A single-element MCP text content block list. */
function textBlock(text: string): Array<{ type: 'text'; text: string }> {
  return [{ type: 'text', text }];
}

/** How a tool's result maps to MCP `structuredContent`. */
type StructuredMode = 'none' | 'direct' | 'wrapped';

/**
 * Shape a `ToolResult` into an MCP tool response. Always emits a text `content`
 * block (the model reads it). Emits `structuredContent` when the tool declared
 * an `outputSchema` — directly for an object output, wrapped in `{ result }`
 * for a non-object output (an MCP App UI consumes the structured payload).
 */
function formatMcpResult(
  result: ToolResult,
  mode: StructuredMode,
  toolName?: string,
  errorHint?: ErrorHintFn,
) {
  if (result.ok) {
    const content = textBlock(JSON.stringify(result.data, null, 2));
    if (mode === 'wrapped') {
      return { content, structuredContent: { result: result.data } };
    }
    if (mode === 'direct' && isRecord(result.data)) {
      return { content, structuredContent: result.data };
    }
    return { content };
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
 * Resolve a method's `output` to what MCP advertises as the tool `outputSchema`.
 * An object output is used directly; a non-object output (an array, a primitive)
 * is wrapped in `{ result: <output> }` so the result can still carry a valid
 * `structuredContent` object.
 */
function resolveOutputSchema(
  outputSchema: z.ZodType | undefined,
): { schema: z.ZodType; mode: Exclude<StructuredMode, 'none'> } | null {
  if (!outputSchema) return null;
  if (outputSchema instanceof z.ZodObject) {
    return { schema: outputSchema, mode: 'direct' };
  }
  return { schema: z.object({ result: outputSchema }), mode: 'wrapped' };
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
      `[stitchkit] ${failures.length} MCP tool(s) have an incompatible schema:\n - ${failures.join('\n - ')}`,
    );
  }
}

/** What `prepareMcpTool` resolves for a tool cleared to register. */
interface PreparedMcpTool {
  outputSchema?: z.ZodType;
  outputMode: StructuredMode;
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
  policy: IncompatibleSchemaPolicy,
  logger: StitchLogger | undefined,
  failures: string[],
  seen: Set<string>,
): PreparedMcpTool | null {
  assertUniqueToolName(mountable.name, seen.has(mountable.name), 'MCP tool name');
  seen.add(mountable.name);

  // MCP advertises a tool's arguments as a JSON Schema object, and the SDK only
  // introspects a `ZodObject`. A union / discriminated union / scalar input
  // would be advertised as an empty schema — reject it loudly instead.
  if (!(mountable.schema instanceof z.ZodObject)) {
    reportIncompatible(
      `MCP tool "${mountable.name}" — input must be an object schema; a union, discriminated union or scalar cannot be an MCP tool input (flatten it in the contract, or drop MCP from \`expose\`)`,
      policy,
      logger,
      failures,
    );
    return null;
  }

  const inputError = probeSchema(mountable.schema, 'input');
  if (inputError) {
    reportIncompatible(
      `MCP tool "${mountable.name}" — input schema is not JSON Schema-compatible: ${inputError}`,
      policy,
      logger,
      failures,
    );
    return null;
  }

  // An object `output` becomes the tool's `outputSchema` directly; a non-object
  // `output` is wrapped in `{ result }`. Either way a successful result carries
  // `structuredContent`. An incompatible output is reported but the tool still
  // registers, text-only.
  const resolved = resolveOutputSchema(mountable.method.outputSchema);
  if (!resolved) return { outputMode: 'none' };

  const outputError = probeSchema(resolved.schema, 'output');
  if (outputError) {
    reportIncompatible(
      `MCP tool "${mountable.name}" — output schema is not JSON Schema-compatible: ${outputError}`,
      policy,
      logger,
      failures,
    );
    return { outputMode: 'none' };
  }
  return { outputSchema: resolved.schema, outputMode: resolved.mode };
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
  /** What to do when a tool's schema is not MCP-compatible. Default `'throw'`. */
  onIncompatibleSchema?: IncompatibleSchemaPolicy;
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

/**
 * Validate that every contract tool in `services` can be advertised on the MCP
 * surface — object-shaped, JSON Schema-compatible input / output, no tool-name
 * collision across services. The build-time check behind `mountMcp` — also
 * callable on its own (a startup assertion, a test) to fail a deploy before
 * the first request.
 */
export function validateMcpSchemas(
  services: ServiceDef[],
  onIncompatibleSchema: IncompatibleSchemaPolicy = 'throw',
  logger?: StitchLogger,
  // Must mirror the live mount (`extend` / `flattenUnionInput`) — otherwise the
  // build-time probe vets a DIFFERENT schema than `mountMcp` advertises, hiding
  // flatten incompatibilities and falsely failing union inputs. → ADR 0033.
  options?: { extend?: ToolExtend; flattenUnionInput?: boolean },
): void {
  const seen = new Set<string>();
  const failures: string[] = [];

  for (const service of services) {
    for (const mountable of collectTools(service, 'MCP', options)) {
      prepareMcpTool(mountable, onIncompatibleSchema, logger, failures, seen);
    }
  }

  throwIfFailures(failures);
}

export function mountMcp(
  mcpServer: McpServer,
  services: ServiceDef | ServiceDef[],
  config: McpMountConfig = {},
): void {
  const serviceList = Array.isArray(services) ? services : [services];
  const policy = config.onIncompatibleSchema ?? 'throw';
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

  const seen = new Set<string>();
  const failures: string[] = [];

  for (const service of serviceList) {
    for (const mountable of collectTools(service, 'MCP', {
      extend: config.extend,
      flattenUnionInput: config.flattenUnionInput,
    })) {
      const prepared = prepareMcpTool(mountable, policy, config.logger, failures, seen);
      if (!prepared) continue;

      const toolConfig: {
        description: string;
        inputSchema: z.ZodType;
        outputSchema?: z.ZodType;
        annotations?: EndpointToolAnnotations;
        _meta?: Record<string, unknown>;
      } = { description: mountable.method.desc, inputSchema: mountable.schema };
      if (prepared.outputSchema) toolConfig.outputSchema = prepared.outputSchema;
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

      mcpServer.registerTool(mountable.name, toolConfig, async (rawArgs) => {
        const args = isRecord(rawArgs) ? rawArgs : {};
        try {
          const result = await runTool(mountable, args);
          return formatMcpResult(
            result,
            prepared.outputMode,
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
      });
    }
  }

  throwIfFailures(failures);
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
  /** Tool-call observability hooks — `afterToolCall` fires for every result
   *  (success and error), so the consuming app can log MCP tool outcomes. */
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
  /** What to do when a tool's schema is not MCP-compatible. Default `'throw'`. */
  onIncompatibleSchema?: IncompatibleSchemaPolicy;
  /** Logger for schema-incompatibility warnings — defaults to `console`. */
  logger?: StitchLogger;
  /** Register native (non-contract) MCP tools — receives the `McpServer` and the
   *  resolved identity, like `services` and `context` do, so a native tool can be
   *  per-tenant. For tools returning multimodal content, e.g. `mountViewFile`.
   *  Note this is **not** a scope gate: native tools are not contract methods and
   *  `lifecycle` does not run for them. */
  nativeTools?: (server: McpServer, auth: TAuth) => void;
  /** MCP Apps UI resources (`ui://…`) served for tools that declare `ui`. */
  resources?: McpResourceDef[];
  /** Server instructions — a short (≤2KB) hint to the host on when and how to
   *  use these tools. Surfaced to MCP tool-search. */
  instructions?: string;
  /** Coerce JSON-stringified arrays/objects in tool arguments. Default: true. */
  coerceJsonArgs?: boolean;
  /** Flatten discriminated union inputs into a single object. Default: false. */
  flattenUnionInput?: boolean;
  /** Global error hint injected into every failed tool result. */
  errorHint?: ErrorHintFn;
  /** Report output keys the contract schema removed — → ADR 0037. */
  onOutputStrip?: (toolName: string, paths: string[]) => void;
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
  mountMcp(server, services, {
    context,
    hooks: config.hooks,
    lifecycle: config.lifecycle,
    extend: config.extend,
    onIncompatibleSchema: config.onIncompatibleSchema,
    logger: config.logger,
    coerceJsonArgs: config.coerceJsonArgs,
    flattenUnionInput: config.flattenUnionInput,
    errorHint: config.errorHint,
  });
  config.nativeTools?.(server, auth);
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
    { mimeType: resource.mimeType ?? RESOURCE_MIME_TYPE },
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
