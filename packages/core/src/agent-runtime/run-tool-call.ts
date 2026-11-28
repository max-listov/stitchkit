import type {
  AgentModelAssistantContentPart,
  AgentModelMessage,
  AgentModelToolContentPart,
  AgentToolModelOutput,
} from '../agent-parts/model';
import type { AgentProviderEnvelope } from '../agent-parts/parts';
import type { LocalStepDurability } from '../durability/contract';
import { createLocalStepDurability } from '../durability/engine';
import { isAsyncIterable } from '../internal/typed';
import { isAgentToolError } from '../tools/agent-tool-error';
import {
  type AgentTool,
  type AgentToolCall,
  type AgentToolSet,
  finalizeAgentToolOutput,
} from '../tools/agent-tools';
import { isToolExecutionControlError } from '../tools/execute';
import type {
  AgentStepContentPart,
  AgentStepToolCall,
  AgentStepToolResult,
  AgentToolCallRepairFunction,
} from './models-driver-step';
import { isToolResultFailure } from './provider-failure';
import type { RunExecution } from './run-execution-state';
import { failureThisRuntimeOwns } from './run-failure';
import type { AgentLoopEvent } from './run-loop-events';
import { AgentInvalidToolInputError, AgentUnknownToolError } from './run-tool-errors';
import { createToolProgressReporter } from './run-tool-progress';
import { jsonValue } from './runtime-internals';

export interface RawProviderToolCall {
  readonly toolCallId: string;
  readonly toolName: string;
  readonly input: string;
  readonly providerExecuted?: boolean;
  readonly dynamic?: boolean;
  readonly provider?: AgentProviderEnvelope;
}

/** Deterministic per-call result slot assembled in original tool-call order. */
export interface CallSlotResult {
  assistantParts: AgentModelAssistantContentPart[];
  toolParts: AgentModelToolContentPart[];
  stepContent: AgentStepContentPart[];
  toolCalls: AgentStepToolCall[];
  toolResults: AgentStepToolResult[];
}

export interface StepExecutionCollector {
  settledClientToolCount: number;
  pendingExecutions: Promise<void>[];
  readonly awaitingApprovalEntities: Set<string>;
  readonly failedEntities: Set<string>;
  onFatalError?(error: unknown): void;
}

export function createCallSlotResult(): CallSlotResult {
  return {
    assistantParts: [],
    toolParts: [],
    stepContent: [],
    toolCalls: [],
    toolResults: [],
  };
}

/** Model-safe wire error text: echoes only typed tool/validation errors, never raw internal throws. */
export function safeToolErrorMessage(error: unknown): string {
  if (
    isAgentToolError(error) ||
    error instanceof AgentUnknownToolError ||
    error instanceof AgentInvalidToolInputError
  ) {
    return error.message;
  }
  return 'Tool execution failed';
}

function parseJsonArgs(
  raw: string,
): { ok: true; value: unknown } | { ok: false; error: unknown } {
  const trimmed = raw.trim();
  if (trimmed.length === 0) return { ok: true, value: {} };
  try {
    return { ok: true, value: JSON.parse(trimmed) };
  } catch (error) {
    return { ok: false, error };
  }
}

export function defaultToolWireOutput(output: unknown): AgentToolModelOutput {
  if (typeof output === 'string') return { type: 'text', value: output };
  return { type: 'json', value: jsonValue(output ?? null) };
}

function buildToolDurability<CONTEXT, TOOLS extends AgentToolSet>(
  execution: RunExecution<CONTEXT, TOOLS>,
  toolName: string,
  toolCallId: string,
  signal: AbortSignal | undefined,
): LocalStepDurability | undefined {
  const { config } = execution.dependencies;
  if (!config.durability) return undefined;
  const { state } = execution;
  if (typeof config.durability === 'function') {
    return config.durability({
      store: config.store,
      conversationId: state.run.conversationId,
      runId: state.run.id,
      toolName,
      toolCallId,
      signal,
    });
  }
  return createLocalStepDurability({
    store: config.store,
    conversationId: state.run.conversationId,
    runId: JSON.stringify([state.run.id, toolName, toolCallId]),
    signal,
  });
}

export async function resolveToolCallInput(input: {
  raw: RawProviderToolCall;
  tools: AgentToolSet;
  activeTools: readonly string[];
  messages: readonly AgentModelMessage[];
  repairToolCall: AgentToolCallRepairFunction | undefined;
}): Promise<
  | { ok: true; toolName: string; tool: AgentTool; parsedInput: unknown }
  | {
      ok: false;
      kind: 'unknown-tool' | 'invalid-input';
      toolName: string;
      parsedInput: unknown;
      error: AgentUnknownToolError | AgentInvalidToolInputError;
    }
> {
  const activeSet = new Set(input.activeTools);
  const attemptResolve = async (
    name: string,
    rawArgs: string,
  ): Promise<
    | { ok: true; toolName: string; tool: AgentTool; parsedInput: unknown }
    | {
        ok: false;
        kind: 'unknown-tool' | 'invalid-input';
        toolName: string;
        parsedInput: unknown;
        error: AgentUnknownToolError | AgentInvalidToolInputError;
      }
  > => {
    const tool =
      activeSet.has(name) && Object.hasOwn(input.tools, name) ? input.tools[name] : undefined;
    if (!tool) {
      return {
        ok: false,
        kind: 'unknown-tool',
        toolName: name,
        parsedInput: rawArgs,
        error: new AgentUnknownToolError(name, { activeTools: input.activeTools }),
      };
    }
    const json = parseJsonArgs(rawArgs);
    if (!json.ok) {
      return {
        ok: false,
        kind: 'invalid-input',
        toolName: name,
        parsedInput: rawArgs,
        error: new AgentInvalidToolInputError(name, {
          reason: 'invalid-json',
          cause: json.error,
        }),
      };
    }
    if (tool.parseInput) {
      const checked = await tool.parseInput(json.value);
      if (!checked.ok) {
        return {
          ok: false,
          kind: 'invalid-input',
          toolName: name,
          parsedInput: json.value,
          error: new AgentInvalidToolInputError(name, {
            reason: 'validation-failed',
            cause: checked.error,
          }),
        };
      }
      return { ok: true, toolName: name, tool, parsedInput: checked.value };
    }
    return { ok: true, toolName: name, tool, parsedInput: json.value };
  };

  const first = await attemptResolve(input.raw.toolName, input.raw.input);
  if (first.ok || !input.repairToolCall) return first;
  const repaired = await input.repairToolCall({
    toolCall: {
      toolCallId: input.raw.toolCallId,
      toolName: input.raw.toolName,
      input: input.raw.input,
    },
    activeTools: input.activeTools,
    tools: input.tools,
    messages: input.messages,
    error: { kind: first.kind, toolName: first.toolName, cause: first.error },
  });
  if (!repaired) return first;
  // Repaired calls remain bound by `activeTools` so a repair hook cannot bypass inactive-tool fencing.
  return attemptResolve(repaired.toolName, repaired.input);
}

export async function runSingleToolExecution<CONTEXT, TOOLS extends AgentToolSet>(input: {
  execution: RunExecution<CONTEXT, TOOLS>;
  tool: AgentTool;
  toolName: string;
  toolCallId: string;
  parsedInput: unknown;
  messages: readonly AgentModelMessage[];
  signal: AbortSignal;
  waitAhead: () => Promise<void>;
  settle: (ok?: boolean) => void;
  emit: (event: AgentLoopEvent) => Promise<void>;
}): Promise<
  | { ok: true; output: unknown; wireOutput: AgentToolModelOutput }
  | { ok: false; error: unknown; wireOutput: AgentToolModelOutput }
> {
  const { execution, tool, toolName, toolCallId, parsedInput, messages, signal, emit } = input;
  const execute = tool.execute;
  if (typeof execute !== 'function') {
    input.settle(false);
    const message = `Tool "${toolName}" is not executable`;
    return {
      ok: false,
      error: new Error(message),
      wireOutput: { type: 'error-text', value: message },
    };
  }
  const durability = buildToolDurability(execution, toolName, toolCallId, signal);
  const call: AgentToolCall = {
    toolCallId,
    messages,
    abortSignal: signal,
    ...(durability !== undefined && { durability }),
    reportProgress: createToolProgressReporter(execution, toolName, toolCallId, signal),
  };

  let outcome:
    | { ok: true; output: unknown; wireOutput: AgentToolModelOutput }
    | { ok: false; error: unknown; wireOutput: AgentToolModelOutput };
  let succeeded = false;
  try {
    await input.waitAhead();
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
        await emit({
          type: 'tool-result',
          toolCallId,
          toolName,
          input: parsedInput,
          output: chunk,
          preliminary: true,
        });
      }
      signal.throwIfAborted();
      finalValue = last;
    }
    finalValue = finalizeAgentToolOutput(tool, finalValue, wasAsyncIterable);
    const wireOutput = tool.toModelOutput
      ? await tool.toModelOutput({ toolCallId, input: parsedInput, output: finalValue })
      : defaultToolWireOutput(finalValue);
    signal.throwIfAborted();
    succeeded = !isToolResultFailure(finalValue);
    outcome = { ok: true, output: finalValue, wireOutput };
  } catch (error) {
    if (
      failureThisRuntimeOwns(error) !== undefined ||
      signal.aborted ||
      isToolExecutionControlError(error)
    ) {
      if (isToolExecutionControlError(error)) {
        await emit({
          type: 'tool-error',
          toolCallId,
          toolName,
          input: parsedInput,
          error,
        });
      }
      throw error;
    }
    outcome = {
      ok: false,
      error,
      wireOutput: { type: 'error-text', value: safeToolErrorMessage(error) },
    };
  } finally {
    input.settle(succeeded);
  }

  signal.throwIfAborted();
  // Emit terminal tool-result / tool-error outside tool try/catch so store/CAS failures propagate.
  if (outcome.ok) {
    await emit({
      type: 'tool-result',
      toolCallId,
      toolName,
      input: parsedInput,
      output: outcome.output,
      preliminary: false,
    });
  } else {
    await emit({
      type: 'tool-error',
      toolCallId,
      toolName,
      input: parsedInput,
      error: outcome.error,
    });
  }
  return outcome;
}
