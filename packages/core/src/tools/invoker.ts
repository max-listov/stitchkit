import { AppError, type Transport, type TransportSource } from '../contract';
import type { ServiceDef } from '../server/types';
import type { ToolCallContext, ToolCallHooks, ToolLifecycle, ToolResult } from './execute';
import { collectTools, createToolRunner, type MountableTool, type ToolExtend } from './mount';
import { assertUniqueToolName } from './names';

export type ToolInvokerTransport = Exclude<Transport, 'HTTP'>;

/** Configuration for a compiled in-process contract-tool dispatcher. */
export interface ToolInvokerConfig {
  /** Existing exposure policy to honour. Required: there is no bypass-all mode. */
  transport: ToolInvokerTransport;
  /** Actual call source written to handler context and audit. Default: `internal`. */
  source?: TransportSource;
  context?: Omit<ToolCallContext, 'source'>;
  hooks?: ToolCallHooks;
  lifecycle?: ToolLifecycle;
  extend?: ToolExtend;
  /** Compiles the same presentation surface as the chosen mount. */
  flattenUnionInput?: boolean;
  /** Coerce JSON-stringified arrays/objects in tool arguments. Default: true. */
  coerceJsonArgs?: boolean;
  /** Report output keys removed by contract validation. */
  onOutputStrip?: (toolName: string, paths: string[]) => void;
}

/** A name-indexed dispatcher compiled once and executed by the shared tool runner. */
export interface ToolInvoker {
  readonly names: readonly string[];
  invoke(name: string, args: Record<string, unknown>): Promise<ToolResult>;
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
  const runTool = createToolRunner({
    source: config.source ?? 'internal',
    context: config.context,
    hooks: config.hooks,
    lifecycle: config.lifecycle,
    extend: config.extend,
    coerceJsonArgs: config.coerceJsonArgs,
    onOutputStrip: config.onOutputStrip,
  });

  return Object.freeze({
    names,
    invoke(name: string, args: Record<string, unknown>): Promise<ToolResult> {
      const tool = tools.get(name);
      if (!tool) {
        throw new AppError('NOT_FOUND', `Unknown tool: ${name}`, 404, {
          available: names,
        });
      }
      return runTool(tool, args);
    },
  });
}
