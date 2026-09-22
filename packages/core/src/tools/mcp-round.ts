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
import { z } from 'zod';
import {
  AppError,
  type EndpointMcpInputRequired,
  type EndpointMcpPolicy,
  type McpCallContext,
  type McpInputRequiredCall,
  type McpInputRequiredResolver,
  type McpReportProgress,
  type McpRoundOutcome,
} from '../contract';
import { argumentsDigest } from '../internal/stable-digest';
import { isRecord } from '../internal/typed';
import type { ToolResult } from './execute';
import { createMcpProgressReporter, mcpProgressToken } from './mcp-progress';
import {
  staticInputRounds,
  validateMcpRoundPolicy,
  validateResolvedInputRounds,
} from './mcp-round-policy';
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
  /**
   * Fingerprint of the question plan this conversation started with.
   *
   * `argumentsDigest` proves the ARGUMENTS did not change; it says nothing
   * about the questions, and those are now allowed to be computed. Between two
   * rounds there is a full round trip to the host, and a resolver that reads
   * anything outside its arguments — which is exactly the case this feature
   * exists for — can answer differently the second time. Every other check
   * would still pass: same principal, same operation, same digest, `round`
   * still in range. Round 2's question would be asked under round 1's key, the
   * answer would be accepted if the schemas happened to be compatible, and the
   * handler would receive an answer to a question nobody asked.
   *
   * So the plan is fingerprinted when it is minted and re-checked on every
   * round. A plan that moved is a refusal, not a different question.
   */
  planDigest: string;
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

/**
 * Fingerprint of a resolved question plan — what was asked, in what order.
 *
 * Over the key, the prompt and the accepted schema of every round, because all
 * three are what the user sees and answers. The schema goes in as its JSON
 * Schema projection: two Zod objects that accept the same thing are the same
 * question, and rebuilding an identical schema on a redeploy must not invalidate
 * a conversation that is mid-flight.
 */
function roundPlanDigest(requests: readonly EndpointMcpInputRequired[]): string {
  return argumentsDigest({
    plan: requests.map((request) => ({
      key: request.key,
      message: request.message,
      schema: z.toJSONSchema(request.schema, { io: 'input', unrepresentable: 'any' }),
    })),
  });
}

/**
 * The questions for this call — read off the declaration, or computed from it.
 *
 * A resolver needs the PARSED arguments, which only the contract pipeline can
 * produce. That pipeline already runs here for a declared policy: the guard
 * pass exists so authorisation happens before a user is asked anything. So the
 * parsed value is taken from the same pass, with a handler that captures
 * instead of returning nothing — no second parse, and the resolver sees exactly
 * what the handler would.
 *
 * The cost lands only on the dynamic path: a static declaration never reaches
 * here, and its call sequence is unchanged down to the audit rows it writes.
 */
async function resolveRequests(
  options: {
    tool: MountableTool;
    rawArgs: Record<string, unknown>;
    context: ServerContext;
    runtime?: McpRoundRuntime;
    runTool: ToolRunner;
    formatFailure: (result: ToolResult) => CallToolResult;
  },
  policy: EndpointMcpPolicy,
  round: number,
): Promise<
  { requests: readonly EndpointMcpInputRequired[] } | { failure: McpRoundResolution }
> {
  const declared = staticInputRounds(policy);
  if (declared) return { requests: declared };
  const { runTool } = options;

  let call: McpInputRequiredCall | undefined;
  const guarded = await runTool(
    {
      ...options.tool,
      method: {
        ...options.tool.method,
        outputSchema: undefined,
        handler: (context: { params: unknown; input: unknown }) => {
          call = { params: context.params, input: context.input };
          return undefined;
        },
      },
    },
    options.rawArgs,
    transportContext(options.context, options.tool.name, 'input_required', round),
  );
  if (!guarded.ok) {
    return { failure: { kind: 'response', response: options.formatFailure(guarded) } };
  }
  if (!call) throw new Error('[stitchkit] MRTR resolver never saw the parsed call');

  const resolver = policy.inputRequired as McpInputRequiredResolver;
  const resolved = await resolver(call);
  validateResolvedInputRounds(options.tool, resolved, options.runtime?.maxRounds ?? 1);
  return { requests: resolved };
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
  const state = options.context.mcpReq.requestState<McpRoundState>();
  const digest = argumentsDigest(options.rawArgs);

  // Identity and arguments are checked BEFORE the questions are resolved:
  // resolving runs consumer code, and running it for a continuation that does
  // not belong to this operation would be handing an unverified state a call
  // into the application. Round bounds wait for the list, because with a
  // resolver there is no list to bound against yet.
  if (state) {
    const mismatched =
      !sameIdentity(state.identity, operationIdentity(options.tool)) ||
      state.argumentsDigest !== digest ||
      !Number.isInteger(state.round) ||
      state.round < 0 ||
      state.round >= options.runtime.maxRounds ||
      !isRecord(state.accepted);
    if (mismatched) {
      return failedResolution({
        ...options,
        context: transportContext(
          options.context,
          options.tool.name,
          'invalid',
          Number.isInteger(state.round) ? state.round : 0,
        ),
        code: 'INVALID_REQUEST_STATE',
        message: 'Continuation state does not match this operation, arguments or round',
      });
    }
  }

  const resolution = await resolveRequests(options, policy, state?.round ?? 0);
  if ('failure' in resolution) return resolution.failure;
  const requests = resolution.requests;
  const planDigest = roundPlanDigest(requests);

  // An empty plan is a legitimate answer from a resolver: this call needs
  // nothing. A static declaration cannot reach here — an empty one is refused
  // at mount — so this is the dynamic case only.
  if (requests.length === 0 && !state) {
    return {
      kind: 'continue',
      context: transportContext(options.context, options.tool.name),
    };
  }

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
        planDigest,
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

  // Identity and arguments were checked above; what is left needs the resolved
  // plan. A moved plan is refused here rather than asked — see `planDigest`.
  if (state.planDigest !== planDigest || state.round >= requests.length) {
    return failedResolution({
      ...options,
      context: transportContext(options.context, options.tool.name, 'invalid', state.round),
      code: 'INVALID_REQUEST_STATE',
      message:
        state.round >= requests.length
          ? 'Continuation state does not match this operation, arguments or round'
          : 'The questions for this call changed between rounds',
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
        planDigest,
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
