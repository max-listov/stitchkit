import {
  acceptedContent,
  type CallToolResult,
  CLIENT_INFO_META_KEY,
  type InputRequiredResult,
  inputRequired,
  inputResponse,
  PROTOCOL_VERSION_META_KEY,
  type RequestStateCodec,
  type ServerContext,
} from '@modelcontextprotocol/server';
import {
  AppError,
  type EndpointMcpPolicy,
  type McpCallContext,
  type McpRoundOutcome,
} from '../contract';
import { isRecord } from '../internal/typed';
import type { ToolResult } from './execute';
import type { MountableTool } from './mount';

interface RoundOperationIdentity {
  toolName: string;
  serviceName: string;
  action: string;
  method: string;
  scope?: string;
}

/** Signed continuation payload. It is authenticated, not encrypted. */
export interface McpRoundState {
  identity: RoundOperationIdentity;
  argumentsDigest: string;
  round: number;
  accepted: Record<string, unknown>;
}

export interface McpRoundRuntime {
  codec: RequestStateCodec<McpRoundState>;
  maxRounds: number;
}

type ToolRunner = (
  tool: MountableTool,
  rawArgs: Record<string, unknown>,
  context?: Record<string, unknown>,
) => Promise<ToolResult>;

export type McpRoundResolution =
  | { kind: 'continue'; context?: Record<string, unknown> }
  | { kind: 'response'; response: CallToolResult | InputRequiredResult };

function transportContext(
  context: ServerContext,
  toolName: string,
  outcome?: McpRoundOutcome,
  round?: number,
): { signal: AbortSignal; mcp: McpCallContext } {
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
    },
  };
}

function stableValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(stableValue);
  if (value === null || typeof value !== 'object') return value;
  const result: Record<string, unknown> = {};
  for (const key of Object.keys(value).sort()) {
    result[key] = stableValue(Reflect.get(value, key));
  }
  return result;
}

async function argumentsDigest(args: Record<string, unknown>): Promise<string> {
  const bytes = new TextEncoder().encode(JSON.stringify(stableValue(args)));
  const digest = new Uint8Array(await crypto.subtle.digest('SHA-256', bytes));
  let binary = '';
  for (const byte of digest) binary += String.fromCodePoint(byte);
  return btoa(binary).replaceAll('+', '-').replaceAll('/', '_').replace(/=+$/, '');
}

function operationIdentity(tool: MountableTool): RoundOperationIdentity {
  return {
    toolName: tool.name,
    serviceName: tool.method.serviceName,
    action: tool.method.key,
    method: tool.method.method,
    ...(tool.method.scope !== undefined && { scope: tool.method.scope }),
  };
}

function sameIdentity(left: RoundOperationIdentity, right: RoundOperationIdentity): boolean {
  return (
    left.toolName === right.toolName &&
    left.serviceName === right.serviceName &&
    left.action === right.action &&
    left.method === right.method &&
    left.scope === right.scope
  );
}

async function runRoundSuccess(
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

export function validateMcpRoundPolicy(
  tool: MountableTool,
  policy: EndpointMcpPolicy,
  runtime?: { stateConfigured: boolean; maxRounds: number },
): void {
  if (!runtime?.stateConfigured) {
    throw new Error(
      `[stitchkit] MCP tool "${tool.name}" declares inputRequired but no multiRound.state key is configured`,
    );
  }
  const { maxRounds } = runtime;
  if (!Number.isInteger(maxRounds) || maxRounds < 1) {
    throw new Error('[stitchkit] multiRound.serving.maxRounds must be a positive integer');
  }
  if (policy.inputRequired.length === 0) {
    throw new Error(
      `[stitchkit] MCP tool "${tool.name}" must declare at least one input round`,
    );
  }
  if (policy.inputRequired.length > maxRounds) {
    throw new Error(
      `[stitchkit] MCP tool "${tool.name}" declares ${policy.inputRequired.length} input rounds, exceeding maxRounds ${maxRounds}`,
    );
  }
  const keys = new Set<string>();
  for (const request of policy.inputRequired) {
    if (keys.has(request.key)) {
      throw new Error(
        `[stitchkit] MCP tool "${tool.name}" declares duplicate input key "${request.key}"`,
      );
    }
    keys.add(request.key);
  }
}

async function failedResolution(options: {
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

/** Resolve an ordered opt-in MRTR sequence before the canonical handler executes. */
export async function resolveMcpRound(options: {
  tool: MountableTool;
  rawArgs: Record<string, unknown>;
  context: ServerContext;
  policy?: EndpointMcpPolicy;
  runtime?: McpRoundRuntime;
  runTool: ToolRunner;
  formatFailure: (result: ToolResult) => CallToolResult;
}): Promise<McpRoundResolution> {
  const { policy } = options;
  if (!policy) {
    return {
      kind: 'continue',
      context: transportContext(options.context, options.tool.name),
    };
  }
  if (!options.runtime) {
    throw new Error(
      `[stitchkit] MCP tool "${options.tool.name}" declares inputRequired but no multiRound.state key is configured`,
    );
  }

  validateMcpRoundPolicy(options.tool, policy, {
    stateConfigured: true,
    maxRounds: options.runtime.maxRounds,
  });
  const requests = policy.inputRequired;
  const state = options.context.mcpReq.requestState<McpRoundState>();
  const digest = await argumentsDigest(options.rawArgs);

  if (!state) {
    if (isRecord(options.context.mcpReq.inputResponses)) {
      return failedResolution({
        ...options,
        context: transportContext(options.context, options.tool.name, 'invalid', 0),
        code: 'INVALID_REQUEST_STATE',
        message: 'Input responses require a valid continuation state',
      });
    }
    const guarded = await runRoundSuccess(
      options.tool,
      options.rawArgs,
      options.runTool,
      transportContext(options.context, options.tool.name, 'input_required', 0),
    );
    if (!guarded.ok) {
      return { kind: 'response', response: options.formatFailure(guarded) };
    }
    const request = requests[0];
    if (!request) throw new Error('[stitchkit] validated MRTR policy has no first round');
    const requestState = await options.runtime.codec.mint(
      {
        identity: operationIdentity(options.tool),
        argumentsDigest: digest,
        round: 0,
        accepted: {},
      },
      options.context,
    );
    return {
      kind: 'response',
      response: inputRequired({
        inputRequests: {
          [request.key]: inputRequired.elicit({
            message: request.message,
            requestedSchema: request.schema,
          }),
        },
        requestState,
      }),
    };
  }

  const invalidState =
    !sameIdentity(state.identity, operationIdentity(options.tool)) ||
    state.argumentsDigest !== digest ||
    !Number.isInteger(state.round) ||
    state.round < 0 ||
    state.round >= requests.length ||
    state.round >= options.runtime.maxRounds ||
    !isRecord(state.accepted);
  if (invalidState) {
    return failedResolution({
      ...options,
      context: transportContext(options.context, options.tool.name, 'invalid', state.round),
      code: 'INVALID_REQUEST_STATE',
      message: 'Continuation state does not match this operation, arguments or round',
    });
  }

  const request = requests[state.round];
  if (!request) throw new Error('[stitchkit] validated MRTR state points outside its policy');
  const view = inputResponse(options.context.mcpReq.inputResponses, request.key);
  if (view.kind !== 'elicit') {
    return failedResolution({
      ...options,
      context: transportContext(options.context, options.tool.name, 'invalid', state.round),
      code: 'INVALID_INPUT_RESPONSE',
      message: 'Expected an elicitation response for the current round',
    });
  }
  if (view.action !== 'accept') {
    const outcome = view.action === 'decline' ? 'declined' : 'cancelled';
    return failedResolution({
      ...options,
      context: transportContext(options.context, options.tool.name, outcome, state.round),
      code: view.action === 'decline' ? 'INPUT_DECLINED' : 'INPUT_CANCELLED',
      message:
        view.action === 'decline'
          ? 'Required input was declined'
          : 'Required input was cancelled',
    });
  }

  const content = acceptedContent(
    options.context.mcpReq.inputResponses,
    request.key,
    request.schema,
  );
  if (!content) {
    return failedResolution({
      ...options,
      context: transportContext(options.context, options.tool.name, 'invalid', state.round),
      code: 'INVALID_INPUT_RESPONSE',
      message: 'Accepted input failed its declared schema',
    });
  }

  const accepted = { ...state.accepted, [request.key]: content };
  const nextRound = state.round + 1;
  const nextRequest = requests[nextRound];
  if (nextRequest) {
    const guarded = await runRoundSuccess(
      options.tool,
      options.rawArgs,
      options.runTool,
      transportContext(options.context, options.tool.name, 'input_required', nextRound),
    );
    if (!guarded.ok) {
      return { kind: 'response', response: options.formatFailure(guarded) };
    }
    const requestState = await options.runtime.codec.mint(
      {
        identity: state.identity,
        argumentsDigest: state.argumentsDigest,
        round: nextRound,
        accepted,
      },
      options.context,
    );
    return {
      kind: 'response',
      response: inputRequired({
        inputRequests: {
          [nextRequest.key]: inputRequired.elicit({
            message: nextRequest.message,
            requestedSchema: nextRequest.schema,
          }),
        },
        requestState,
      }),
    };
  }

  return {
    kind: 'continue',
    context: {
      ...transportContext(options.context, options.tool.name, 'complete', state.round),
      mcpInput: accepted,
    },
  };
}
