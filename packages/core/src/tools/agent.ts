import type { ToolSet } from 'ai';
import { tool, zodSchema } from 'ai';
import { isRecord } from '../internal/typed';
import type { ServiceDef } from '../server/types';
import {
  type ErrorHintFn,
  type ToolCallHooks,
  type ToolLifecycle,
  toolResultFromError,
} from './execute';
import { collectTools, createToolRunner, formatToolError, type ToolExtend } from './mount';

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
  /** Flatten discriminated union inputs into a single object. Default: false. */
  flattenUnionInput?: boolean;
  /** Global error hint injected into every failed tool result. */
  errorHint?: ErrorHintFn;
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
  });

  for (const service of serviceList) {
    for (const mountable of collectTools(service, 'AGENT', {
      extend: config.extend,
      flattenUnionInput: config.flattenUnionInput,
    })) {
      if (mountable.name in tools) {
        throw new Error(
          `Duplicate agent tool name "${mountable.name}" across mounted services`,
        );
      }
      tools[mountable.name] = tool({
        description: mountable.method.desc,
        inputSchema: zodSchema(mountable.schema),
        execute: async (rawArgs) => {
          const args = isRecord(rawArgs) ? rawArgs : {};
          try {
            const result = await runTool(mountable, args);
            if (result.ok) return result.data;
            return formatToolError(result, mountable.name, config.errorHint);
          } catch (err) {
            return formatToolError(toolResultFromError(err), mountable.name, config.errorHint);
          }
        },
      });
    }
  }

  return tools;
}
