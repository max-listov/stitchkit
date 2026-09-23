import {
  acceptedContent,
  type CallToolResult,
  type InputRequiredResult,
  inputRequired,
  inputResponse,
  type RequestStateCodec,
  type ServerContext,
} from '@modelcontextprotocol/server';
import { z } from 'zod';
import type { McpRoundOutcome } from '../../contract/runtime-context';
import type {
  EndpointMcpInputRequired,
  EndpointMcpPolicy,
  McpInputRequiredResolver,
} from '../../contract/tool-options';
import { argumentsDigest } from '../../internal/stable-digest';
import { isRecord } from '../../internal/typed';
import { parseToolCallArguments } from '../execute-args';
import type { ToolResult } from '../execute-result';
import type { MountableTool } from '../mount';
import {
  failedResolution,
  operationIdentity,
  type RoundOperationIdentity,
  runRoundSuccess,
  sameIdentity,
  type ToolRunner,
  transportContext,
} from './round-context';
import {
  staticInputRounds,
  validateMcpRoundPolicy,
  validateResolvedInputRounds,
} from './round-policy';

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

export type McpRoundResolution =
  | { kind: 'continue'; context?: Record<string, unknown> }
  | { kind: 'response'; response: CallToolResult | InputRequiredResult };

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
    coerceJsonArgs?: boolean;
  },
  policy: EndpointMcpPolicy,
): Promise<
  | { requests: readonly EndpointMcpInputRequired[]; guarded: boolean }
  | { failure: McpRoundResolution }
> {
  const declared = staticInputRounds(policy);
  if (declared) return { requests: declared, guarded: false };

  // The parsed value, without running the call again. Parsing is pure and is
  // the same function the call parses with, so the resolver cannot see a
  // different value than the handler will — and asking what the arguments mean
  // costs nothing a gate would charge for.
  const parsed = parseToolCallArguments(options.tool.method, options.rawArgs, {
    // Matches the mount default; a mount that turns coercion off turns it off
    // here too, because the resolver must see what the handler will see.
    coerceJson: options.coerceJsonArgs ?? true,
    // MCP is the tool surface: the view's input defaults are part of what the
    // handler will see, so the resolver sees them too.
    toolSurface: true,
  });
  if (!parsed.ok) {
    // A call whose arguments do not validate has no questions to ask; the
    // ordinary pipeline below reports the failure in its own words.
    return { requests: [], guarded: false };
  }
  const resolver = policy.inputRequired as McpInputRequiredResolver;
  const resolved = await resolver({ params: parsed.params, input: parsed.input });
  validateResolvedInputRounds(options.tool, resolved, options.runtime?.maxRounds ?? 1);
  return { requests: resolved, guarded: false };
}

/** Mint the continuation for one round and ask that round's question. */
async function askRound(
  runtime: McpRoundRuntime,
  context: ServerContext,
  request: EndpointMcpInputRequired,
  state: McpRoundState,
): Promise<McpRoundResolution> {
  const requestState = await runtime.codec.mint(state, context);
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

/** The accepted answer to this round's question, or why there is none. */
function readRoundAnswer(
  context: ServerContext,
  request: EndpointMcpInputRequired,
):
  | { content: Record<string, unknown> }
  | { refusal: { outcome: McpRoundOutcome; code: string; message: string } } {
  const view = inputResponse(context.mcpReq.inputResponses, request.key);
  if (view.kind !== 'elicit') {
    return {
      refusal: {
        outcome: 'invalid',
        code: 'INVALID_INPUT_RESPONSE',
        message: 'Expected an elicitation response for the current round',
      },
    };
  }
  if (view.action !== 'accept') {
    const declined = view.action === 'decline';
    return {
      refusal: {
        outcome: declined ? 'declined' : 'cancelled',
        code: declined ? 'INPUT_DECLINED' : 'INPUT_CANCELLED',
        message: declined ? 'Required input was declined' : 'Required input was cancelled',
      },
    };
  }
  const content = acceptedContent(context.mcpReq.inputResponses, request.key, request.schema);
  if (!content) {
    return {
      refusal: {
        outcome: 'invalid',
        code: 'INVALID_INPUT_RESPONSE',
        message: 'Accepted input failed its declared schema',
      },
    };
  }
  return { content };
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
  /** The mount's JSON-coercion setting, so the resolver parses as the call does. */
  coerceJsonArgs?: boolean;
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

  // The guard runs BEFORE the resolver, and that ordering is the reason a
  // dynamic policy costs one pipeline pass a static one does not. The resolver
  // is consumer code that may reach a network — a model catalog, a feature
  // flag — and running it for a caller the gate would refuse turns elicitation
  // into an unauthenticated trigger. So authorisation first, questions second.
  // The pass is reused by the round below rather than repeated.
  const dynamic = staticInputRounds(policy) === undefined;
  if (dynamic) {
    const guarded = await runRoundSuccess(
      options.tool,
      options.rawArgs,
      options.runTool,
      transportContext(
        options.context,
        options.tool.name,
        'input_required',
        state?.round ?? 0,
      ),
    );
    if (!guarded.ok) return { kind: 'response', response: options.formatFailure(guarded) };
  }

  const resolution = await resolveRequests(options, policy);
  if ('failure' in resolution) return resolution.failure;
  const requests = resolution.requests;
  const alreadyGuarded = dynamic;
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
    if (!alreadyGuarded) {
      const guarded = await runRoundSuccess(
        options.tool,
        options.rawArgs,
        options.runTool,
        transportContext(options.context, options.tool.name, 'input_required', 0),
      );
      if (!guarded.ok) {
        return { kind: 'response', response: options.formatFailure(guarded) };
      }
    }
    const request = requests[0];
    if (!request) throw new Error('[stitchkit] validated MRTR policy has no first round');
    return askRound(options.runtime, options.context, request, {
      identity: operationIdentity(options.tool),
      argumentsDigest: digest,
      round: 0,
      accepted: {},
      planDigest,
    });
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
  const answer = readRoundAnswer(options.context, request);
  if ('refusal' in answer) {
    return failedResolution({
      ...options,
      context: transportContext(
        options.context,
        options.tool.name,
        answer.refusal.outcome,
        state.round,
      ),
      code: answer.refusal.code,
      message: answer.refusal.message,
    });
  }
  const { content } = answer;

  const accepted = { ...state.accepted, [request.key]: content };
  const nextRound = state.round + 1;
  const nextRequest = requests[nextRound];
  if (nextRequest) {
    if (!alreadyGuarded) {
      const guarded = await runRoundSuccess(
        options.tool,
        options.rawArgs,
        options.runTool,
        transportContext(options.context, options.tool.name, 'input_required', nextRound),
      );
      if (!guarded.ok) {
        return { kind: 'response', response: options.formatFailure(guarded) };
      }
    }
    return askRound(options.runtime, options.context, nextRequest, {
      identity: state.identity,
      argumentsDigest: state.argumentsDigest,
      round: nextRound,
      accepted,
      planDigest,
    });
  }

  return {
    kind: 'continue',
    context: {
      ...transportContext(options.context, options.tool.name, 'complete', state.round),
      mcpInput: accepted,
    },
  };
}
