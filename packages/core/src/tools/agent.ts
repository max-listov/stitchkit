import type { ToolExecutionOptions, ToolSet } from 'ai';
import { jsonSchema, tool } from 'ai';
import { isRecord } from '../internal/typed';
import type { ServiceDef } from '../server/types';
import { AgentToolError } from './agent-tool-error';
import {
  type ErrorHintFn,
  isToolExecutionControlError,
  type ToolCallHooks,
  type ToolLifecycle,
  toolResultFromError,
} from './execute';
import { createToolRunner, formatToolError, type ToolExtend } from './mount';
import type { RuntimeToolDefinition } from './runtime-tool';
import { collectToolSurface } from './surface';

export interface AgentContext {
  [key: string]: unknown;
}

export interface AgentMountConfig {
  context?: AgentContext;
  /** Tool-call observability hooks. */
  hooks?: ToolCallHooks;
  /**
   * Auth / scope gate and result transform for every tool call — the tool-side
   * twin of `createServer`'s `beforeHandle` / `afterHandle`. Without it an
   * agent tool call bypasses the auth a `createServer` `beforeHandle` enforces.
   */
  lifecycle?: ToolLifecycle;
  extend?: ToolExtend;
  /** Coerce JSON-stringified arrays/objects in tool arguments. Default: true. */
  coerceJsonArgs?: boolean;
  /** Report output keys the contract schema removed — → ADR 0037. */
  onOutputStrip?: (toolName: string, paths: string[]) => void;
  /** Flatten discriminated union inputs into a single object. Default: false. */
  flattenUnionInput?: boolean;
  /** Global error hint injected into every failed tool result. */
  errorHint?: ErrorHintFn;
  /** Framework-managed pathless operations mounted beside contract tools. */
  runtimeTools?: readonly RuntimeToolDefinition[];
}

export function mountAgent(
  services: ServiceDef | ServiceDef[],
  config: AgentMountConfig = {},
): ToolSet {
  const serviceList = Array.isArray(services) ? services : [services];
  const tools: ToolSet = {};
  const runTool = createToolRunner({
    source: 'agent',
    extend: config.extend,
    context: config.context,
    hooks: config.hooks,
    lifecycle: config.lifecycle,
    errorHint: config.errorHint,
    coerceJsonArgs: config.coerceJsonArgs,
    onOutputStrip: config.onOutputStrip,
  });

  for (const entry of collectToolSurface({
    surface: { services: serviceList, runtimeTools: config.runtimeTools },
    transport: 'AGENT',
    extend: config.extend,
    flattenUnionInput: config.flattenUnionInput,
  })) {
    const { mountable } = entry;
    const inputSchema = jsonSchema(mountable.presentationSchema, {
      validate: async (value) =>
        isRecord(value)
          ? { success: true, value }
          : { success: false, error: new Error('Tool arguments must be an object') },
    });
    const execute = async (rawArgs: unknown, options: ToolExecutionOptions<unknown>) => {
      const args = isRecord(rawArgs) ? rawArgs : {};
      const result = await runTool(mountable, args, {
        signal: options.abortSignal,
      }).catch((err: unknown) => {
        if (isToolExecutionControlError(err)) throw err;
        throw new AgentToolError(
          formatToolError(toolResultFromError(err), mountable.name, config.errorHint),
          err,
        );
      });
      if (result.ok) return result.data;
      throw new AgentToolError(formatToolError(result, mountable.name, config.errorHint));
    };

    const presenter = entry.kind === 'runtime' ? entry.definition.present?.agent : undefined;
    if (entry.kind === 'runtime' && presenter) {
      const { definition } = entry;
      const output = definition.output;
      if (!output) {
        throw new Error(
          `Runtime tool "${definition.name}" presenter requires an output schema`,
        );
      }
      tools[definition.name] = tool({
        description: definition.description,
        inputSchema,
        outputSchema: output,
        execute,
        toModelOutput: async ({ output: rawOutput }) => {
          const parsed = output.safeParse(rawOutput);
          if (!parsed.success) {
            return { type: 'text', value: JSON.stringify(rawOutput) };
          }
          return presenter(parsed.data);
        },
      });
    } else {
      const output = entry.kind === 'runtime' ? entry.definition.output : undefined;
      tools[mountable.name] = tool({
        description: mountable.method.desc,
        inputSchema,
        ...(output && { outputSchema: output }),
        execute,
      });
    }
  }

  return tools;
}
