/**
 * The per-round pieces of an MCP input round: the transport context a round
 * runs under, the operation identity a continuation is bound to, and the two
 * shapes a round pass takes through the tool pipeline — a guard pass that
 * returns nothing, and a refusal that reports through the pipeline's own
 * failure path.
 */
import {
  type CallToolResult,
  CLIENT_INFO_META_KEY,
  PROTOCOL_VERSION_META_KEY,
  type ServerContext,
} from '@modelcontextprotocol/server';
import { AppError } from '../../contract/errors';
import type {
  McpCallContext,
  McpReportProgress,
  McpRoundOutcome,
} from '../../contract/runtime-context';
import { isRecord } from '../../internal/typed';
import type { ToolResult } from '../execute-result';
import type { MountableTool } from '../mount';
import { createMcpProgressReporter, mcpProgressToken } from './progress';
import type { McpRoundResolution } from './round';

export interface RoundOperationIdentity {
  toolName: string;
  serviceName: string;
  action: string;
  method: string;
  scope?: string;
}

export type ToolRunner = (
  tool: MountableTool,
  rawArgs: Record<string, unknown>,
  context?: Record<string, unknown>,
) => Promise<ToolResult>;

export function transportContext(
  context: ServerContext,
  toolName: string,
  outcome?: McpRoundOutcome,
  round?: number,
): { signal: AbortSignal; mcp: McpCallContext; reportProgress: McpReportProgress } {
  const protocolVersionValue = isRecord(context.mcpReq.envelope)
    ? Reflect.get(context.mcpReq.envelope, PROTOCOL_VERSION_META_KEY)
    : undefined;
  const protocolVersion =
    typeof protocolVersionValue === 'string' ? protocolVersionValue : undefined;
  const clientInfoValue = isRecord(context.mcpReq.envelope)
    ? Reflect.get(context.mcpReq.envelope, CLIENT_INFO_META_KEY)
    : undefined;
  const clientInfo =
    isRecord(clientInfoValue) &&
    typeof clientInfoValue.name === 'string' &&
    typeof clientInfoValue.version === 'string'
      ? { name: clientInfoValue.name, version: clientInfoValue.version }
      : undefined;
  const token = mcpProgressToken(context);
  return {
    signal: context.mcpReq.signal,
    mcp: {
      era: context.mcpReq.envelope ? 'modern' : 'legacy',
      method: context.mcpReq.method,
      toolName,
      ...(protocolVersion !== undefined && { protocolVersion }),
      ...(clientInfo !== undefined && { clientInfo }),
      ...(outcome !== undefined && { outcome }),
      ...(round !== undefined && { round }),
      ...(token !== undefined && { progressToken: token }),
    },
    reportProgress: createMcpProgressReporter(context),
  };
}

export function operationIdentity(tool: MountableTool): RoundOperationIdentity {
  return {
    toolName: tool.name,
    serviceName: tool.method.serviceName,
    action: tool.method.key,
    method: tool.method.method,
    ...(tool.method.scope !== undefined && { scope: tool.method.scope }),
  };
}

export function sameIdentity(
  left: RoundOperationIdentity,
  right: RoundOperationIdentity,
): boolean {
  return (
    left.toolName === right.toolName &&
    left.serviceName === right.serviceName &&
    left.action === right.action &&
    left.method === right.method &&
    left.scope === right.scope
  );
}

export async function runRoundSuccess(
  tool: MountableTool,
  rawArgs: Record<string, unknown>,
  runTool: ToolRunner,
  context: Record<string, unknown>,
): Promise<ToolResult> {
  return runTool(
    {
      ...tool,
      method: {
        ...tool.method,
        outputSchema: undefined,
        handler: () => undefined,
      },
    },
    rawArgs,
    context,
  );
}

async function runRoundFailure(
  tool: MountableTool,
  rawArgs: Record<string, unknown>,
  runTool: ToolRunner,
  context: Record<string, unknown>,
  code: string,
  message: string,
): Promise<ToolResult> {
  return runTool(
    {
      ...tool,
      method: {
        ...tool.method,
        outputSchema: undefined,
        handler: () => {
          throw new AppError(code, message, 400);
        },
      },
    },
    rawArgs,
    context,
  );
}

export async function failedResolution(options: {
  tool: MountableTool;
  rawArgs: Record<string, unknown>;
  runTool: ToolRunner;
  context: Record<string, unknown>;
  code: string;
  message: string;
  formatFailure: (result: ToolResult) => CallToolResult;
}): Promise<McpRoundResolution> {
  const result = await runRoundFailure(
    options.tool,
    options.rawArgs,
    options.runTool,
    options.context,
    options.code,
    options.message,
  );
  return { kind: 'response', response: options.formatFailure(result) };
}
