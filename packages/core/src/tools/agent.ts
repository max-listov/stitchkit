import type { ToolSet } from 'ai';
import { jsonSchema, tool } from 'ai';
import { isRecord } from '../internal/typed';
import type { ServiceDef } from '../server/types';
import {
  type ErrorHintFn,
  type ToolCallHooks,
  type ToolLifecycle,
  toolResultFromError,
} from './execute';
import { collectTools, createToolRunner, formatToolError, type ToolExtend } from './mount';
import { assertUniqueToolName } from './names';
import {
  type RuntimeToolDefinition,
  runtimeToolMountable,
  runtimeToolSupports,
} from './runtime-tool';

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

  for (const service of serviceList) {
    for (const mountable of collectTools(service, 'AGENT', {
      extend: config.extend,
      flattenUnionInput: config.flattenUnionInput,
    })) {
      // `Object.hasOwn`, not `in`: `in` walks the prototype chain, so a tool
      // legitimately named `toString` / `valueOf` / `constructor` would be
      // reported as a duplicate of nothing. MCP (a `Set`) and CLI (a `Map`) were
      // always immune; this makes the guarantee actually uniform.
      assertUniqueToolName(
        mountable.name,
        Object.hasOwn(tools, mountable.name),
        'agent tool name',
      );
      tools[mountable.name] = tool({
        description: mountable.method.desc,
        inputSchema: jsonSchema(mountable.presentationSchema, {
          validate: async (value) =>
            isRecord(value)
              ? { success: true, value }
              : { success: false, error: new Error('Tool arguments must be an object') },
        }),
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

  for (const definition of config.runtimeTools ?? []) {
    if (!runtimeToolSupports(definition, 'AGENT')) continue;
    const mountable = runtimeToolMountable(definition);
    assertUniqueToolName(
      definition.name,
      Object.hasOwn(tools, definition.name),
      'agent tool name',
    );

    const inputSchema = jsonSchema(mountable.presentationSchema, {
      validate: async (value) =>
        isRecord(value)
          ? { success: true, value }
          : { success: false, error: new Error('Tool arguments must be an object') },
    });
    const execute = async (rawArgs: unknown) => {
      const args = isRecord(rawArgs) ? rawArgs : {};
      try {
        const result = await runTool(mountable, args);
        if (result.ok) return result.data;
        return formatToolError(result, mountable.name, config.errorHint);
      } catch (err) {
        return formatToolError(toolResultFromError(err), mountable.name, config.errorHint);
      }
    };

    if (definition.present?.agent) {
      const presenter = definition.present.agent;
      const output = definition.output;
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
      tools[definition.name] = tool({
        description: definition.description,
        inputSchema,
        ...(definition.output && { outputSchema: definition.output }),
        execute,
      });
    }
  }

  return tools;
}
