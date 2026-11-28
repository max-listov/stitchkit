import type { AgentModelMessage, AgentToolModelOutput } from '../agent-parts/model';
import { linkAbortSignals } from '../internal/abort-race';
import { isAsyncIterable, isRecord } from '../internal/typed';
import {
  type AgentTool,
  type AgentToolCall,
  type AgentToolSet,
  finalizeAgentToolOutput,
} from '../tools/agent-tools';
import type {
  AgentStepToolCall,
  AgentStepToolResult,
  AgentToolCallRepairFunction,
} from './models-driver-step';
import { envelopeToProviderOptions } from './provider-media';
import { AgentToolApprovalError } from './run-approval';
import type { CompleteStreamPart } from './run-complete-types';
import {
  type CallSlotResult,
  createCallSlotResult,
  defaultToolWireOutput,
  type RawProviderToolCall,
  resolveToolCallInput,
  safeToolErrorMessage,
} from './run-tool-call';
import {
  emptyStepToolExecutionResult,
  type StepToolExecutionResult,
} from './run-tool-executor';

/**
 * Evaluate `tool.needsApproval` fail-closed before executing any client tool inside
 * stateless `completeText` / `streamComplete` / `completeObject` (I9, I12).
 */
async function assertStandaloneToolApproval(input: {
  readonly tool: AgentTool;
  readonly toolName: string;
  readonly toolCallId: string;
  readonly parsedInput: unknown;
  readonly messages: readonly AgentModelMessage[];
  readonly signal: AbortSignal;
}): Promise<void> {
  const { tool, toolName, toolCallId, parsedInput, messages, signal } = input;
  if (tool.needsApproval === undefined) return;
  const requiresApproval =
    typeof tool.needsApproval === 'function'
      ? await tool.needsApproval.call(tool, parsedInput, {
          toolCallId,
          messages,
          abortSignal: signal,
        })
      : tool.needsApproval;
  signal.throwIfAborted();
  if (requiresApproval) {
    throw new AgentToolApprovalError(
      `Tool "${toolName}" requires approval, which is not supported in stateless completion; use createAgentRuntime`,
      { reason: 'approval-unsupported' },
    );
  }
}

async function recordInvalidStandaloneToolCall(input: {
  readonly raw: RawProviderToolCall;
  readonly kind: 'unknown-tool' | 'invalid-input';
  readonly toolName: string;
  readonly parsedInput: unknown;
  readonly error: unknown;
  readonly slot: CallSlotResult;
  readonly onPart?: (part: CompleteStreamPart) => void | Promise<void>;
}): Promise<void> {
  const { raw, kind, toolName, parsedInput, error, slot, onPart } = input;
  const providerOptions = envelopeToProviderOptions(raw.provider);
  const wireInput = kind === 'invalid-input' ? {} : isRecord(parsedInput) ? parsedInput : {};
  const callRecord: AgentStepToolCall = {
    type: 'tool-call',
    toolCallId: raw.toolCallId,
    toolName,
    input: parsedInput,
    invalid: true,
    error,
  };
  slot.toolCalls.push(callRecord);
  slot.stepContent.push(callRecord, {
    type: 'tool-error',
    toolCallId: raw.toolCallId,
    toolName,
    input: parsedInput,
    error,
  });
  slot.assistantParts.push({
    type: 'tool-call',
    toolCallId: raw.toolCallId,
    toolName,
    input: wireInput,
    ...(providerOptions && { providerOptions }),
  });
  slot.toolParts.push({
    type: 'tool-result',
    toolCallId: raw.toolCallId,
    toolName,
    output: { type: 'error-text', value: safeToolErrorMessage(error) },
  });
  await onPart?.({
    type: 'tool-call',
    toolCallId: raw.toolCallId,
    toolName,
    input: parsedInput,
    invalid: true,
    error,
    ...(raw.provider !== undefined && { provider: raw.provider }),
  });
  await onPart?.({
    type: 'tool-error',
    toolCallId: raw.toolCallId,
    toolName,
    input: parsedInput,
    error,
  });
}

async function executeStandaloneToolCall(input: {
  readonly raw: RawProviderToolCall;
  readonly toolName: string;
  readonly tool: AgentTool;
  readonly execute: NonNullable<AgentTool['execute']>;
  readonly parsedInput: unknown;
  readonly messages: readonly AgentModelMessage[];
  readonly signal: AbortSignal;
  readonly slot: CallSlotResult;
  readonly onPart?: (part: CompleteStreamPart) => void | Promise<void>;
  readonly onSettled: () => void;
}): Promise<void> {
  const { raw, toolName, tool, execute, parsedInput, messages, signal, slot, onPart } = input;
  const call: AgentToolCall = {
    toolCallId: raw.toolCallId,
    messages,
    abortSignal: signal,
  };
  let outcome:
    | { ok: true; finalValue: unknown; wireOutput: AgentToolModelOutput }
    | { ok: false; error: unknown };
  let onPartFailed = false;
  try {
    signal.throwIfAborted();
    const rawResult = await execute.call(tool, parsedInput, call);
    signal.throwIfAborted();
    const wasAsyncIterable = isAsyncIterable(rawResult);
    let finalValue: unknown = rawResult;
    if (wasAsyncIterable) {
      let last: unknown;
      for await (const chunk of rawResult) {
        signal.throwIfAborted();
        last = chunk;
        try {
          await onPart?.({
            type: 'tool-result',
            toolCallId: raw.toolCallId,
            toolName,
            input: parsedInput,
            result: chunk,
            preliminary: true,
            providerExecuted: false,
          });
        } catch (partError) {
          onPartFailed = true;
          throw partError;
        }
      }
      signal.throwIfAborted();
      finalValue = last;
    }
    finalValue = finalizeAgentToolOutput(tool, finalValue, wasAsyncIterable);
    const wireOutput = tool.toModelOutput
      ? await tool.toModelOutput({
          toolCallId: raw.toolCallId,
          input: parsedInput,
          output: finalValue,
        })
      : defaultToolWireOutput(finalValue);
    signal.throwIfAborted();
    outcome = { ok: true, finalValue, wireOutput };
  } catch (error) {
    if (onPartFailed || signal.aborted) throw error;
    outcome = { ok: false, error };
  }

  signal.throwIfAborted();
  // Emit terminal tool-result / tool-error outside tool try/catch so caller onPart throws
  // never synthesize a duplicate error-text tool-result for the same call.
  if (outcome.ok) {
    const resultRecord: AgentStepToolResult = {
      type: 'tool-result',
      toolCallId: raw.toolCallId,
      toolName,
      input: parsedInput,
      output: outcome.finalValue,
    };
    slot.toolResults.push(resultRecord);
    slot.stepContent.push(resultRecord);
    slot.toolParts.push({
      type: 'tool-result',
      toolCallId: raw.toolCallId,
      toolName,
      output: outcome.wireOutput,
    });
    await onPart?.({
      type: 'tool-result',
      toolCallId: raw.toolCallId,
      toolName,
      input: parsedInput,
      result: outcome.finalValue,
      preliminary: false,
      providerExecuted: false,
    });
    input.onSettled();
  } else {
    slot.stepContent.push({
      type: 'tool-error',
      toolCallId: raw.toolCallId,
      toolName,
      input: parsedInput,
      error: outcome.error,
    });
    slot.toolParts.push({
      type: 'tool-result',
      toolCallId: raw.toolCallId,
      toolName,
      output: { type: 'error-text', value: safeToolErrorMessage(outcome.error) },
    });
    await onPart?.({
      type: 'tool-error',
      toolCallId: raw.toolCallId,
      toolName,
      input: parsedInput,
      error: outcome.error,
    });
    input.onSettled();
  }
}

/**
 * Execute client-side tool calls for peer-free `completeText` / `completeObject` / `streamComplete`
 * steps, preserving deterministic call ordering, `onInputAvailable`, fail-closed `needsApproval`,
 * and safe wire error redaction.
 */
export async function runStandaloneClientTools(input: {
  readonly rawCalls: readonly RawProviderToolCall[];
  readonly tools: AgentToolSet;
  readonly activeTools: readonly string[];
  readonly repairToolCall: AgentToolCallRepairFunction | undefined;
  readonly messages: readonly AgentModelMessage[];
  readonly signal: AbortSignal;
  readonly onPart?: (
    part: CompleteStreamPart,
    waitSignal?: AbortSignal,
  ) => void | Promise<void>;
}): Promise<StepToolExecutionResult> {
  const clientCalls = input.rawCalls.filter((call) => call.providerExecuted !== true);
  if (clientCalls.length === 0) return emptyStepToolExecutionResult();

  const slots = clientCalls.map(() => createCallSlotResult());
  const pending: Promise<void>[] = [];
  const stepAbort = new AbortController();
  const stepSignalLink = linkAbortSignals(input.signal, stepAbort.signal);
  const emitStepPart = input.onPart
    ? (part: CompleteStreamPart) => input.onPart?.(part, stepSignalLink.signal)
    : undefined;
  let settledCount = 0;

  try {
    for (const [index, raw] of clientCalls.entries()) {
      stepSignalLink.signal.throwIfAborted();
      const slot = slots[index];
      if (!slot) continue;
      const resolved = await resolveToolCallInput({
        raw,
        tools: input.tools,
        activeTools: input.activeTools,
        messages: input.messages,
        repairToolCall: input.repairToolCall,
      });
      stepSignalLink.signal.throwIfAborted();
      if (!resolved.ok) {
        await recordInvalidStandaloneToolCall({
          raw,
          kind: resolved.kind,
          toolName: resolved.toolName,
          parsedInput: resolved.parsedInput,
          error: resolved.error,
          slot,
          ...(emitStepPart !== undefined && { onPart: emitStepPart }),
        });
        settledCount += 1;
        continue;
      }

      const { toolName, tool, parsedInput } = resolved;
      const providerOptions = envelopeToProviderOptions(raw.provider);
      const callRecord: AgentStepToolCall = {
        type: 'tool-call',
        toolCallId: raw.toolCallId,
        toolName,
        input: parsedInput,
      };
      slot.toolCalls.push(callRecord);
      slot.stepContent.push(callRecord);
      slot.assistantParts.push({
        type: 'tool-call',
        toolCallId: raw.toolCallId,
        toolName,
        input: parsedInput,
        ...(providerOptions && { providerOptions }),
      });
      await emitStepPart?.({
        type: 'tool-call',
        toolCallId: raw.toolCallId,
        toolName,
        input: parsedInput,
        ...(raw.provider !== undefined && { provider: raw.provider }),
      });

      if (tool.onInputAvailable) {
        await tool.onInputAvailable.call(tool, {
          input: parsedInput,
          toolCallId: raw.toolCallId,
          messages: input.messages,
          abortSignal: stepSignalLink.signal,
        });
        stepSignalLink.signal.throwIfAborted();
      }

      const execute = tool.execute;
      if (typeof execute !== 'function') continue;

      if (tool.needsApproval !== undefined) {
        await assertStandaloneToolApproval({
          tool,
          toolName,
          toolCallId: raw.toolCallId,
          parsedInput,
          messages: input.messages,
          signal: stepSignalLink.signal,
        });
      }

      const task = executeStandaloneToolCall({
        raw,
        toolName,
        tool,
        execute,
        parsedInput,
        messages: input.messages,
        signal: stepSignalLink.signal,
        slot,
        ...(emitStepPart !== undefined && { onPart: emitStepPart }),
        onSettled: () => {
          settledCount += 1;
        },
      }).catch((error: unknown) => {
        if (!stepAbort.signal.aborted) stepAbort.abort(error);
        throw error;
      });
      // Guard against unhandled rejection if a fatal throw settles before `Promise.all`.
      void task.catch(() => undefined);
      pending.push(task);
    }
    if (pending.length > 0) await Promise.all(pending);
    stepSignalLink.signal.throwIfAborted();
  } catch (error) {
    if (!stepAbort.signal.aborted) stepAbort.abort(error);
    throw error;
  } finally {
    if (pending.length > 0) await Promise.allSettled(pending);
    stepSignalLink.release();
  }

  return {
    assistantParts: slots.flatMap((slot) => slot.assistantParts),
    toolParts: slots.flatMap((slot) => slot.toolParts),
    stepContent: slots.flatMap((slot) => slot.stepContent),
    toolCalls: slots.flatMap((slot) => slot.toolCalls),
    toolResults: slots.flatMap((slot) => slot.toolResults),
    clientToolCallCount: clientCalls.length,
    settledClientToolCount: settledCount,
  };
}
