import type { ToolSet } from 'ai';
import { tool, zodSchema } from 'ai';
import { normalizeError } from '../internal/errors';
import type { ServiceDef } from '../server/types';
import type { ToolCallHooks, ToolResult } from './execute';
import { collectTools, createToolRunner, formatToolError, type ToolExtend } from './mount';

function formatAgentResult(result: ToolResult): unknown {
  return result.ok ? result.data : formatToolError(result);
}

export interface AgentContext {
  [key: string]: unknown;
}

export interface AgentMountConfig {
  context?: AgentContext;
  hooks?: ToolCallHooks;
  extend?: ToolExtend;
}

export function mountAgent(service: ServiceDef, config: AgentMountConfig = {}): ToolSet {
  const tools: ToolSet = {};
  const runTool = createToolRunner({
    source: 'agent',
    extend: config.extend,
    context: config.context,
    hooks: config.hooks,
  });

  for (const mountable of collectTools(service, 'AGENT', config.extend)) {
    tools[mountable.name] = tool({
      description: mountable.method.desc,
      inputSchema: zodSchema(mountable.schema),
      execute: async (rawArgs: Record<string, unknown>) => {
        try {
          const result = await runTool(mountable, rawArgs);
          return formatAgentResult(result);
        } catch (err) {
          const appErr = normalizeError(err);
          return { error: appErr.code, details: appErr.details };
        }
      },
    });
  }

  return tools;
}
