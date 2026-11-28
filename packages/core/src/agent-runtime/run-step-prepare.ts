import {
  type AgentInstructions,
  type AgentModelMessage,
  normalizeAgentInstructions,
} from '../agent-parts/model';
import type { AgentToolSet } from '../tools/agent-tools';
import type {
  AgentModelFinishReason,
  AgentModelRequest,
  AgentModelToolSpec,
} from './models-driver';
import type { AgentPrepareStepResult, AgentStepResult } from './models-driver-step';
import type { RunExecution } from './run-execution-state';
import { mergeStepCallSettings } from './run-step-helpers';
import type { PreparedTurn } from './run-turn-preparation';
import {
  type AgentMessagePart,
  AgentMessageSchema,
  type AgentTerminalReason,
} from './schemas';
import { assistantStatus } from './terminal-status';

export type ContinuationOutcome =
  | { readonly action: 'stop' }
  | {
      readonly action: 'continue';
      readonly message: AgentModelMessage;
      readonly instructions?: AgentInstructions;
    };

export function buildStepRequest<TOOLS extends AgentToolSet>(input: {
  instructions: AgentInstructions;
  messages: readonly AgentModelMessage[];
  toolSpecs: readonly AgentModelToolSpec[];
  prepared: AgentPrepareStepResult<TOOLS> | undefined;
  conversationId: string;
  runId: string;
  attemptId: string;
  stepNumber: number;
}): AgentModelRequest {
  const { prepared } = input;
  return {
    instructions: normalizeAgentInstructions(input.instructions),
    messages: input.messages,
    tools: input.toolSpecs,
    ...(prepared?.toolChoice !== undefined && { toolChoice: prepared.toolChoice }),
    ...(prepared?.responseFormat !== undefined && { responseFormat: prepared.responseFormat }),
    ...(prepared?.cacheControl !== undefined && { cacheControl: prepared.cacheControl }),
    settings: mergeStepCallSettings(undefined, prepared),
    ...(prepared?.providerOptions !== undefined && {
      providerOptions: prepared.providerOptions,
    }),
    ...(prepared?.headers !== undefined && { headers: prepared.headers }),
    correlation: {
      conversationId: input.conversationId,
      runId: input.runId,
      attemptId: input.attemptId,
      step: input.stepNumber,
    },
  };
}

export async function evaluateStopPolicies<CONTEXT, TOOLS extends AgentToolSet>(
  execution: RunExecution<CONTEXT, TOOLS>,
  turn: PreparedTurn<CONTEXT, TOOLS>,
  steps: readonly AgentStepResult[],
): Promise<boolean> {
  const { config, maxSteps } = execution.dependencies;
  const { state } = execution;
  if (steps.length >= maxSteps) {
    state.terminalPolicyName ??= 'max-steps';
    return true;
  }
  for (const policy of config.loop?.stopPolicies ?? []) {
    if (await policy.when({ steps, ...turn.runtimeContext })) {
      state.terminalPolicyName ??= policy.name;
      return true;
    }
  }
  return false;
}

function hasPendingApproval(parts: readonly AgentMessagePart[]): boolean {
  const responded = new Set<string>();
  for (const part of parts) {
    if (part.type === 'tool-approval-response') responded.add(part.approvalId);
  }
  return parts.some(
    (part) => part.type === 'tool-approval-request' && !responded.has(part.approvalId),
  );
}

/** Evaluate `protocol.acceptTerminal` with bounded continuation support (B3). */
export async function evaluateTerminalContinuation<
  CONTEXT,
  TOOLS extends AgentToolSet,
>(input: {
  execution: RunExecution<CONTEXT, TOOLS>;
  lastFinishReason: AgentModelFinishReason;
  steps: readonly AgentStepResult[];
  continuations: number;
  maxContinuations: number;
  attemptSignal: AbortSignal;
}): Promise<ContinuationOutcome> {
  const {
    execution,
    lastFinishReason,
    steps,
    continuations,
    maxContinuations,
    attemptSignal,
  } = input;
  const { config, now, maxSteps } = execution.dependencies;
  const { state } = execution;
  const acceptTerminal = config.protocol.acceptTerminal;
  if (!acceptTerminal || attemptSignal.aborted || hasPendingApproval(state.parts)) {
    return { action: 'stop' };
  }
  const candidateReason: AgentTerminalReason =
    state.terminalPolicyName !== undefined
      ? 'policy_stop'
      : state.terminalReason !== 'success'
        ? state.terminalReason
        : lastFinishReason === 'stop'
          ? 'success'
          : lastFinishReason === 'error'
            ? 'provider_failure'
            : 'provider_stop';
  if (
    candidateReason !== 'success' &&
    candidateReason !== 'policy_stop' &&
    candidateReason !== 'provider_stop'
  ) {
    return { action: 'stop' };
  }
  const candidate = AgentMessageSchema.parse({
    ...state.assistant,
    status: assistantStatus(candidateReason),
    parts: state.parts,
    updatedAt: now().toISOString(),
  });
  const verdict = await acceptTerminal({
    message: candidate,
    reason: candidateReason,
    ...(state.terminalPolicyName && { policyName: state.terminalPolicyName }),
    steps,
    continuations,
  });
  if (verdict === true || (typeof verdict === 'object' && verdict.action === 'accept')) {
    state.terminalDecision = 'accepted';
    return { action: 'stop' };
  }
  if (verdict === false || (typeof verdict === 'object' && verdict.action === 'reject')) {
    state.terminalDecision = 'rejected';
    state.terminalReason = 'output_rejected';
    state.internalCause = new Error('Agent terminal output was rejected by the protocol');
    return { action: 'stop' };
  }
  if (continuations >= maxContinuations || steps.length >= maxSteps) {
    state.terminalDecision = 'rejected';
    state.terminalReason = 'output_rejected';
    state.internalCause = new Error(
      continuations >= maxContinuations
        ? `Agent terminal continuation exceeded maxContinuations (${maxContinuations})`
        : `Agent terminal continuation exceeded maxSteps (${maxSteps})`,
    );
    return { action: 'stop' };
  }
  state.terminalDecision = undefined;
  state.terminalPolicyName = undefined;
  return {
    action: 'continue',
    message: verdict.message,
    ...(verdict.instructions !== undefined && { instructions: verdict.instructions }),
  };
}
