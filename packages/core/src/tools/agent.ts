import type { ToolExecutionOptions, ToolSet } from 'ai';
import { jsonSchema, tool } from 'ai';
import { isRecord } from '../internal/typed';
import type { ServiceDef } from '../server/types';
import { AgentToolError } from './agent-tool-error';
import { resolveToolDurability } from './durability-context';
import type { ToolDurability, ToolDurabilityFactory } from './durability-port';
import { isToolExecutionControlError } from './execute';
import type { ErrorHintFn, ToolCallHooks, ToolLifecycle } from './execute-hooks';
import { toolCauseFromResult, toolResultFromError } from './execute-result';
import { createToolRunner, formatToolError, type ToolExtend } from './mount';
import type { AgentToolRegistry } from './registry';
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
  /**
   * A composed tool registry. Mutually exclusive with `runtimeTools`: one
   * declaration of the runtime surface, not two lists to reconcile.
   */
  registry?: AgentToolRegistry;
  /**
   * Make tool bodies restartable: `step` / `sleep` / `waitFor` appear in the
   * handler context, backed by whatever ledger the application already has.
   *
   * Without it a tool that starts slow work and must report exactly once —
   * including after a host restart — has to keep that bookkeeping beside the
   * tool instead of inside it. `agent-runtime` supplies its own durability
   * through the call context and does not need this option; an application
   * running its own loop does, and had no way to reach it.
   */
  durability?: ToolDurabilityFactory;
}

export function mountAgent(
  services: ServiceDef | ServiceDef[],
  config: AgentMountConfig = {},
): ToolSet {
  const serviceList = Array.isArray(services) ? services : [services];
  if (config.registry && config.runtimeTools) {
    throw new Error('mountAgent accepts either runtimeTools or a registry, not both');
  }
  const runtimeTools = config.registry ? config.registry.tools : config.runtimeTools;
  const tools: ToolSet = {};
  const runTool = createToolRunner({
    source: 'agent',
    toolSurface: true,
    extend: config.extend,
    context: config.context,
    hooks: config.hooks,
    lifecycle: config.lifecycle,
    coerceJsonArgs: config.coerceJsonArgs,
    onOutputStrip: config.onOutputStrip,
  });

  for (const entry of collectToolSurface({
    surface: { services: serviceList, runtimeTools },
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
      // The runtime's own durability travels in the SDK call context; an
      // application that runs its own loop declares a factory instead. The
      // context wins where both exist: it is the runtime driving the call, and
      // its ledger is the one the run is recorded in.
      const durability: ToolDurability | undefined =
        resolveToolDurability(options.context, options.toolCallId, options.abortSignal) ??
        config.durability?.(options.toolCallId, options.abortSignal);
      // The provider's call id travels as ordinary call context, so it reaches
      // `beforeToolCall` / `afterToolCall` / `onToolError` on the existing hook
      // seam instead of through a second observation channel of its own.
      const callContext = { signal: options.abortSignal, toolCallId: options.toolCallId };
      const executeTool = durability
        ? createToolRunner({
            source: 'agent',
            toolSurface: true,
            extend: config.extend,
            context: {
              ...config.context,
              // Bound, because the port is public and an application may
              // satisfy it with a class: a method taken as a bare value
              // loses `this` and fails on its first call.
              step: durability.step.bind(durability),
              sleep: durability.sleep.bind(durability),
              waitFor: durability.waitFor.bind(durability),
            },
            hooks: config.hooks,
            lifecycle: config.lifecycle,
            coerceJsonArgs: config.coerceJsonArgs,
            onOutputStrip: config.onOutputStrip,
          })
        : runTool;
      const result = await executeTool(mountable, args, callContext).catch((err: unknown) => {
        if (isToolExecutionControlError(err)) throw err;
        throw new AgentToolError(
          formatToolError(toolResultFromError(err), mountable.name, config.errorHint),
          err,
        );
      });
      if (result.ok) return result.data;
      throw new AgentToolError(
        formatToolError(result, mountable.name, config.errorHint),
        toolCauseFromResult(result),
      );
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
