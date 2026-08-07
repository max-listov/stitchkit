/**
 * Shared mounting machinery for MCP and agent tools. `mountMcp` and `mountAgent`
 * differ only in their transport SDK — the method walk, the schema merge, the
 * extend handling and the call execution are identical and live here.
 */
import { z } from 'zod';
import type { Transport, TransportSource } from '../contract';
import type { MethodDef, ServiceDef } from '../server/types';
import {
  type ErrorHintFn,
  executeToolMethod,
  type ToolArgumentExtension,
  type ToolCallHooks,
  type ToolLifecycle,
  type ToolOperation,
  type ToolResult,
} from './execute';
import type { ToolPresentationSchema } from './flatten';
import { assertToolName, hasUsableChars, toToolName } from './names';
import { buildToolPresentationSchema } from './presentation';
import { mergeSchemas, rebuildObject } from './schema';

/**
 * Extra arguments folded into a mounted tool's schema — the host supplies them,
 * `resolve` turns them into handler context. Shared by `mountMcp` / `mountAgent`.
 *
 * `TContext` is the typed handler context the extension contributes — left as
 * `Record<string, unknown>` for the untyped mounts, pinned by `createToolkit`
 * so `resolve` is checked against the app's context shape.
 */
export interface ToolExtend<
  TContext extends Record<string, unknown> = Record<string, unknown>,
> {
  /** Extra Zod fields added to every (matching) tool's input schema. */
  schema: Record<string, z.ZodType>;
  /** Turn the extra arguments into context merged into the handler. */
  resolve: (args: Record<string, unknown>) => Partial<TContext> | Promise<Partial<TContext>>;
  /** Limit the extension to specific methods — default: every method. */
  filter?: (service: ServiceDef, method: MethodDef) => boolean;
}

/** One contract or framework-native operation resolved for mounting as a tool. */
export interface MountableTool {
  /** The executable operation identity and schemas behind the tool. */
  method: ToolOperation;
  /** Tool name — the `toolName` override, else derived from service + method. */
  name: string;
  /** Executable source schema used only by the CLI argument adapter. */
  argumentSchema: z.ZodType;
  /** Immutable model-facing JSON Schema; never used to execute validation effects. */
  presentationSchema: ToolPresentationSchema;
  /** Whether `ToolExtend` applies to this method. */
  shouldExtend: boolean;
}

/**
 * Fold a `ToolExtend`'s extra fields into a tool's base schema.
 *
 * The extend fields join the executable CLI argument shape. MCP and agent
 * presentation is compiled separately; the shared runner parses extension keys
 * once and strips them before the contract parse. → ADR 0050.
 */
function applyExtend(base: z.ZodType, extra: Record<string, z.ZodType>): z.ZodType {
  if (base instanceof z.ZodObject) {
    const conflicts = Object.keys(extra).filter((key) => key in base.shape);
    if (conflicts.length > 0) {
      throw new Error(
        `Tool extend conflict: ${conflicts.join(', ')} already declared by the contract`,
      );
    }
    return rebuildObject(base, { ...extra, ...base.shape });
  }
  // A non-object base (a union / discriminated union) — intersect rather than
  // spread, so the extend fields are still required alongside it.
  return z.intersection(z.object(extra), base);
}

export interface CollectToolsConfig {
  extend?: ToolExtend;
  /** Flatten discriminated union inputs into a single object for MCP. Default: false. */
  flattenUnionInput?: boolean;
  /**
   * Throw on a tool name no provider will accept. Default: true — every mount
   * wants it. The read-only listers pass `false`: `listToolNames` is the
   * documented way to *find* an offending name before an upgrade, so it must
   * report one rather than die on it. → ADR 0035.
   */
  assertNames?: boolean;
}

/**
 * Walk a service's methods and resolve each one exposed on `transport` to a
 * tool name and schema — the shared front half of `mountMcp` / `mountAgent`.
 */
export function collectTools(
  service: ServiceDef,
  transport: Transport,
  config: CollectToolsConfig = {},
): MountableTool[] {
  const { extend, flattenUnionInput = false, assertNames = true } = config;
  const tools: MountableTool[] = [];
  for (const [methodName, method] of Object.entries(service.methods)) {
    // CLI is opt-IN: a method surfaces as a command only when its `expose`
    // explicitly lists `'CLI'`. The other tool transports are default-on — a
    // method with no `expose` is on MCP and AGENT — so adding the CLI transport
    // never silently widens an existing contract's surface.
    if (transport === 'CLI') {
      if (!method.expose?.includes('CLI')) continue;
    } else if (method.expose && !method.expose.includes(transport)) {
      continue;
    }
    if (method.multipart) continue;
    // `rawBody` exists only on an HTTP request. `implement` forces HTTP
    // exposure, and this guard keeps a manually assembled ServiceDef honest.
    if (method.rawBody) continue;
    // A raw endpoint returns a `Response`. Every tool transport would serialize
    // that into `{}` and hand the model an empty object as the answer — the
    // exact failure a consumer hit before this endpoint kind existed. The skip
    // is load-bearing, not tidiness: without `expose`, MCP and AGENT are on by
    // default, so a raw endpoint would otherwise mount as a tool. → ADR 0038.
    if (method.rawResponse) continue;

    const name = method.toolName ?? toToolName(service.name, methodName);
    // CLI is exempt: `[a-zA-Z0-9_-]{1,64}` is a *provider* rule, and a CLI command
    // is typed into a shell — there is no provider to reject it. Holding it to the
    // provider charset would refuse `поиск`, a command that worked. → ADR 0035.
    if (assertNames && transport !== 'CLI') {
      // A prefix of only illegal characters normalises to separators, and the
      // resulting `get_` / `list_` PASSES the charset check while being both
      // meaningless and identical for every such service — so it is rejected on
      // its own terms, not by the regex. → ADR 0035.
      if (!method.toolName && !hasUsableChars(service.name)) {
        throw new Error(
          `Service prefix "${service.name}" (method "${methodName}") has no characters usable in a tool name — set an explicit \`toolName\` or rename the prefix`,
        );
      }
      assertToolName(name, service.name, methodName);
    }
    const shouldExtend = !!extend && (!extend.filter || extend.filter(service, method));
    const baseArgumentSchema = mergeSchemas(method.paramsSchema, method.inputSchema);
    const argumentSchema =
      shouldExtend && extend
        ? applyExtend(baseArgumentSchema, extend.schema)
        : baseArgumentSchema;
    const presentationSchema = buildToolPresentationSchema({
      paramsSchema: method.paramsSchema,
      inputSchema: method.inputSchema,
      extendSchema: shouldExtend ? extend?.schema : undefined,
      flattenUnionInput,
      unrepresentable: 'any',
    });
    tools.push({ method, name, argumentSchema, presentationSchema, shouldExtend });
  }
  return tools;
}

/** Per-mount config a tool runner closes over. */
export interface ToolRunnerConfig {
  /** Transport tag put on every call's context. */
  source: TransportSource;
  /** Extend applied at mount — its arguments are resolved then stripped. */
  extend?: ToolExtend;
  /** Static context merged into every handler. */
  context?: Record<string, unknown>;
  /** Tool-call observability hooks. */
  hooks?: ToolCallHooks;
  /** Auth / scope gate and result transform — runs for every tool call. */
  lifecycle?: ToolLifecycle;
  /** Global error hint injected into every failed tool result. */
  errorHint?: ErrorHintFn;
  /** Coerce JSON-stringified arrays/objects in tool arguments. Default: true. */
  coerceJsonArgs?: boolean;
  /**
   * Report handler-output keys the contract schema removed — the tool-side twin of
   * `createServer`'s `warnOnOutputStrip`. Off unless a reporter is passed; the key
   * diff only runs when one is. → ADR 0037.
   */
  onOutputStrip?: (toolName: string, paths: string[]) => void;
}

/**
 * Build the call executor for a mount — resolve the extend context, strip the
 * extend arguments, execute. The shared back half of `mountMcp` / `mountAgent`.
 */
export function createToolRunner(
  config: ToolRunnerConfig,
): (tool: MountableTool, rawArgs: Record<string, unknown>) => Promise<ToolResult> {
  const extension: ToolArgumentExtension | undefined = config.extend
    ? {
        schema: z.object(config.extend.schema),
        resolve: config.extend.resolve,
      }
    : undefined;
  return async function runOneToolCall(
    tool: MountableTool,
    rawArgs: Record<string, unknown>,
  ): Promise<ToolResult> {
    return executeToolMethod(
      tool.method,
      tool.name,
      rawArgs,
      { ...config.context, source: config.source },
      config.hooks,
      config.lifecycle,
      config.coerceJsonArgs ?? true,
      config.onOutputStrip ? (paths) => config.onOutputStrip?.(tool.name, paths) : undefined,
      tool.shouldExtend ? extension : undefined,
    );
  };
}

/**
 * Shape a failed `ToolResult` into the `{ error, details?, _hint? }` object
 * both transports return on error. When a global `errorHint` is provided, it
 * is appended after the per-error `AppError.hint` (if any).
 */
export function formatToolError(
  result: Extract<ToolResult, { ok: false }>,
  toolName?: string,
  errorHint?: ErrorHintFn,
): Record<string, unknown> {
  const err: Record<string, unknown> = { error: result.code };
  if (result.details) err.details = result.details;

  const hints: string[] = [];
  if (result.hint) hints.push(result.hint);
  if (errorHint && toolName) {
    const global = errorHint(toolName, result.code);
    if (global) hints.push(global);
  }
  if (hints.length > 0) err._hint = hints.join(' ');

  return err;
}
