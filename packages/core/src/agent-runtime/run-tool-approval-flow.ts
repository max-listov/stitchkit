import type { AgentModelMessage, AgentModelToolContentPart } from '../agent-parts/model';
import { isRecord } from '../internal/typed';
import { AgentToolError, isAgentToolError } from '../tools/agent-tool-error';
import type { AgentTool, AgentToolSet } from '../tools/agent-tools';
import type {
  AgentStepToolCall,
  AgentStepToolResult,
  AgentToolApprovalConfiguration,
} from './models-driver-step';
import { collectApprovalContinuations, evaluateToolApprovalPolicy } from './run-approval';
import type { RunExecution } from './run-execution-state';
import type { AgentLoopEvent } from './run-loop-events';
import {
  createStepCallScheduler,
  type StepCallSlot,
  stepToolCallLimitRefusal,
} from './run-step-barriers';
import {
  recordAutomaticApproval,
  recordAutomaticDenial,
  recordUserApprovalRequest,
} from './run-tool-approval-records';
import {
  type CallSlotResult,
  type RawProviderToolCall,
  runSingleToolExecution,
  type StepExecutionCollector,
} from './run-tool-call';

function dependencyEntities<CONTEXT, TOOLS extends AgentToolSet>(
  execution: RunExecution<CONTEXT, TOOLS>,
  toolName: string,
  input: unknown,
): string[] {
  const deps = execution.dependencies.config.loop?.stepBarriers?.toolDependencies?.({
    toolName,
    input,
  });
  if (!deps) return [];
  return [...(deps.reads ?? []), ...(deps.writes ?? [])];
}

function recordEntities<CONTEXT, TOOLS extends AgentToolSet>(
  execution: RunExecution<CONTEXT, TOOLS>,
  target: Set<string>,
  toolName: string,
  input: unknown,
): void {
  for (const entity of dependencyEntities(execution, toolName, input)) {
    target.add(entity);
  }
}

function isAwaitingApprovalPredecessor<CONTEXT, TOOLS extends AgentToolSet>(
  execution: RunExecution<CONTEXT, TOOLS>,
  collector: StepExecutionCollector,
  toolName: string,
  input: unknown,
): boolean {
  const entities = dependencyEntities(execution, toolName, input);
  return (
    entities.some((entity) => collector.awaitingApprovalEntities.has(entity)) &&
    !entities.some((entity) => collector.failedEntities.has(entity))
  );
}

/**
 * Resolve any pending `tool-approval-response` entries in the tail `role: 'tool'`
 * message before step 0, re-evaluating policy and executing approved calls in
 * their original order.
 */
export async function executeApprovalContinuations<
  CONTEXT,
  TOOLS extends AgentToolSet,
>(input: {
  execution: RunExecution<CONTEXT, TOOLS>;
  tools: TOOLS;
  toolApproval: AgentToolApprovalConfiguration<TOOLS, CONTEXT> | undefined;
  messages: AgentModelMessage[];
  signal: AbortSignal;
  emit: (event: AgentLoopEvent) => Promise<void>;
}): Promise<boolean> {
  const { execution, tools, toolApproval, messages, signal, emit } = input;
  const { config } = execution.dependencies;
  const continuations = await collectApprovalContinuations({
    messages,
    tools,
    secret: config.loop?.toolApprovalSecret,
  });
  if (continuations.length === 0) return false;

  const scheduler = createStepCallScheduler(config.loop?.stepBarriers);
  const appended: AgentModelToolContentPart[] = [];
  execution.idleDeadline.suspend();
  try {
    for (const item of continuations) {
      signal.throwIfAborted();
      const tool = Object.hasOwn(tools, item.toolName) ? tools[item.toolName] : undefined;
      let approved = item.approved;
      let reason = item.reason;
      if (approved && tool && toolApproval !== undefined) {
        const recheck = await evaluateToolApprovalPolicy({
          tool,
          toolName: item.toolName,
          toolCallId: item.toolCallId,
          toolInput: item.input,
          messages,
          abortSignal: signal,
          runtimeContext: execution.input.context,
          toolApproval,
        });
        if (recheck.kind === 'denied') {
          approved = false;
          reason = recheck.reason ?? reason;
        }
      }
      if (!approved) {
        scheduler.recordFailedPredecessor(item.toolName, item.input);
        await emit({
          type: 'tool-output-denied',
          toolCallId: item.toolCallId,
          toolName: item.toolName,
          input: item.input,
          ...(reason !== undefined && { reason }),
        });
        appended.push({
          type: 'tool-result',
          toolCallId: item.toolCallId,
          toolName: item.toolName,
          output: { type: 'execution-denied', ...(reason !== undefined && { reason }) },
        });
        continue;
      }
      if (!tool || typeof tool.execute !== 'function') {
        scheduler.recordFailedPredecessor(item.toolName, item.input);
        const error = new Error(`Approved tool "${item.toolName}" is not executable`);
        await emit({
          type: 'tool-error',
          toolCallId: item.toolCallId,
          toolName: item.toolName,
          input: item.input,
          error,
        });
        appended.push({
          type: 'tool-result',
          toolCallId: item.toolCallId,
          toolName: item.toolName,
          output: { type: 'error-text', value: error.message },
        });
        continue;
      }
      const slot = scheduler.enter(item.toolName, item.input);
      if (slot.refused) {
        scheduler.recordFailedPredecessor(item.toolName, item.input);
        const refusal = stepToolCallLimitRefusal(slot.limit ?? 0);
        await emit({
          type: 'tool-error',
          toolCallId: item.toolCallId,
          toolName: item.toolName,
          input: item.input,
          error: refusal,
        });
        appended.push({
          type: 'tool-result',
          toolCallId: item.toolCallId,
          toolName: item.toolName,
          output: { type: 'error-text', value: refusal.message },
        });
        continue;
      }
      const outcome = await runSingleToolExecution({
        execution,
        tool,
        toolName: item.toolName,
        toolCallId: item.toolCallId,
        parsedInput: item.input,
        messages,
        signal,
        waitAhead: () => slot.waitAhead(signal),
        settle: (ok) => slot.settle(ok),
        emit,
      });
      appended.push({
        type: 'tool-result',
        toolCallId: item.toolCallId,
        toolName: item.toolName,
        output: outcome.wireOutput,
      });
    }
  } finally {
    execution.idleDeadline.resume();
  }

  if (appended.length > 0) {
    const tail = messages.at(-1);
    if (tail && tail.role === 'tool') {
      messages[messages.length - 1] = { ...tail, content: [...tail.content, ...appended] };
    } else {
      messages.push({ role: 'tool', content: appended });
    }
  }
  return true;
}

export async function authorizeAndScheduleCall<CONTEXT, TOOLS extends AgentToolSet>(input: {
  execution: RunExecution<CONTEXT, TOOLS>;
  raw: RawProviderToolCall;
  toolName: string;
  tool: AgentTool;
  parsedInput: unknown;
  callRecord: AgentStepToolCall;
  slot: StepCallSlot;
  callSlot: CallSlotResult;
  toolApproval: AgentToolApprovalConfiguration<TOOLS, CONTEXT> | undefined;
  messages: readonly AgentModelMessage[];
  signal: AbortSignal;
  emit: (event: AgentLoopEvent) => Promise<void>;
  collector: StepExecutionCollector;
}): Promise<void> {
  const {
    execution,
    raw,
    toolName,
    tool,
    parsedInput,
    callRecord,
    slot,
    callSlot,
    messages,
    signal,
    emit,
    collector,
  } = input;
  if (tool.onInputAvailable) {
    try {
      await tool.onInputAvailable.call(tool, {
        input: parsedInput,
        toolCallId: raw.toolCallId,
        messages,
        abortSignal: signal,
      });
    } catch (error) {
      recordEntities(execution, collector.failedEntities, toolName, parsedInput);
      slot.settle(false);
      throw error;
    }
  }
  let decision: Awaited<ReturnType<typeof evaluateToolApprovalPolicy>>;
  try {
    decision = await evaluateToolApprovalPolicy({
      tool,
      toolName,
      toolCallId: raw.toolCallId,
      toolInput: parsedInput,
      messages,
      abortSignal: signal,
      runtimeContext: execution.input.context,
      toolApproval: input.toolApproval,
    });
  } catch (error) {
    recordEntities(execution, collector.failedEntities, toolName, parsedInput);
    slot.settle(false);
    throw error;
  }

  const shared = {
    execution,
    callId: raw.toolCallId,
    toolName,
    parsedInput,
    callRecord,
    ...(decision.reason !== undefined && { reason: decision.reason }),
    emit,
    callSlot,
  };
  if (decision.kind === 'user-approval') {
    recordEntities(execution, collector.awaitingApprovalEntities, toolName, parsedInput);
    slot.settle(false);
    await recordUserApprovalRequest(shared);
    return;
  }
  if (decision.kind === 'denied') {
    recordEntities(execution, collector.failedEntities, toolName, parsedInput);
    slot.settle(false);
    await recordAutomaticDenial({ ...shared, collector });
    return;
  }
  if (decision.kind === 'approved') {
    try {
      await recordAutomaticApproval(shared);
    } catch (error) {
      recordEntities(execution, collector.failedEntities, toolName, parsedInput);
      slot.settle(false);
      throw error;
    }
  }

  let refusedForAwaitingApproval = false;
  const task = runSingleToolExecution({
    execution,
    tool,
    toolName,
    toolCallId: raw.toolCallId,
    parsedInput,
    messages,
    signal,
    waitAhead: async () => {
      try {
        await slot.waitAhead(signal);
      } catch (error) {
        if (
          isAgentToolError(error) &&
          isRecord(error.output) &&
          error.output.code === 'STEP_PREDECESSOR_FAILED' &&
          isAwaitingApprovalPredecessor(execution, collector, toolName, parsedInput)
        ) {
          refusedForAwaitingApproval = true;
          throw new AgentToolError(
            {
              code: 'STEP_PREDECESSOR_AWAITING_APPROVAL',
              message:
                'Refused: an earlier tool call on the same entity is awaiting approval in this step',
            },
            error,
          );
        }
        throw error;
      }
    },
    settle: (ok) => {
      if (!ok) {
        recordEntities(
          execution,
          refusedForAwaitingApproval
            ? collector.awaitingApprovalEntities
            : collector.failedEntities,
          toolName,
          parsedInput,
        );
      }
      slot.settle(ok);
    },
    emit,
  })
    .then((outcome) => {
      collector.settledClientToolCount += 1;
      if (outcome.ok) {
        const resultRecord: AgentStepToolResult = {
          type: 'tool-result',
          toolCallId: raw.toolCallId,
          toolName,
          input: parsedInput,
          output: outcome.output,
        };
        callSlot.toolResults.push(resultRecord);
        callSlot.stepContent.push(resultRecord);
      } else {
        callSlot.stepContent.push({
          type: 'tool-error',
          toolCallId: raw.toolCallId,
          toolName,
          input: parsedInput,
          error: outcome.error,
        });
      }
      callSlot.toolParts.push({
        type: 'tool-result',
        toolCallId: raw.toolCallId,
        toolName,
        output: outcome.wireOutput,
      });
    })
    .catch((error: unknown) => {
      collector.onFatalError?.(error);
      throw error;
    });
  // Guard against unhandled rejection if a fatal throw settles before `Promise.all`.
  void task.catch(() => undefined);
  collector.pendingExecutions.push(task);
}
