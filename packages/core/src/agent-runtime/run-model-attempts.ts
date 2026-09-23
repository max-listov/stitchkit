import { setTimeout as delay } from 'node:timers/promises';
import {
  type Instructions,
  type LanguageModelCallStartEvent,
  type ModelMessage,
  type PrepareStepFunction,
  type StopCondition,
  stepCountIs,
  type TextStreamPart,
  type ToolSet,
} from 'ai';
import { createLocalStepDurability } from '../durability/engine';
import { streamAgentTextBoundary } from '../internal/ai-sdk-typed';
import { createToolDurabilityContext } from '../tools/durability-context';
import { deferredToolRepair } from './deferred-tools-internal';
import type { AgentInjectableInput } from './injection';
import { ownedProviderStream } from './owned-provider-stream';
import { classifyProviderFailure } from './provider-failure';
import { recordAgentRetryDecision } from './retry-policy';
import {
  billedUsage,
  checkpoint,
  type RunExecution,
  transientSequence,
} from './run-execution-state';
import { failureThisRuntimeOwns } from './run-failure';
import { createRunProviderLedger, type RunProviderLedger } from './run-provider-ledger';
import {
  applyStreamPart,
  isOutputPart,
  STRUCTURAL_BOUNDARY_PARTS,
  type StreamPartScope,
} from './run-stream-parts';
import type { PreparedTurn } from './run-turn-preparation';
import { addUsage, normalizeSdkUsage } from './runtime-internals';

/** What outlives one provider attempt: the retry count and what the SDK carries forward. */
interface AttemptLoopState {
  retryAttempt: number;
  /**
   * What the current attempt took from the injection registry.
   *
   * `take` removes an entry, so a retry that starts over from `history`
   * would run without it — and the terminal would still absorb it, marking
   * a person's input answered by a model that never saw it. The retry
   * hands these back before its first step.
   */
  takenThisAttempt: AgentInjectableInput[];
  /** The last `prepareStep` override of the instructions, which the SDK carries forward. */
  instructionsOverride: unknown;
}

/** One provider attempt: a stream from the first step to `finish`, or to a retry. */
interface ModelAttempt {
  readonly providerAttempt: number;
  readonly attemptPartStart: number;
  retrying: boolean;
  // Once a retry is decided the rest of this attempt's stream is drained
  // for its `finish-step` only: the provider bills those tokens whether
  // or not the answer was kept, so they belong in this run's spend.
  draining: boolean;
  readonly attemptAbort: AbortController;
}

/** Everything one attempt's phases share for the whole run. */
interface AttemptContext<CONTEXT, TOOLS extends ToolSet> {
  execution: RunExecution<CONTEXT, TOOLS>;
  turn: PreparedTurn<CONTEXT, TOOLS>;
  loop: AttemptLoopState;
  ledger: RunProviderLedger;
}

function createStopConditions<CONTEXT, TOOLS extends ToolSet>(
  execution: RunExecution<CONTEXT, TOOLS>,
): StopCondition<TOOLS>[] {
  const { config, maxSteps } = execution.dependencies;
  const { state } = execution;
  const maxStepCondition = stepCountIs(maxSteps);
  const stopConditions: StopCondition<TOOLS>[] = [
    async (options) => {
      const stopped = await maxStepCondition(options);
      if (stopped && state.terminalPolicyName === undefined)
        state.terminalPolicyName = 'max-steps';
      return stopped;
    },
  ];
  for (const policy of config.loop?.stopPolicies ?? []) {
    stopConditions.push(async (options) => {
      const stopped = await policy.when(options);
      if (stopped && state.terminalPolicyName === undefined)
        state.terminalPolicyName = policy.name;
      return stopped;
    });
  }
  return stopConditions;
}

/** What this boundary takes on, projected for the provider. */
async function takeInjectedMessages<CONTEXT, TOOLS extends ToolSet>(
  context: AttemptContext<CONTEXT, TOOLS>,
): Promise<ModelMessage[]> {
  const { execution, turn, loop } = context;
  const { state } = execution;
  const taken =
    execution.dependencies.injection?.take(execution.input.key, state.run.id) ?? [];
  if (taken.length === 0) return [];
  loop.takenThisAttempt.push(...taken);
  const messages: ModelMessage[] = [];
  for (const entry of taken) {
    // Only this admission's own message, never a re-projection of the
    // snapshot — and through `projectInputs`, which does not touch
    // `carriedSystem`. The withdrawn version re-projected the whole
    // snapshot, so an unrelated queued input reached a run that never
    // recorded it and was then answered a second time by its own run.
    messages.push(...(await turn.projection.projectInputs([entry.input])));
    // Keyed by run, and it grows: `coalescePending` can add an input to a
    // successor after an earlier boundary already took one of its
    // inputs, and the absorption is only committed if it covers the
    // successor WHOLE. Re-taking at every boundary is what keeps it
    // whole; only an input that arrives after the last boundary is left
    // behind, and that one simply runs on its own.
    const ids = state.absorbed.get(entry.runId) ?? [];
    ids.push(entry.input.id);
    state.absorbed.set(entry.runId, ids);
  }
  return messages;
}

async function prepareAttemptStep<CONTEXT, TOOLS extends ToolSet>(
  context: AttemptContext<CONTEXT, TOOLS>,
  attempt: ModelAttempt,
  options: Parameters<PrepareStepFunction<TOOLS>>[0],
) {
  const { execution, turn, loop, ledger } = context;
  const { config, generateId } = execution.dependencies;
  const { state } = execution;
  // The SDK can prepare the next step before the consumer has read
  // that previous step's `finish-step` stream part. Derive the
  // provider-reported fill from the completed step the SDK hands us,
  // rather than depending on stream-consumer scheduling.
  const previousStep = options.steps.at(-1);
  if (previousStep) {
    state.lastPromptTokens =
      state.selectedModel?.normalizeUsage?.({
        usage: previousStep.usage,
        providerMetadata: previousStep.providerMetadata,
      })?.inputTokens ?? normalizeSdkUsage(previousStep.usage).inputTokens;
  }
  const prepared = await config.loop?.prepareStep?.({
    ...options,
    ...turn.runtimeContext,
  });
  const injected = await takeInjectedMessages(context);
  // The SDK carries a `prepareStep` message list into the next step,
  // so appending only what was taken *this* boundary is right — and
  // appending the whole accumulated list would duplicate it.
  const preparedStep =
    injected.length === 0
      ? prepared
      : {
          ...prepared,
          messages: [...(prepared?.messages ?? options.messages), ...injected],
        };
  const providerMessages = preparedStep?.messages ?? options.messages;
  // After the previous step's checkpoint has landed (that is what
  // `prepareModel` waits for) and before `doStream`: the request is
  // recorded in ledger order, and the provider is not called until
  // it is.
  const model = await execution.operationLifecycle.prepareModel(
    preparedStep?.model ?? turn.selectedModel.model,
    options.stepNumber,
    generateId(),
  );
  // What the provider is told, not what the prompt composed: a
  // `prepareStep` may override `instructions`/`system`, and the SDK
  // carries that override into every later step of the call.
  const override = preparedStep as { instructions?: unknown; system?: unknown } | undefined;
  if (override?.instructions !== undefined) loop.instructionsOverride = override.instructions;
  else if (override?.system !== undefined) loop.instructionsOverride = override.system;
  await ledger.recordRequest({
    stepNumber: options.stepNumber,
    attempt: attempt.providerAttempt,
    instructions: (loop.instructionsOverride ??
      turn.projection.withCarriedSystem(turn.prompt.instructions)) as Instructions,
    messages: providerMessages,
  });
  return { ...preparedStep, model };
}

function startAttemptStream<CONTEXT, TOOLS extends ToolSet>(
  context: AttemptContext<CONTEXT, TOOLS>,
  attempt: ModelAttempt,
  stopConditions: StopCondition<TOOLS>[],
) {
  const { execution, turn } = context;
  const { config } = execution.dependencies;
  const { state, idleDeadline, operationLifecycle } = execution;
  const { tools } = turn;
  const attemptSignal = AbortSignal.any([
    execution.executionSignal,
    attempt.attemptAbort.signal,
  ]);
  return streamAgentTextBoundary<TOOLS>({
    model: turn.selectedModel.model,
    tools,
    ...(config.durability && {
      toolsContext: Object.fromEntries(
        Object.keys(tools).map((toolName) => [
          toolName,
          createToolDurabilityContext((toolCallId, signal) => {
            const port = config.durability;
            if (typeof port === 'function')
              return port({
                store: config.store,
                conversationId: state.run.conversationId,
                runId: state.run.id,
                toolName,
                toolCallId,
                signal,
              });
            return createLocalStepDurability({
              store: config.store,
              conversationId: state.run.conversationId,
              runId: JSON.stringify([state.run.id, toolName, toolCallId]),
              signal,
            });
          }),
        ]),
      ),
    }),
    instructions: turn.projection.withCarriedSystem(turn.prompt.instructions),
    messages: turn.history,
    abortSignal: attemptSignal,
    maxRetries: 0,
    stopWhen: stopConditions,
    onLanguageModelCallStart: (event: LanguageModelCallStartEvent) => {
      idleDeadline.start();
      operationLifecycle.noteProviderCall(event.callId);
    },
    onLanguageModelCallEnd: () => idleDeadline.stop(),
    onToolExecutionStart: () => idleDeadline.suspend(),
    onToolExecutionEnd: () => idleDeadline.resume(),
    repairToolCall: deferredToolRepair(config.loop?.prepareStep),
    ...(config.loop?.toolApproval && {
      toolApproval: config.loop.toolApproval,
      runtimeContext: execution.input.context,
    }),
    ...(config.loop?.toolApprovalSecret && {
      experimental_toolApprovalSecret: config.loop.toolApprovalSecret,
    }),
    prepareStep: (options: Parameters<PrepareStepFunction<TOOLS>>[0]) =>
      prepareAttemptStep(context, attempt, options),
  });
}

/** A part of an attempt already being retried: only its spend is kept. */
async function drainAbandonedPart<CONTEXT, TOOLS extends ToolSet>(
  context: AttemptContext<CONTEXT, TOOLS>,
  attempt: ModelAttempt,
  part: TextStreamPart<TOOLS>,
): Promise<void> {
  if (part.type !== 'finish-step') return;
  const { state } = context.execution;
  await context.ledger.recordResponse({
    id: part.response.id,
    providerMetadata: part.providerMetadata,
    stepNumber: state.step,
    attempt: attempt.providerAttempt,
  });
  const failedStepUsage =
    context.turn.selectedModel.normalizeUsage?.({
      usage: part.usage,
      providerMetadata: part.providerMetadata,
    }) ?? normalizeSdkUsage(part.usage);
  state.abandonedUsage = state.abandonedUsage
    ? addUsage(state.abandonedUsage, failedStepUsage)
    : failedStepUsage;
  const billed = billedUsage(state);
  state.usage =
    state.nonModelUsage && billed
      ? addUsage(state.nonModelUsage, billed)
      : (billed ?? state.nonModelUsage);
}

/**
 * Whether a provider error part starts a retry. When it does, this attempt's
 * output is discarded, its injected inputs are handed back and the attempt
 * turns to draining.
 */
async function retryAfterProviderError<CONTEXT, TOOLS extends ToolSet>(
  context: AttemptContext<CONTEXT, TOOLS>,
  attempt: ModelAttempt,
  error: unknown,
): Promise<boolean> {
  const { execution, loop } = context;
  const { config, injection } = execution.dependencies;
  const { state, executionSignal } = execution;
  const retry = config.loop?.retry;
  if (!retry || failureThisRuntimeOwns(error) !== undefined) return false;
  const invokedTool = state.parts
    .slice(attempt.attemptPartStart)
    .some((candidate) => candidate.type === 'tool-call');
  const decision = invokedTool
    ? { retry: false, delayMs: 0 }
    : await recordAgentRetryDecision({
        store: config.store,
        conversationId: state.run.conversationId,
        attempt: loop.retryAttempt,
        failure: classifyProviderFailure(error),
        policy: retry,
      });
  if (!decision.retry) return false;
  await execution.operationLifecycle.finish('failed');
  state.parts.splice(attempt.attemptPartStart);
  // Hand back what this attempt took, and stop claiming it was
  // answered: the next attempt takes it again at its own boundary.
  for (const entry of loop.takenThisAttempt) {
    injection?.offer(execution.input.key, entry);
    const ids = state.absorbed.get(entry.runId);
    if (ids) {
      const kept = ids.filter((id) => id !== entry.input.id);
      if (kept.length === 0) state.absorbed.delete(entry.runId);
      else state.absorbed.set(entry.runId, kept);
    }
  }
  loop.takenThisAttempt = [];
  // Checkpoint after the splice: the durable draft must not carry
  // the output the retry is discarding.
  await checkpoint(execution);
  state.eventsSinceCheckpoint = 0;
  if (decision.delayMs > 0) {
    await delay(decision.delayMs, undefined, { signal: executionSignal });
  }
  loop.retryAttempt += 1;
  await config.store.appendEvent({
    conversationId: state.run.conversationId,
    kind: 'retry/started',
    payload: { attempt: loop.retryAttempt },
  });
  attempt.retrying = true;
  attempt.draining = true;
  return true;
}

async function consumeAttempt<CONTEXT, TOOLS extends ToolSet>(
  context: AttemptContext<CONTEXT, TOOLS>,
  attempt: ModelAttempt,
  stream: AsyncIterable<TextStreamPart<TOOLS>>,
): Promise<void> {
  const { execution, turn, ledger } = context;
  const { checkpointEveryEvents } = execution.dependencies;
  const { state, idleDeadline, operationLifecycle } = execution;
  const scope: StreamPartScope = {
    selectedModel: turn.selectedModel,
    ledger,
    providerAttempt: attempt.providerAttempt,
  };
  for await (const part of ownedProviderStream({
    stream,
    abort: () =>
      attempt.attemptAbort.abort(new Error('Agent runtime released provider stream')),
    onCleanupFailure: (error) => {
      state.providerStreamCleanupFailure = error;
    },
  })) {
    idleDeadline.touch();
    if (attempt.draining) {
      await drainAbandonedPart(context, attempt, part);
      continue;
    }
    state.eventsSinceCheckpoint += 1;
    if (
      part.type === 'error' &&
      (await retryAfterProviderError(context, attempt, part.error))
    ) {
      continue;
    }
    if (isOutputPart(part)) {
      if (state.firstOutputAt === undefined) state.firstOutputAt = performance.now();
      await operationLifecycle.firstOutput();
    }
    await applyStreamPart(execution, scope, part);
    const structuralBoundary = STRUCTURAL_BOUNDARY_PARTS.includes(part.type);
    if (structuralBoundary || state.eventsSinceCheckpoint >= checkpointEveryEvents) {
      await checkpoint(execution);
      state.eventsSinceCheckpoint = 0;
      if (part.type === 'finish-step') operationLifecycle.checkpointStep(state.step - 1);
    }
  }
}

/** Every provider attempt of the run, until one ends without being retried. */
export async function runModelAttempts<CONTEXT, TOOLS extends ToolSet>(
  execution: RunExecution<CONTEXT, TOOLS>,
  turn: PreparedTurn<CONTEXT, TOOLS>,
): Promise<void> {
  const { config, publish, now } = execution.dependencies;
  const { state } = execution;
  const stopConditions = createStopConditions(execution);
  const loop: AttemptLoopState = {
    retryAttempt: 1,
    takenThisAttempt: [],
    instructionsOverride: undefined,
  };
  const ledger = await createRunProviderLedger({
    store: config.store,
    state,
    selectedModel: turn.selectedModel,
  });
  const context: AttemptContext<CONTEXT, TOOLS> = { execution, turn, loop, ledger };
  for (;;) {
    const attempt: ModelAttempt = {
      providerAttempt: loop.retryAttempt,
      attemptPartStart: state.parts.length,
      retrying: false,
      draining: false,
      attemptAbort: new AbortController(),
    };
    const result = startAttemptStream(context, attempt, stopConditions);
    await consumeAttempt(context, attempt, result.stream);
    if (!attempt.retrying) break;
    // Subscribers drop what the failed attempt streamed before the next
    // attempt's first delta arrives.
    await publish({
      type: 'attempt-reset',
      conversationId: state.run.conversationId,
      runId: state.run.id,
      runtimeEpoch: execution.dependencies.runtimeEpoch,
      sequence: transientSequence(state),
      attempt: loop.retryAttempt,
      emittedAt: now().toISOString(),
    });
  }
}
