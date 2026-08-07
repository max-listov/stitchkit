import { AppError, type Transport, type TransportSource } from '../contract';
import type { ServiceDef } from '../server/types';
import {
  type ToolCallContext,
  type ToolCallHooks,
  type ToolLifecycle,
  type ToolResult,
  toolErrorFromResult,
} from './execute';
import { collectTools, createToolRunner, type MountableTool, type ToolExtend } from './mount';
import { assertUniqueToolName } from './names';

export type ToolInvokerTransport = Exclude<Transport, 'HTTP'>;

/** Configuration for a compiled in-process contract-tool dispatcher. */
export interface ToolInvokerConfig {
  /** Existing exposure policy to honour. Required: there is no bypass-all mode. */
  transport: ToolInvokerTransport;
  extend?: ToolExtend;
  /** Compiles the same presentation surface as the chosen mount. */
  flattenUnionInput?: boolean;
  /** Coerce JSON-stringified arrays/objects in tool arguments. Default: true. */
  coerceJsonArgs?: boolean;
}

/** Runtime state for one in-process invocation; never retained by the registry. */
export interface ToolInvocationOptions {
  /** Actual call source written to handler context and audit. Default: `internal`. */
  source?: TransportSource;
  context?: Omit<ToolCallContext, 'source'>;
  hooks?: ToolCallHooks;
  lifecycle?: ToolLifecycle;
  /** Report output keys removed by contract validation. */
  onOutputStrip?: (toolName: string, paths: string[]) => void;
}

/** A name-indexed dispatcher compiled once and executed by the shared tool runner. */
export interface ToolInvoker {
  readonly names: readonly string[];
  invoke(
    name: string,
    args: Record<string, unknown>,
    options?: ToolInvocationOptions,
  ): Promise<ToolResult>;
  invokeOrThrow(
    name: string,
    args: Record<string, unknown>,
    options?: ToolInvocationOptions,
  ): Promise<unknown>;
}

/**
 * Compile contract tools into an in-process invoker without mounting an SDK.
 * Every call still runs the canonical validation/lifecycle/hooks/output runner.
 */
export function createToolInvoker(
  services: ServiceDef | readonly ServiceDef[],
  config: ToolInvokerConfig,
): ToolInvoker {
  const serviceList = Array.isArray(services) ? services : [services];
  const tools = new Map<string, MountableTool>();

  for (const service of serviceList) {
    for (const tool of collectTools(service, config.transport, {
      extend: config.extend,
      flattenUnionInput: config.flattenUnionInput,
    })) {
      assertUniqueToolName(tool.name, tools.has(tool.name), 'in-process tool name');
      tools.set(tool.name, tool);
    }
  }

  const names = Object.freeze([...tools.keys()].sort());
  const operation = (name: string): MountableTool => {
    const tool = tools.get(name);
    if (tool) return tool;
    throw new AppError('NOT_FOUND', `Unknown tool: ${name}`, 404, {
      available: names,
    });
  };

  const run = (
    name: string,
    args: Record<string, unknown>,
    options: ToolInvocationOptions = {},
  ): Promise<ToolResult> => {
    const runTool = createToolRunner({
      source: options.source ?? 'internal',
      context: options.context,
      hooks: options.hooks,
      lifecycle: options.lifecycle,
      extend: config.extend,
      coerceJsonArgs: config.coerceJsonArgs,
      onOutputStrip: options.onOutputStrip,
    });
    return runTool(operation(name), args);
  };

  return Object.freeze({
    names,
    invoke(
      name: string,
      args: Record<string, unknown>,
      options?: ToolInvocationOptions,
    ): Promise<ToolResult> {
      return run(name, args, options);
    },
    async invokeOrThrow(
      name: string,
      args: Record<string, unknown>,
      options?: ToolInvocationOptions,
    ): Promise<unknown> {
      const result = await run(name, args, options);
      if (!result.ok) throw toolErrorFromResult(result);
      return result.data;
    },
  });
}
