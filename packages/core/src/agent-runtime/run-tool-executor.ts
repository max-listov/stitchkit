import type {
  AgentModelAssistantContentPart,
  AgentModelMessage,
  AgentModelProviderOptions,
  AgentModelSystemMessage,
  AgentModelToolContentPart,
} from '../agent-parts/model';
import { linkAbortSignals } from '../internal/abort-race';
import { isRecord } from '../internal/typed';
import { type AgentToolError, isAgentToolError } from '../tools/agent-tool-error';
import type { AgentTool, AgentToolSet } from '../tools/agent-tools';
import type {
  AgentStepContentPart,
  AgentStepToolCall,
  AgentStepToolResult,
  AgentToolApprovalConfiguration,
  AgentToolCallRepairFunction,
} from './models-driver-step';
import { envelopeToProviderOptions } from './provider-media';
import type { RunExecution } from './run-execution-state';
import type { AgentLoopEvent } from './run-loop-events';
import { createStepCallScheduler, stepToolCallLimitRefusal } from './run-step-barriers';
import { authorizeAndScheduleCall } from './run-tool-approval-flow';
import {
  type CallSlotResult,
  createCallSlotResult,
  type RawProviderToolCall,
  resolveToolCallInput,
  type StepExecutionCollector,
  safeToolErrorMessage,
} from './run-tool-call';

export interface StepToolExecutionResult {
  readonly assistantParts: AgentModelAssistantContentPart[];
  readonly toolParts: AgentModelToolContentPart[];
  readonly stepContent: AgentStepContentPart[];
  readonly toolCalls: AgentStepToolCall[];
  readonly toolResults: AgentStepToolResult[];
  readonly clientToolCallCount: number;
  readonly settledClientToolCount: number;
}

export function emptyStepToolExecutionResult(): StepToolExecutionResult {
  return {
    assistantParts: [],
    toolParts: [],
    stepContent: [],
    toolCalls: [],
    toolResults: [],
    clientToolCallCount: 0,
    settledClientToolCount: 0,
  };
}

interface ParsedClientCall {
  readonly index: number;
  readonly raw: RawProviderToolCall;
  readonly toolName: string;
  readonly tool: AgentTool;
  readonly parsedInput: unknown;
  readonly providerOptions: AgentModelProviderOptions | undefined;
  readonly callRecord: AgentStepToolCall;
}

interface InvalidClientCall {
  readonly index: number;
  readonly toolName: string;
  readonly parsedInput: unknown;
}

async function recordInvalidToolCall(input: {
  raw: RawProviderToolCall;
  kind: 'unknown-tool' | 'invalid-input';
  toolName: string;
  parsedInput: unknown;
  error: unknown;
  providerOptions: AgentModelProviderOptions | undefined;
  callSlot: CallSlotResult;
  collector: StepExecutionCollector;
  emit: (event: AgentLoopEvent) => Promise<void>;
}): Promise<void> {
  const {
    raw,
    kind,
    toolName,
    parsedInput,
    error,
    providerOptions,
    callSlot,
    collector,
    emit,
  } = input;
  const wireInput = kind === 'invalid-input' ? {} : isRecord(parsedInput) ? parsedInput : {};
  const callRecord: AgentStepToolCall = {
    type: 'tool-call',
    toolCallId: raw.toolCallId,
    toolName,
    input: parsedInput,
    invalid: true,
    error,
  };
  callSlot.toolCalls.push(callRecord);
  callSlot.stepContent.push(callRecord, {
    type: 'tool-error',
    toolCallId: raw.toolCallId,
    toolName,
    input: parsedInput,
    error,
  });
  callSlot.assistantParts.push({
    type: 'tool-call',
    toolCallId: raw.toolCallId,
    toolName,
    input: wireInput,
    ...(providerOptions && { providerOptions }),
  });
  callSlot.toolParts.push({
    type: 'tool-result',
    toolCallId: raw.toolCallId,
    toolName,
    output: { type: 'error-text', value: safeToolErrorMessage(error) },
  });
  await emit({
    type: 'tool-call',
    toolCallId: raw.toolCallId,
    toolName,
    input: wireInput,
    ...(raw.provider && { provider: raw.provider }),
  });
  await emit({
    type: 'tool-error',
    toolCallId: raw.toolCallId,
    toolName,
    input: parsedInput,
    error,
  });
  collector.settledClientToolCount += 1;
}

async function recordRefusedToolCall(input: {
  callId: string;
  toolName: string;
  parsedInput: unknown;
  refusal: AgentToolError | Error;
  callSlot: CallSlotResult;
  collector: StepExecutionCollector;
  emit: (event: AgentLoopEvent) => Promise<void>;
}): Promise<void> {
  const { callId, toolName, parsedInput, refusal, callSlot, collector, emit } = input;
  const wireMessage = safeToolErrorMessage(refusal);
  const safeError = isAgentToolError(refusal)
    ? refusal
    : new Error(wireMessage, { cause: refusal });
  await emit({
    type: 'tool-error',
    toolCallId: callId,
    toolName,
    input: parsedInput,
    error: safeError,
  });
  callSlot.stepContent.push({
    type: 'tool-error',
    toolCallId: callId,
    toolName,
    input: parsedInput,
    error: safeError,
  });
  callSlot.toolParts.push({
    type: 'tool-result',
    toolCallId: callId,
    toolName,
    output: { type: 'error-text', value: wireMessage },
  });
  collector.settledClientToolCount += 1;
}

async function parseStepClientCalls<TOOLS extends AgentToolSet>(input: {
  clientCalls: readonly RawProviderToolCall[];
  callSlots: readonly CallSlotResult[];
  tools: TOOLS;
  activeTools: readonly string[];
  messages: readonly AgentModelMessage[];
  repairToolCall: AgentToolCallRepairFunction | undefined;
  signal: AbortSignal;
  collector: StepExecutionCollector;
  emit: (event: AgentLoopEvent) => Promise<void>;
}): Promise<{ validCalls: ParsedClientCall[]; invalidCalls: InvalidClientCall[] }> {
  const {
    clientCalls,
    callSlots,
    tools,
    activeTools,
    messages,
    repairToolCall,
    signal,
    collector,
    emit,
  } = input;
  const validCalls: ParsedClientCall[] = [];
  const invalidCalls: InvalidClientCall[] = [];
  for (const [index, raw] of clientCalls.entries()) {
    signal.throwIfAborted();
    const callSlot = callSlots[index];
    if (!callSlot) continue;
    const resolved = await resolveToolCallInput({
      raw,
      tools,
      activeTools,
      messages,
      repairToolCall,
    });
    signal.throwIfAborted();
    const providerOptions = envelopeToProviderOptions(raw.provider);
    if (!resolved.ok) {
      await recordInvalidToolCall({
        raw,
        kind: resolved.kind,
        toolName: resolved.toolName,
        parsedInput: resolved.parsedInput,
        error: resolved.error,
        providerOptions,
        callSlot,
        collector,
        emit,
      });
      invalidCalls.push({
        index,
        toolName: resolved.toolName,
        parsedInput: resolved.parsedInput,
      });
      continue;
    }
    validCalls.push({
      index,
      raw,
      toolName: resolved.toolName,
      tool: resolved.tool,
      parsedInput: resolved.parsedInput,
      providerOptions,
      callRecord: {
        type: 'tool-call',
        toolCallId: raw.toolCallId,
        toolName: resolved.toolName,
        input: resolved.parsedInput,
      },
    });
  }
  return { validCalls, invalidCalls };
}

async function recordValidatedCallStart(
  entry: ParsedClientCall,
  callSlot: CallSlotResult,
  emit: (event: AgentLoopEvent) => Promise<void>,
): Promise<void> {
  callSlot.toolCalls.push(entry.callRecord);
  callSlot.stepContent.push(entry.callRecord);
  callSlot.assistantParts.push({
    type: 'tool-call',
    toolCallId: entry.raw.toolCallId,
    toolName: entry.toolName,
    input: entry.parsedInput,
    ...(entry.providerOptions && { providerOptions: entry.providerOptions }),
  });
  await emit({
    type: 'tool-call',
    toolCallId: entry.raw.toolCallId,
    toolName: entry.toolName,
    input: entry.parsedInput,
    ...(entry.raw.provider && { provider: entry.raw.provider }),
  });
}

function recordFailedEntities(
  scheduler: ReturnType<typeof createStepCallScheduler>,
  collector: StepExecutionCollector,
  toolName: string,
  parsedInput: unknown,
): void {
  for (const entity of scheduler.recordFailedPredecessor(toolName, parsedInput)) {
    collector.failedEntities.add(entity);
  }
}

/**
 * Parse, repair, batch-check (`beforeStepToolCalls`), authorize and execute all client-side
 * tool calls emitted on one step while preserving original call order for prompt caching.
 */
export async function executeStepToolCalls<CONTEXT, TOOLS extends AgentToolSet>(input: {
  execution: RunExecution<CONTEXT, TOOLS>;
  stepNumber: number;
  rawCalls: readonly RawProviderToolCall[];
  tools: TOOLS;
  activeTools: readonly string[];
  toolApproval: AgentToolApprovalConfiguration<TOOLS, CONTEXT> | undefined;
  repairToolCall: AgentToolCallRepairFunction | undefined;
  instructions: readonly AgentModelSystemMessage[];
  messages: readonly AgentModelMessage[];
  signal: AbortSignal;
  emit: (event: AgentLoopEvent) => Promise<void>;
}): Promise<StepToolExecutionResult> {
  const {
    execution,
    stepNumber,
    rawCalls,
    tools,
    activeTools,
    toolApproval,
    repairToolCall,
    instructions,
    messages,
    signal,
    emit,
  } = input;
  const clientCalls = rawCalls.filter((raw) => raw.providerExecuted !== true);
  if (clientCalls.length === 0) return emptyStepToolExecutionResult();

  const { config } = execution.dependencies;
  const callSlots: CallSlotResult[] = clientCalls.map(() => createCallSlotResult());
  const stepAbort = new AbortController();
  const stepSignalLink = linkAbortSignals(signal, stepAbort.signal);
  const collector: StepExecutionCollector = {
    settledClientToolCount: 0,
    pendingExecutions: [],
    awaitingApprovalEntities: new Set<string>(),
    failedEntities: new Set<string>(),
    onFatalError(error) {
      if (!stepAbort.signal.aborted) stepAbort.abort(error);
    },
  };
  const scheduler = createStepCallScheduler(config.loop?.stepBarriers);

  execution.idleDeadline.suspend();
  try {
    // Phase 1: parse, validate and repair every client call on this step.
    const { validCalls, invalidCalls } = await parseStepClientCalls({
      clientCalls,
      callSlots,
      tools,
      activeTools,
      messages,
      repairToolCall,
      signal: stepSignalLink.signal,
      collector,
      emit,
    });
    stepSignalLink.signal.throwIfAborted();

    // Phase 2: whole-step batch policy hook over all validated calls.
    const batchDecision =
      validCalls.length > 0 && config.loop?.beforeStepToolCalls
        ? await config.loop.beforeStepToolCalls({
            stepNumber,
            calls: validCalls.map((entry) => ({
              toolCallId: entry.raw.toolCallId,
              toolName: entry.toolName,
              input: entry.parsedInput,
            })),
            instructions,
            messages,
            context: execution.input.context,
          })
        : undefined;
    stepSignalLink.signal.throwIfAborted();
    const refusals = batchDecision?.refuse;

    // Phase 3: emit, authorize, schedule and await all executions in original call order so
    // failed invalid calls or batch refusals poison only subsequent dependent calls.
    const validByIndex = new Map<number, ParsedClientCall>(
      validCalls.map((entry) => [entry.index, entry]),
    );
    const invalidByIndex = new Map<number, InvalidClientCall>(
      invalidCalls.map((entry) => [entry.index, entry]),
    );
    for (let index = 0; index < clientCalls.length; index += 1) {
      stepSignalLink.signal.throwIfAborted();
      const invalid = invalidByIndex.get(index);
      if (invalid !== undefined) {
        recordFailedEntities(scheduler, collector, invalid.toolName, invalid.parsedInput);
        continue;
      }
      const entry = validByIndex.get(index);
      const callSlot = callSlots[index];
      if (!entry || !callSlot) continue;
      await recordValidatedCallStart(entry, callSlot, emit);

      const batchRefusal = refusals?.get(entry.raw.toolCallId);
      if (batchRefusal !== undefined) {
        recordFailedEntities(scheduler, collector, entry.toolName, entry.parsedInput);
        await recordRefusedToolCall({
          callId: entry.raw.toolCallId,
          toolName: entry.toolName,
          parsedInput: entry.parsedInput,
          refusal: batchRefusal,
          callSlot,
          collector,
          emit,
        });
        continue;
      }

      const slot = scheduler.enter(entry.toolName, entry.parsedInput);
      if (slot.refused) {
        await recordRefusedToolCall({
          callId: entry.raw.toolCallId,
          toolName: entry.toolName,
          parsedInput: entry.parsedInput,
          refusal: stepToolCallLimitRefusal(slot.limit ?? 0),
          callSlot,
          collector,
          emit,
        });
        continue;
      }

      if (typeof entry.tool.execute !== 'function') {
        try {
          if (entry.tool.onInputAvailable) {
            await entry.tool.onInputAvailable.call(entry.tool, {
              input: entry.parsedInput,
              toolCallId: entry.raw.toolCallId,
              messages,
              abortSignal: stepSignalLink.signal,
            });
          }
        } finally {
          slot.settle(false);
        }
        continue;
      }

      await authorizeAndScheduleCall({
        execution,
        raw: entry.raw,
        toolName: entry.toolName,
        tool: entry.tool,
        parsedInput: entry.parsedInput,
        callRecord: entry.callRecord,
        slot,
        callSlot,
        toolApproval,
        messages,
        signal: stepSignalLink.signal,
        emit,
        collector,
      });
    }

    if (collector.pendingExecutions.length > 0) {
      await Promise.all(collector.pendingExecutions);
    }
    stepSignalLink.signal.throwIfAborted();
  } catch (error) {
    if (!stepAbort.signal.aborted) stepAbort.abort(error);
    throw error;
  } finally {
    if (collector.pendingExecutions.length > 0) {
      await Promise.allSettled(collector.pendingExecutions);
    }
    stepSignalLink.release();
    execution.idleDeadline.resume();
  }

  return {
    assistantParts: callSlots.flatMap((slot) => slot.assistantParts),
    toolParts: callSlots.flatMap((slot) => slot.toolParts),
    stepContent: callSlots.flatMap((slot) => slot.stepContent),
    toolCalls: callSlots.flatMap((slot) => slot.toolCalls),
    toolResults: callSlots.flatMap((slot) => slot.toolResults),
    clientToolCallCount: clientCalls.length,
    settledClientToolCount: collector.settledClientToolCount,
  };
}
