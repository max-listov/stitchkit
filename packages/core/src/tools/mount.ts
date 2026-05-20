/**
 * Shared mounting machinery for MCP and agent tools. `mountMcp` and `mountAgent`
 * differ only in their transport SDK — the method walk, the schema merge, the
 * extend handling and the call execution are identical and live here.
 */
import { z } from 'zod';
import type { Transport, TransportSource } from '../contract';
import type { MethodDef, ServiceDef } from '../server/types';
import { withJsonCoercion } from './coerce';
import {
  executeToolMethod,
  type ToolCallHooks,
  type ToolLifecycle,
  type ToolResult,
} from './execute';
import { flattenDiscriminatedUnion } from './flatten';
import { toToolName } from './names';
import { mergeSchemas } from './schema';

/**
 * Extra arguments folded into a mounted tool's schema — the host supplies them,
 * `resolve` turns them into handler context. Shared by `mountMcp` / `mountAgent`.
 */
export interface ToolExtend {
  /** Extra Zod fields added to every (matching) tool's input schema. */
  schema: Record<string, z.ZodType>;
  /** Turn the extra arguments into context merged into the handler. */
  resolve: (
    args: Record<string, unknown>,
  ) => Record<string, unknown> | Promise<Record<string, unknown>>;
  /** Limit the extension to specific methods — default: every method. */
  filter?: (service: ServiceDef, method: MethodDef) => boolean;
}

/** One contract method resolved for mounting as a tool. */
export interface MountableTool {
  /** The contract method behind the tool. */
  method: MethodDef<unknown, unknown, unknown>;
  /** Tool name — the `toolName` override, else derived from service + method. */
  name: string;
  /** Merged params + input schema, with the extend fields folded in when they apply. */
  schema: z.ZodType;
  /** Whether `ToolExtend` applies to this method. */
  shouldExtend: boolean;
}

/** Fold a `ToolExtend`'s extra fields into a tool's base schema. */
function applyExtend(base: z.ZodType, extra: Record<string, z.ZodType>): z.ZodType {
  if (base instanceof z.ZodObject) {
    const conflicts = Object.keys(extra).filter((key) => key in base.shape);
    if (conflicts.length > 0) {
      throw new Error(
        `Tool extend conflict: ${conflicts.join(', ')} already declared by the contract`,
      );
    }
    return z.object({ ...extra, ...base.shape });
  }
  // A non-object base (a union / discriminated union) — intersect rather than
  // spread, so the extend fields are still required alongside it.
  return z.intersection(z.object(extra), base);
}

export interface CollectToolsConfig {
  extend?: ToolExtend;
  /** Coerce JSON-stringified arrays/objects in tool arguments. Default: true. */
  coerceJsonArgs?: boolean;
  /** Flatten discriminated union inputs into a single object for MCP. Default: false. */
  flattenUnionInput?: boolean;
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
  const { extend, coerceJsonArgs = true, flattenUnionInput = false } = config;
  const tools: MountableTool[] = [];
  for (const [methodName, method] of Object.entries(service.methods)) {
    if (method.expose && !method.expose.includes(transport)) continue;
    if (method.multipart) continue;

    const name = method.toolName ?? toToolName(service.name, methodName);
    let baseSchema = mergeSchemas(method.paramsSchema, method.inputSchema);

    if (flattenUnionInput && baseSchema instanceof z.ZodDiscriminatedUnion) {
      baseSchema = flattenDiscriminatedUnion(baseSchema);
    }
    if (coerceJsonArgs && baseSchema instanceof z.ZodObject) {
      baseSchema = withJsonCoercion(baseSchema);
    }

    const shouldExtend = !!extend && (!extend.filter || extend.filter(service, method));
    const schema =
      shouldExtend && extend ? applyExtend(baseSchema, extend.schema) : baseSchema;
    tools.push({ method, name, schema, shouldExtend });
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
  errorHint?: (toolName: string, errorCode: string) => string | null;
}

/**
 * Build the call executor for a mount — resolve the extend context, strip the
 * extend arguments, execute. The shared back half of `mountMcp` / `mountAgent`.
 */
export function createToolRunner(
  config: ToolRunnerConfig,
): (tool: MountableTool, rawArgs: Record<string, unknown>) => Promise<ToolResult> {
  const extendKeys = config.extend ? new Set(Object.keys(config.extend.schema)) : null;
  return async (tool, rawArgs) => {
    let extraContext: Record<string, unknown> = {};
    if (tool.shouldExtend && config.extend) {
      extraContext = await config.extend.resolve(rawArgs);
    }
    const cleanArgs = extendKeys
      ? Object.fromEntries(Object.entries(rawArgs).filter(([key]) => !extendKeys.has(key)))
      : rawArgs;
    return executeToolMethod(
      tool.method,
      tool.name,
      cleanArgs,
      // `source` is written last — neither the static context nor a
      // `ToolExtend.resolve` result can shadow the real transport tag.
      { ...config.context, ...extraContext, source: config.source },
      config.hooks,
      config.lifecycle,
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
  errorHint?: (toolName: string, errorCode: string) => string | null,
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
