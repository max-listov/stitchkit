/**
 * Shared mounting machinery for MCP and agent tools. `mountMcp` and `mountAgent`
 * differ only in their transport SDK — the method walk, the schema merge, the
 * extend handling and the call execution are identical and live here.
 */
import { z } from 'zod';
import type { Transport, TransportSource } from '../contract';
import type { MethodDef, ServiceDef } from '../server/types';
import { executeToolMethod, type ToolCallHooks, type ToolResult } from './execute';
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
  schema: z.ZodObject<z.ZodRawShape>;
  /** Whether `ToolExtend` applies to this method. */
  shouldExtend: boolean;
}

/**
 * Walk a service's methods and resolve each one exposed on `transport` to a
 * tool name and schema — the shared front half of `mountMcp` / `mountAgent`.
 */
export function collectTools(
  service: ServiceDef,
  transport: Transport,
  extend: ToolExtend | undefined,
): MountableTool[] {
  const tools: MountableTool[] = [];
  for (const [methodName, method] of Object.entries(service.methods)) {
    if (method.expose && !method.expose.includes(transport)) continue;
    if (method.multipart) continue;

    const name = method.toolName ?? toToolName(service.name, methodName);
    const baseSchema = mergeSchemas(method.paramsSchema, method.inputSchema);
    const shouldExtend = !!extend && (!extend.filter || extend.filter(service, method));
    const schema = shouldExtend
      ? z.object({ ...extend?.schema, ...baseSchema.shape })
      : baseSchema;
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
  /** Tool-call lifecycle hooks. */
  hooks?: ToolCallHooks;
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
      { source: config.source, ...config.context, ...extraContext },
      config.hooks,
    );
  };
}

/**
 * Shape a failed `ToolResult` into the `{ error, details?, _hint? }` object
 * both transports return on error.
 */
export function formatToolError(
  result: Extract<ToolResult, { ok: false }>,
): Record<string, unknown> {
  const err: Record<string, unknown> = { error: result.code };
  if (result.details) err.details = result.details;
  if (result.hint) err._hint = result.hint;
  return err;
}
