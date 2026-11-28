import type { z } from 'zod';
import {
  type AgentInstructions,
  type AgentModelMessage,
  type AgentModelResponseFormat,
  AgentModelResponseFormatSchema,
  normalizeAgentInstructions,
} from '../agent-parts/model';
import { assertTimerMs } from '../internal/deadline';
import { assertPositiveSafeInteger } from '../internal/positive-integer';
import { isRecord } from '../internal/typed';
import { type AgentToolSet, zodToAgentInputJsonSchema } from '../tools/agent-tools';
import type { AgentModelRequest, AgentModelToolSpec } from './models-driver';
import type { AgentPrepareStepResult, AgentStepResult } from './models-driver-step';
import { AgentProviderStreamCutError } from './provider-failure';
import { stripStrictOptionalNulls } from './provider-json-schema';
import { markProviderOrigin } from './provider-origin';
import { assertAgentRetryPolicy } from './retry-policy';
import { runStepModelCallWithRetry } from './run-complete-retry';
import { createCompleteTextStream } from './run-complete-stream';
import { runStandaloneClientTools } from './run-complete-tools';
import {
  type AgentCompleteStopPolicy,
  AgentStructuredOutputError,
  type CompleteObjectInput,
  type CompleteObjectResult,
  type CompleteStreamPart,
  type CompleteTextInput,
  type CompleteTextResult,
  type CompleteTextStream,
} from './run-complete-types';
import {
  assembleStepResult,
  buildActiveToolSpecs,
  buildStepTimings,
  isStepUnsafeForClientTools,
  mergeStepCallSettings,
} from './run-step-helpers';
import { emptyStepToolExecutionResult } from './run-tool-executor';
import { addUsage } from './runtime-internals';
import type { AgentUsage } from './schemas';
import { statedUsage, unknownUsage } from './schemas-usage-state';

const LITERAL_SCHEMA_KEYS = new Set(['const', 'default', 'examples', 'enum']);
const SCHEMA_MAP_KEYS = new Set([
  'properties',
  '$defs',
  'definitions',
  'patternProperties',
  'dependentSchemas',
]);

function resolveInitialMessages(input: {
  readonly prompt?: string;
  readonly messages?: readonly AgentModelMessage[];
}): AgentModelMessage[] {
  if (input.prompt !== undefined && input.messages !== undefined) {
    throw new TypeError('completeText accepts either prompt or messages, not both');
  }
  if (input.messages !== undefined) return [...input.messages];
  if (input.prompt !== undefined) return [{ role: 'user', content: input.prompt }];
  throw new TypeError('completeText requires either prompt or messages');
}

function assertCompleteStopPolicies(
  policies: readonly AgentCompleteStopPolicy[] | undefined,
): void {
  if (!policies) return;
  const names = new Set<string>();
  for (const policy of policies) {
    if (!policy.name || names.has(policy.name)) {
      throw new TypeError('completeText stop policy names must be non-empty and unique');
    }
    names.add(policy.name);
  }
}

type EmitCompletePart = (
  part: CompleteStreamPart,
  waitSignal?: AbortSignal,
) => void | Promise<void>;

function buildCompleteStepRequest<TOOLS extends AgentToolSet>(params: {
  readonly input: CompleteTextInput<TOOLS>;
  readonly prepared: AgentPrepareStepResult<TOOLS> | undefined;
  readonly stepInstructions: AgentInstructions;
  readonly currentMessages: readonly AgentModelMessage[];
  readonly specs: readonly AgentModelToolSpec[];
  readonly defaultConversationId: string;
  readonly callId: string;
  readonly stepNumber: number;
}): AgentModelRequest {
  const { input, prepared, stepInstructions, currentMessages, specs } = params;
  const toolChoice = prepared?.toolChoice ?? input.toolChoice;
  const responseFormat = prepared?.responseFormat ?? input.responseFormat;
  const cacheControl = prepared?.cacheControl ?? input.cacheControl;
  const providerOptions = prepared?.providerOptions ?? input.providerOptions;
  const headers = prepared?.headers ?? input.headers;
  return {
    instructions: normalizeAgentInstructions(stepInstructions),
    messages: currentMessages,
    tools: specs,
    ...(toolChoice !== undefined && { toolChoice }),
    ...(responseFormat !== undefined && { responseFormat }),
    ...(cacheControl !== undefined && { cacheControl }),
    settings: mergeStepCallSettings(input.settings, prepared),
    ...(providerOptions !== undefined && { providerOptions }),
    ...(headers !== undefined && { headers }),
    correlation: {
      conversationId: params.defaultConversationId,
      ...(input.correlation?.runId !== undefined && { runId: input.correlation.runId }),
      ...(input.correlation?.invocationId !== undefined && {
        invocationId: input.correlation.invocationId,
      }),
      attemptId: input.correlation?.attemptId ?? params.callId,
      step: params.stepNumber,
    },
  };
}

async function finalizeCompleteResult(params: {
  readonly steps: readonly AgentStepResult[];
  readonly responseMessages: readonly AgentModelMessage[];
  readonly totalUsage: AgentUsage | undefined;
  readonly stoppedByPolicy: string | undefined;
  readonly emitPart: EmitCompletePart | undefined;
  readonly effectiveSignal: AbortSignal | undefined;
}): Promise<CompleteTextResult> {
  const { steps, responseMessages, totalUsage, stoppedByPolicy, emitPart, effectiveSignal } =
    params;
  const lastStep = steps.at(-1);
  const finalUsage = statedUsage(totalUsage ?? unknownUsage());
  const finalFinishReason = lastStep?.finishReason ?? 'other';
  await emitPart?.(
    {
      type: 'finish',
      finishReason: finalFinishReason,
      ...(lastStep?.rawFinishReason !== undefined && {
        rawFinishReason: lastStep.rawFinishReason,
      }),
      usage: finalUsage,
      ...(lastStep !== undefined && {
        response: {
          id: lastStep.response.id,
          ...(lastStep.response.modelId !== undefined && {
            modelId: lastStep.response.modelId,
          }),
          ...(lastStep.response.timestamp !== undefined && {
            timestamp: lastStep.response.timestamp,
          }),
        },
      }),
    },
    effectiveSignal,
  );
  return {
    text: lastStep?.text ?? '',
    finishReason: finalFinishReason,
    ...(lastStep?.rawFinishReason !== undefined && {
      rawFinishReason: lastStep.rawFinishReason,
    }),
    usage: finalUsage,
    steps,
    responseMessages,
    ...(stoppedByPolicy !== undefined && { stoppedByPolicy }),
  };
}

async function runCompleteLoop<TOOLS extends AgentToolSet>(
  input: CompleteTextInput<TOOLS>,
  emitPart: EmitCompletePart | undefined,
  effectiveSignal: AbortSignal | undefined,
): Promise<CompleteTextResult> {
  const tools = input.tools;
  const declaredTools = tools ? Object.keys(tools) : [];
  const maxSteps = input.maxSteps ?? (declaredTools.length > 0 ? 10 : 1);
  assertPositiveSafeInteger('completeText.maxSteps', maxSteps, RangeError);
  assertTimerMs('completeText.idleTimeoutMs', input.idleTimeoutMs);
  if (input.retry) assertAgentRetryPolicy('completeText.retry', input.retry);
  assertCompleteStopPolicies(input.stopPolicies);

  const initialMessages = resolveInitialMessages(input);
  const initialInstructions: AgentInstructions = input.instructions ?? '';
  const defaultConversationId = input.correlation?.conversationId ?? crypto.randomUUID();

  let currentMessages: AgentModelMessage[] = [...initialMessages];
  let activeDriver = input.driver;
  const responseMessages: AgentModelMessage[] = [];
  const steps: AgentStepResult[] = [];
  let totalUsage: AgentUsage | undefined;
  let stoppedByPolicy: string | undefined;

  for (let stepNumber = 0; stepNumber < maxSteps; stepNumber += 1) {
    effectiveSignal?.throwIfAborted();
    const prepared =
      (await input.prepareStep?.({
        stepNumber,
        steps,
        messages: currentMessages,
        responseMessages,
        initialMessages,
        initialInstructions,
        instructions: initialInstructions,
        driver: activeDriver,
        activeTools: declaredTools,
      })) ?? undefined;

    currentMessages = [...(prepared?.messages ?? currentMessages)];
    const stepInstructions = prepared?.instructions ?? initialInstructions;
    const { activeNames, specs } = tools
      ? buildActiveToolSpecs(tools, prepared?.activeTools)
      : { activeNames: [], specs: [] };
    const effectiveDriver = prepared?.driver ?? activeDriver;
    activeDriver = effectiveDriver;
    const callId = crypto.randomUUID();
    const request = buildCompleteStepRequest({
      input,
      prepared,
      stepInstructions,
      currentMessages,
      specs,
      defaultConversationId,
      callId,
      stepNumber,
    });

    const callOutcome = await runStepModelCallWithRetry({
      driver: effectiveDriver,
      request,
      signal: effectiveSignal,
      idleTimeoutMs: input.idleTimeoutMs,
      retry: input.retry,
      onAttemptDiscarded: input.onAttemptDiscarded,
      onPart: emitPart,
      priorUsage: totalUsage,
    });
    if (callOutcome.discardedUsage !== undefined) {
      totalUsage = addUsage(totalUsage, callOutcome.discardedUsage);
    }

    const { consumed, stepStartedAt, responseFinishedAt } = callOutcome;
    const finishPart = consumed.finishPart;
    if (!finishPart) {
      throw markProviderOrigin(
        new AgentProviderStreamCutError('Provider stream ended without a finish event', {
          provider: effectiveDriver.provider,
        }),
      );
    }

    const unsafeForClientTools = isStepUnsafeForClientTools(
      finishPart.finishReason,
      consumed.sawErrorPart,
    );
    const toolStartedAt = performance.now();
    const toolExecution =
      unsafeForClientTools || !tools
        ? emptyStepToolExecutionResult()
        : await runStandaloneClientTools({
            rawCalls: consumed.rawToolCalls,
            tools,
            activeTools: activeNames,
            repairToolCall: input.repairToolCall,
            messages: currentMessages,
            signal: effectiveSignal ?? new AbortController().signal,
            ...(emitPart !== undefined && { onPart: emitPart }),
          });
    const stepFinishedAt = performance.now();
    const toolExecutionMs =
      unsafeForClientTools || !tools ? 0 : Math.max(0, stepFinishedAt - toolStartedAt);
    const timings = buildStepTimings({
      stepStartedAt,
      responseFinishedAt,
      stepFinishedAt,
      firstOutputAt: consumed.firstOutputAt,
      toolExecutionMs,
      outputChunkTimestamps: consumed.outputChunkTimestamps,
    });

    const stepUsage = statedUsage(finishPart.usage);
    totalUsage = addUsage(totalUsage, stepUsage);
    const { stepResponseMessages, stepResult } = assembleStepResult({
      stepNumber,
      callId,
      model: { provider: effectiveDriver.provider, modelId: effectiveDriver.modelId },
      consumed,
      finishPart,
      toolExecution,
      timings,
      stepUsage,
    });
    currentMessages = [...currentMessages, ...stepResponseMessages];
    responseMessages.push(...stepResponseMessages);
    steps.push(stepResult);
    await emitPart?.({ type: 'finish-step', step: stepResult }, effectiveSignal);
    await input.onStepFinish?.(stepResult);

    const canContinue =
      !unsafeForClientTools &&
      toolExecution.clientToolCallCount > 0 &&
      toolExecution.settledClientToolCount === toolExecution.clientToolCallCount;
    if (!canContinue) break;

    let halted = false;
    for (const policy of input.stopPolicies ?? []) {
      if (await policy.when({ steps })) {
        stoppedByPolicy = policy.name;
        halted = true;
        break;
      }
    }
    if (halted) break;
  }

  return finalizeCompleteResult({
    steps,
    responseMessages,
    totalUsage,
    stoppedByPolicy,
    emitPart,
    effectiveSignal,
  });
}

/**
 * Peer-free single- or multi-step completion over any `AgentModelDriver` (no store required).
 * Supports multimodal messages, tools, `maxSteps`, `retry`, `stopPolicies`, `idleTimeoutMs`,
 * `onPart` streaming, `prepareStep`, `responseFormat`, `cacheControl`, and structured timings.
 */
export async function completeText<TOOLS extends AgentToolSet = AgentToolSet>(
  input: CompleteTextInput<TOOLS>,
): Promise<CompleteTextResult> {
  const onPart = input.onPart;
  return runCompleteLoop(input, onPart ? (part) => onPart(part) : undefined, input.signal);
}

/**
 * Peer-free streaming single- or multi-step completion over any `AgentModelDriver`
 * (no `AgentRuntimeStore` required). Yields every model stream part, validated client tool
 * call/result/error, `attempt-reset`, `finish-step`, and final `finish` through a bounded
 * backpressure queue and resolves `result` upon settlement.
 */
export function streamComplete<TOOLS extends AgentToolSet = AgentToolSet>(
  input: CompleteTextInput<TOOLS>,
): CompleteTextStream {
  return createCompleteTextStream(input, runCompleteLoop);
}

function closeStrictObjectNodes(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(closeStrictObjectNodes);
  if (!isRecord(value)) return value;
  const out: Record<string, unknown> = {};
  for (const [key, entry] of Object.entries(value)) {
    if (LITERAL_SCHEMA_KEYS.has(key)) {
      out[key] = entry;
    } else if (SCHEMA_MAP_KEYS.has(key) && isRecord(entry)) {
      const mapped: Record<string, unknown> = {};
      for (const [subKey, subEntry] of Object.entries(entry)) {
        mapped[subKey] = closeStrictObjectNodes(subEntry);
      }
      out[key] = mapped;
    } else {
      out[key] = closeStrictObjectNodes(entry);
    }
  }
  if (
    out.type === 'object' &&
    isRecord(out.properties) &&
    out.additionalProperties === undefined
  ) {
    out.additionalProperties = false;
  }
  return out;
}

/**
 * Peer-free structured-output completion over any `AgentModelDriver` (no store required).
 *
 * Projects the Zod schema through canonical `toJsonSchema(schema, 'input')`, strips
 * strict-mode optional `null`s prior to `schema.safeParse`, validates `schemaName`, and
 * raises typed `AgentStructuredOutputError` with full `steps` and `usage` on failure.
 */
export async function completeObject<
  TSchema extends z.ZodType,
  TOOLS extends AgentToolSet = AgentToolSet,
>(
  input: CompleteObjectInput<TSchema, TOOLS>,
): Promise<CompleteObjectResult<z.infer<TSchema>>> {
  const { schema, schemaName, schemaDescription, strict, ...rest } = input;
  const effectiveStrict = strict ?? true;
  const jsonSchema = zodToAgentInputJsonSchema(schema);
  const wireSchema = effectiveStrict ? closeStrictObjectNodes(jsonSchema) : jsonSchema;
  const responseFormat: AgentModelResponseFormat = AgentModelResponseFormatSchema.parse({
    type: 'json-schema',
    name: schemaName ?? 'output',
    schema: isRecord(wireSchema) ? wireSchema : jsonSchema,
    ...(schemaDescription !== undefined && { description: schemaDescription }),
    strict: effectiveStrict,
  });
  const textInput: CompleteTextInput<TOOLS> =
    rest.prompt !== undefined
      ? { ...rest, prompt: rest.prompt, responseFormat }
      : { ...rest, messages: rest.messages, responseFormat };
  const result = await completeText(textInput);
  const baseDetails = {
    finishReason: result.finishReason,
    rawText: result.text,
    usage: result.usage,
    steps: result.steps,
  };

  if (result.finishReason === 'length') {
    throw new AgentStructuredOutputError(
      'Structured output was truncated before completion (finishReason: length)',
      { ...baseDetails, reason: 'truncated' },
    );
  }
  if (result.finishReason === 'tool-calls') {
    throw new AgentStructuredOutputError(
      'Structured output did not complete before step limit or stop policy (finishReason: tool-calls)',
      { ...baseDetails, reason: 'tool-calls' },
    );
  }
  if (result.finishReason === 'content-filter') {
    throw new AgentStructuredOutputError(
      'Structured output was blocked by content filter (finishReason: content-filter)',
      { ...baseDetails, reason: 'content-filter' },
    );
  }
  if (result.finishReason === 'error') {
    throw new AgentStructuredOutputError(
      'Structured output stopped due to a provider error (finishReason: error)',
      { ...baseDetails, reason: 'provider-error' },
    );
  }
  if (result.finishReason === 'interrupted') {
    throw new AgentStructuredOutputError(
      'Structured output was interrupted before completion (finishReason: interrupted)',
      { ...baseDetails, reason: 'interrupted' },
    );
  }
  const trimmed = result.text.trim();
  if (trimmed.length === 0) {
    throw new AgentStructuredOutputError('Structured output was empty', {
      ...baseDetails,
      reason: 'empty',
    });
  }
  let parsedJson: unknown;
  try {
    parsedJson = JSON.parse(trimmed);
  } catch (cause) {
    throw new AgentStructuredOutputError('Structured output is not valid JSON', {
      ...baseDetails,
      reason: 'invalid-json',
      cause,
    });
  }
  const normalizedJson = effectiveStrict
    ? stripStrictOptionalNulls(parsedJson, jsonSchema)
    : parsedJson;
  const validated = schema.safeParse(normalizedJson);
  if (!validated.success) {
    throw new AgentStructuredOutputError('Structured output failed schema validation', {
      ...baseDetails,
      reason: 'schema-mismatch',
      cause: validated.error,
    });
  }
  return { ...result, object: validated.data };
}
