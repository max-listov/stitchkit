import type { TextStreamPart, ToolSet } from 'ai';
import { isAgentToolError } from '../tools/agent-tool-error';
import { isToolExecutionControlError } from '../tools/execute';
import type { AgentResolvedModel } from './models';
import {
  billedUsage,
  checkpoint,
  type RunExecution,
  transientSequence,
  updateReasoning,
} from './run-execution-state';
import { failureThisRuntimeOwns } from './run-failure';
import type { RunProviderLedger } from './run-provider-ledger';
import {
  addUsage,
  appendText,
  jsonValue,
  mergeModelTotals,
  normalizeSdkUsage,
  providerEnvelope,
} from './runtime-internals';
import { AgentMessagePartSchema } from './schemas';

/** What one stream part needs beyond the run: the model and the attempt it belongs to. */
export interface StreamPartScope {
  selectedModel: AgentResolvedModel;
  ledger: RunProviderLedger;
  providerAttempt: number;
}

/**
 * The fields every transient event of this run leads with, in the order the
 * events have always carried them. Taking one advances the sequence.
 */
function transientHead<CONTEXT, TOOLS extends ToolSet>(
  execution: RunExecution<CONTEXT, TOOLS>,
) {
  const { state } = execution;
  return {
    conversationId: state.run.conversationId,
    runId: state.run.id,
    runtimeEpoch: execution.dependencies.runtimeEpoch,
    sequence: transientSequence(state),
  };
}

/** A part that is the provider producing output, as opposed to framing it. */
export function isOutputPart<TOOLS extends ToolSet>(part: TextStreamPart<TOOLS>): boolean {
  return (
    (part.type === 'text-delta' && part.text.length > 0) ||
    (part.type === 'reasoning-delta' && part.text.length > 0) ||
    (part.type === 'tool-input-delta' && part.delta.length > 0) ||
    part.type === 'tool-call'
  );
}

/** Parts after which the durable draft is checkpointed regardless of the event count. */
export const STRUCTURAL_BOUNDARY_PARTS: readonly string[] = [
  'tool-call',
  'tool-result',
  'tool-error',
  'tool-output-denied',
  'tool-approval-request',
  'tool-approval-response',
  'finish-step',
];

async function applyTextPart<CONTEXT, TOOLS extends ToolSet>(
  execution: RunExecution<CONTEXT, TOOLS>,
  part: TextStreamPart<TOOLS>,
): Promise<void> {
  const { publish, now } = execution.dependencies;
  const { state } = execution;
  if (part.type === 'text-delta') {
    appendText(state.parts, part.text);
    await publish({
      type: 'assistant-delta',
      ...transientHead(execution),
      textDelta: part.text,
      emittedAt: now().toISOString(),
    });
  } else if (part.type === 'reasoning-start') {
    state.reasoningPartIndex = undefined;
    updateReasoning(state, '', part.providerMetadata);
    const provider = providerEnvelope(part.providerMetadata);
    await publish({
      type: 'reasoning-start',
      ...transientHead(execution),
      ...(provider && { provider }),
      emittedAt: now().toISOString(),
    });
  } else if (part.type === 'reasoning-delta') {
    updateReasoning(state, part.text, part.providerMetadata);
    const provider = providerEnvelope(part.providerMetadata);
    await publish({
      type: 'reasoning-delta',
      ...transientHead(execution),
      textDelta: part.text,
      ...(provider && { provider }),
      emittedAt: now().toISOString(),
    });
  } else if (part.type === 'reasoning-end') {
    updateReasoning(state, '', part.providerMetadata);
    state.reasoningPartIndex = undefined;
    const provider = providerEnvelope(part.providerMetadata);
    await publish({
      type: 'reasoning-end',
      ...transientHead(execution),
      ...(provider && { provider }),
      emittedAt: now().toISOString(),
    });
  }
}

async function applyToolPart<CONTEXT, TOOLS extends ToolSet>(
  execution: RunExecution<CONTEXT, TOOLS>,
  part: TextStreamPart<TOOLS>,
): Promise<void> {
  const { publish, now } = execution.dependencies;
  const { state } = execution;
  if (part.type === 'tool-call') {
    const provider = providerEnvelope(part.providerMetadata);
    state.parts.push(
      AgentMessagePartSchema.parse({
        type: 'tool-call',
        callId: part.toolCallId,
        toolName: part.toolName,
        input: jsonValue(part.input),
        ...(provider && { provider }),
      }),
    );
    await publish({
      type: 'tool-status',
      ...transientHead(execution),
      callId: part.toolCallId,
      toolName: part.toolName,
      status: 'started',
      input: jsonValue(part.input),
      emittedAt: now().toISOString(),
    });
  } else if (part.type === 'tool-result') {
    state.parts.push(
      AgentMessagePartSchema.parse({
        type: 'tool-result',
        callId: part.toolCallId,
        toolName: part.toolName,
        outcome: 'success',
        output: jsonValue(part.output),
      }),
    );
    await publish({
      type: 'tool-status',
      ...transientHead(execution),
      callId: part.toolCallId,
      toolName: part.toolName,
      status: 'completed',
      output: jsonValue(part.output),
      emittedAt: now().toISOString(),
    });
  } else if (part.type === 'tool-error') {
    state.internalCause = part.error;
    if (isToolExecutionControlError(part.error)) {
      await publish({
        type: 'tool-status',
        ...transientHead(execution),
        callId: part.toolCallId,
        toolName: part.toolName,
        status: 'interrupted',
        emittedAt: now().toISOString(),
      });
      await checkpoint(execution);
      throw part.error;
    }
    const output = isAgentToolError(part.error)
      ? jsonValue(part.error.output)
      : { message: 'Tool execution failed' };
    state.parts.push(
      AgentMessagePartSchema.parse({
        type: 'tool-result',
        callId: part.toolCallId,
        toolName: part.toolName,
        outcome: 'error',
        output,
      }),
    );
    await publish({
      type: 'tool-status',
      ...transientHead(execution),
      callId: part.toolCallId,
      toolName: part.toolName,
      status: 'failed',
      output,
      emittedAt: now().toISOString(),
    });
  } else if (part.type === 'tool-output-denied') {
    state.parts.push(
      AgentMessagePartSchema.parse({
        type: 'tool-result',
        callId: part.toolCallId,
        toolName: part.toolName,
        outcome: 'error',
        output: { message: 'Tool output denied' },
      }),
    );
    await publish({
      type: 'tool-status',
      ...transientHead(execution),
      callId: part.toolCallId,
      toolName: part.toolName,
      status: 'failed',
      output: { message: 'Tool output denied' },
      emittedAt: now().toISOString(),
    });
  }
}

/** Parts that only add to the durable message: nothing is published for them. */
async function applyRecordedPart<CONTEXT, TOOLS extends ToolSet>(
  execution: RunExecution<CONTEXT, TOOLS>,
  part: TextStreamPart<TOOLS>,
): Promise<void> {
  const { config } = execution.dependencies;
  const { parts } = execution.state;
  if (part.type === 'source') {
    parts.push(
      AgentMessagePartSchema.parse({
        type: 'source',
        sourceId: part.id,
        ...(part.sourceType === 'url' && { url: part.url }),
        ...(part.title && { title: part.title }),
      }),
    );
  } else if (part.type === 'file' && config.persistGeneratedFile) {
    const persisted = await config.persistGeneratedFile(part.file);
    parts.push(
      AgentMessagePartSchema.parse({
        type: 'file',
        mediaType: part.file.mediaType,
        reference: persisted.reference,
        ...(persisted.filename && { filename: persisted.filename }),
      }),
    );
  } else if (part.type === 'file') {
    throw new Error('persistGeneratedFile is required for generated file output');
  } else if (part.type === 'reasoning-file' && config.persistGeneratedFile) {
    const persisted = await config.persistGeneratedFile(part.file);
    parts.push(
      AgentMessagePartSchema.parse({
        type: 'file',
        mediaType: part.file.mediaType,
        reference: persisted.reference,
        ...(persisted.filename && { filename: persisted.filename }),
      }),
    );
  } else if (part.type === 'reasoning-file') {
    throw new Error('persistGeneratedFile is required for generated reasoning files');
  } else if (part.type === 'tool-approval-request') {
    parts.push(
      AgentMessagePartSchema.parse({
        type: 'tool-approval-request',
        approvalId: part.approvalId,
        callId: part.toolCall.toolCallId,
        ...(part.isAutomatic !== undefined && { isAutomatic: part.isAutomatic }),
        ...(part.signature && { signature: part.signature }),
      }),
    );
  } else if (part.type === 'tool-approval-response') {
    parts.push(
      AgentMessagePartSchema.parse({
        type: 'tool-approval-response',
        approvalId: part.approvalId,
        approved: part.approved,
        ...(part.reason && { reason: part.reason }),
      }),
    );
  } else if (part.type === 'custom') {
    const provider = providerEnvelope(part.providerMetadata);
    parts.push(
      AgentMessagePartSchema.parse({
        type: 'provider',
        envelope: {
          schemaVersion: 1,
          provider: 'ai-sdk-custom',
          data: { kind: part.kind, ...(provider && { provider: provider.data }) },
        },
      }),
    );
  } else if (part.type === 'raw') {
    parts.push(
      AgentMessagePartSchema.parse({
        type: 'provider',
        envelope: {
          schemaVersion: 1,
          provider: 'ai-sdk-raw',
          data: { value: jsonValue(part.rawValue) },
        },
      }),
    );
  }
}

async function applyFinishStep<CONTEXT, TOOLS extends ToolSet>(
  execution: RunExecution<CONTEXT, TOOLS>,
  scope: StreamPartScope,
  part: TextStreamPart<TOOLS>,
): Promise<void> {
  if (part.type !== 'finish-step') return;
  const { config, generateId, now } = execution.dependencies;
  const { state, trace } = execution;
  const response = await scope.ledger.recordResponse({
    id: part.response.id,
    providerMetadata: part.providerMetadata,
    stepNumber: state.step,
    attempt: scope.providerAttempt,
  });
  await execution.operationLifecycle.finish(
    part.finishReason === 'error' ? 'failed' : 'completed',
  );
  const stepTrace = trace ? config.observe?.rootTrace(trace) : undefined;
  const stepUsage =
    scope.selectedModel.normalizeUsage?.({
      usage: part.usage,
      providerMetadata: part.providerMetadata,
    }) ?? normalizeSdkUsage(part.usage);
  state.lastPromptTokens = stepUsage.inputTokens;
  state.modelUsage = addUsage(state.modelUsage, stepUsage);
  state.usage = state.nonModelUsage
    ? addUsage(state.nonModelUsage, billedUsage(state) ?? state.modelUsage)
    : billedUsage(state);
  config.observe?.emit({
    schemaVersion: 1,
    eventId: generateId(),
    type: 'step-finished',
    conversationId: state.run.conversationId,
    runId: state.run.id,
    traceId: stepTrace?.traceId ?? trace?.traceId ?? generateId(),
    spanId: stepTrace?.spanId ?? generateId(),
    ...(stepTrace?.parentSpanId && { parentSpanId: stepTrace.parentSpanId }),
    state: state.run.state,
    modelId: scope.selectedModel.descriptor.modelId,
    step: state.step,
    usage: stepUsage,
    response,
    emittedAt: now().toISOString(),
  });
  state.step += 1;
}

/** Record one stream part in the draft, and publish what subscribers see of it. */
export async function applyStreamPart<CONTEXT, TOOLS extends ToolSet>(
  execution: RunExecution<CONTEXT, TOOLS>,
  scope: StreamPartScope,
  part: TextStreamPart<TOOLS>,
): Promise<void> {
  const { state } = execution;
  switch (part.type) {
    case 'text-delta':
    case 'reasoning-start':
    case 'reasoning-delta':
    case 'reasoning-end':
      await applyTextPart(execution, part);
      break;
    case 'tool-call':
    case 'tool-result':
    case 'tool-error':
    case 'tool-output-denied':
      await applyToolPart(execution, part);
      break;
    case 'source':
    case 'file':
    case 'reasoning-file':
    case 'tool-approval-request':
    case 'tool-approval-response':
    case 'custom':
    case 'raw':
      await applyRecordedPart(execution, part);
      break;
    case 'abort':
      state.terminalReason = 'interrupted';
      break;
    case 'error':
      // AI SDK projects exceptions raised around the call into the stream
      // as an error part, so this branch carries both the provider's
      // failures and some of this runtime's own. Each failure the runtime
      // can identify as its own is named as its own; anything it cannot
      // identify stays the provider's, which is what an error part
      // overwhelmingly is.
      state.terminalReason = failureThisRuntimeOwns(part.error) ?? 'provider_failure';
      state.internalCause = part.error;
      break;
    case 'finish-step':
      await applyFinishStep(execution, scope, part);
      break;
    case 'finish':
      if (part.finishReason !== 'stop') {
        // A provider that errors mid-stream still delivers a `finish`, and
        // this branch used to overwrite the `provider_failure` the `error`
        // part had just set — reporting a stop policy that does not exist,
        // with no `policyName`, for a provider outage. A reason an earlier
        // part already decided describes the same event and wins.
        if (state.terminalReason === 'success') {
          state.terminalReason =
            part.finishReason === 'error' ? 'provider_failure' : 'provider_stop';
          // Which cap it hit — `length`, `content-filter`, `other` — is the
          // provider's word and belongs in the operator-only cause, not in a
          // terminal reason the core would have to grow a member for each of.
          state.internalCause ??= { finishReason: part.finishReason };
        }
      }
      state.sawProviderFinish = true;
      // This line used to graft the LAST STEP's cost onto every step's
      // tokens — a successful three-step run reported a third of the money
      // beside all of the tokens, and called it `provider-reported`.
      state.modelUsage = mergeModelTotals(
        normalizeSdkUsage(part.totalUsage),
        state.modelUsage,
      );
      state.usage = state.nonModelUsage
        ? addUsage(state.nonModelUsage, billedUsage(state) ?? state.modelUsage)
        : billedUsage(state);
      break;
  }
}
