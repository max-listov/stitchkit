import type { AgentToolSet } from '../tools/agent-tools';
import type { AgentStepToolCall } from './models-driver-step';
import { normalizePersistedToolInput, signToolApproval } from './run-approval';
import type { RunExecution } from './run-execution-state';
import type { AgentLoopEvent } from './run-loop-events';
import type { CallSlotResult, StepExecutionCollector } from './run-tool-call';

export interface ApprovalRecordInput<CONTEXT, TOOLS extends AgentToolSet> {
  readonly execution: RunExecution<CONTEXT, TOOLS>;
  readonly callId: string;
  readonly toolName: string;
  readonly parsedInput: unknown;
  readonly callRecord: AgentStepToolCall;
  readonly reason?: string;
  readonly emit: (event: AgentLoopEvent) => Promise<void>;
  readonly callSlot: CallSlotResult;
}

/** Record an unresolved user-approval request with an HMAC over the exact persisted JSON input. */
export async function recordUserApprovalRequest<CONTEXT, TOOLS extends AgentToolSet>(
  input: ApprovalRecordInput<CONTEXT, TOOLS>,
): Promise<void> {
  const { execution, callId, toolName, parsedInput, callRecord, reason, emit, callSlot } =
    input;
  const { config, generateId } = execution.dependencies;
  const approvalId = generateId();
  const secret = config.loop?.toolApprovalSecret;
  const signature =
    secret !== undefined
      ? await signToolApproval({
          secret,
          approvalId,
          toolCallId: callId,
          toolName,
          toolInput: normalizePersistedToolInput(parsedInput),
        })
      : undefined;
  await emit({
    type: 'tool-approval-request',
    approvalId,
    toolCall: callRecord,
    ...(signature !== undefined && { signature }),
    ...(reason !== undefined && { reason }),
  });
  callSlot.assistantParts.push({
    type: 'tool-approval-request',
    approvalId,
    toolCallId: callId,
    ...(signature !== undefined && { signature }),
    ...(reason !== undefined && { reason }),
  });
  callSlot.stepContent.push({
    type: 'tool-approval-request',
    approvalId,
    toolCall: callRecord,
    ...(signature !== undefined && { signature }),
    ...(reason !== undefined && { reason }),
  });
}

/** Record a policy-driven automatic denial and settle the call without executing the tool. */
export async function recordAutomaticDenial<CONTEXT, TOOLS extends AgentToolSet>(
  input: ApprovalRecordInput<CONTEXT, TOOLS> & { readonly collector: StepExecutionCollector },
): Promise<void> {
  const {
    execution,
    callId,
    toolName,
    parsedInput,
    callRecord,
    reason,
    emit,
    callSlot,
    collector,
  } = input;
  const approvalId = execution.dependencies.generateId();
  await emit({
    type: 'tool-approval-request',
    approvalId,
    toolCall: callRecord,
    isAutomatic: true,
  });
  await emit({
    type: 'tool-approval-response',
    approvalId,
    approved: false,
    ...(reason !== undefined && { reason }),
  });
  await emit({
    type: 'tool-output-denied',
    toolCallId: callId,
    toolName,
    input: parsedInput,
    ...(reason !== undefined && { reason }),
  });
  callSlot.assistantParts.push({
    type: 'tool-approval-request',
    approvalId,
    toolCallId: callId,
    isAutomatic: true,
  });
  callSlot.toolParts.push(
    {
      type: 'tool-approval-response',
      approvalId,
      approved: false,
      ...(reason !== undefined && { reason }),
    },
    {
      type: 'tool-result',
      toolCallId: callId,
      toolName,
      output: { type: 'execution-denied', ...(reason !== undefined && { reason }) },
    },
  );
  callSlot.stepContent.push(
    { type: 'tool-approval-request', approvalId, toolCall: callRecord, isAutomatic: true },
    {
      type: 'tool-approval-response',
      approvalId,
      approved: false,
      ...(reason !== undefined && { reason }),
    },
    {
      type: 'tool-output-denied',
      toolCallId: callId,
      toolName,
      input: parsedInput,
      ...(reason !== undefined && { reason }),
    },
  );
  collector.settledClientToolCount += 1;
}

/** Record a policy-driven automatic approval with an HMAC over the exact persisted JSON input. */
export async function recordAutomaticApproval<CONTEXT, TOOLS extends AgentToolSet>(
  input: ApprovalRecordInput<CONTEXT, TOOLS>,
): Promise<void> {
  const { execution, callId, toolName, parsedInput, callRecord, reason, emit, callSlot } =
    input;
  const { config, generateId } = execution.dependencies;
  const approvalId = generateId();
  const secret = config.loop?.toolApprovalSecret;
  const signature =
    secret !== undefined
      ? await signToolApproval({
          secret,
          approvalId,
          toolCallId: callId,
          toolName,
          toolInput: normalizePersistedToolInput(parsedInput),
        })
      : undefined;
  await emit({
    type: 'tool-approval-request',
    approvalId,
    toolCall: callRecord,
    isAutomatic: true,
    ...(signature !== undefined && { signature }),
  });
  await emit({
    type: 'tool-approval-response',
    approvalId,
    approved: true,
    ...(reason !== undefined && { reason }),
  });
  callSlot.assistantParts.push({
    type: 'tool-approval-request',
    approvalId,
    toolCallId: callId,
    isAutomatic: true,
    ...(signature !== undefined && { signature }),
  });
  callSlot.toolParts.push({
    type: 'tool-approval-response',
    approvalId,
    approved: true,
    ...(reason !== undefined && { reason }),
  });
  callSlot.stepContent.push(
    {
      type: 'tool-approval-request',
      approvalId,
      toolCall: callRecord,
      isAutomatic: true,
      ...(signature !== undefined && { signature }),
    },
    {
      type: 'tool-approval-response',
      approvalId,
      approved: true,
      ...(reason !== undefined && { reason }),
    },
  );
}
