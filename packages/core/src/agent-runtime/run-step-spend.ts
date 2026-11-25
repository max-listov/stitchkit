import type { LanguageModelUsage, ToolSet } from 'ai';
import { z } from 'zod';
import { AgentRecordIdSchema } from '../durability/events';
import { withDeadline } from '../internal/deadline';
import { ModelInvocationTraceSchema } from './invocation-schema';
import type { AgentResolvedModel } from './models';
import { type RunExecution, runUsage } from './run-execution-state';
import type { RunProviderLedger } from './run-provider-ledger';
import { addUsage, normalizeSdkUsage, statedUsage } from './runtime-internals';
import { AgentProviderResponseSchema, type AgentUsage, AgentUsageSchema } from './schemas';

/** Default timeout (ms) for awaiting `AgentRuntimeConfig.onStepSpend`. */
export const DEFAULT_STEP_SPEND_TIMEOUT_MS = 5_000;

/**
 * Which lifecycle phase produced a billed step spend fact: a completed model
 * step (`step`), a retried attempt whose output was discarded after billing
 * (`abandoned-attempt`), or a history compaction call (`compaction`).
 */
export const AgentStepSpendPhaseSchema = z.enum(['step', 'abandoned-attempt', 'compaction']);

/** Lifecycle phase of one billed step spend fact. */
export type AgentStepSpendPhase = z.infer<typeof AgentStepSpendPhaseSchema>;

/**
 * Provider identity for a billed step: the key registered in the model
 * registry and, when `resolveResponseProvider` reports it, the upstream
 * provider that answered.
 */
export const AgentStepSpendProviderSchema = z.strictObject({
  /** Provider key from the resolved model descriptor. */
  key: z.string().min(1),
  /** Upstream provider reported by `resolveResponseProvider`, when available. */
  upstream: z.string().min(1).optional(),
});

/** Canonical fact emitted once per billed step, abandoned retry attempt, or compaction. */
const StepSpendBaseShape = {
  conversationId: AgentRecordIdSchema,
  runId: AgentRecordIdSchema,
  /** The model step this spend belongs to; a compaction carries the step it prepared. */
  step: z.int().nonnegative(),
  /** Which try produced this spend, counted from one: `2` is the first retry. */
  attempt: z.int().nonnegative(),
  usage: AgentUsageSchema,
  trace: ModelInvocationTraceSchema.optional(),
};

/** Spend of a provider answer: a completed step or an attempt discarded after billing. */
const ModelStepSpendShape = {
  ...StepSpendBaseShape,
  model: z.string().min(1),
  provider: AgentStepSpendProviderSchema,
  response: AgentProviderResponseSchema,
};

/**
 * Canonical fact emitted once per billed step, abandoned retry attempt, or compaction.
 * `phase` says which: a model phase always names its model, provider and response, and a
 * compaction, which the application's own callback performed, names none of them.
 */
export const AgentStepSpendSchema = z.discriminatedUnion('phase', [
  z.strictObject({ ...ModelStepSpendShape, phase: z.literal('step') }),
  z.strictObject({ ...ModelStepSpendShape, phase: z.literal('abandoned-attempt') }),
  z.strictObject({ ...StepSpendBaseShape, phase: z.literal('compaction') }),
]);

/** Canonical fact delivered to `AgentRuntimeConfig.onStepSpend` and `step-finished` observability. */
export type AgentStepSpend = z.infer<typeof AgentStepSpendSchema>;

/** Narrow view of a stream `finish-step` part needed to record spend. */
export interface StepSpendFinishPart {
  readonly response: { readonly id: string };
  readonly usage: LanguageModelUsage;
  readonly providerMetadata?: unknown;
}

/** Input to `recordStepSpend` for one model step, abandoned attempt, or compaction call. */
export type RecordStepSpendInput =
  | {
      phase: 'step';
      part: StepSpendFinishPart;
      attempt: number;
      selectedModel: AgentResolvedModel;
      ledger: RunProviderLedger;
    }
  | {
      phase: 'abandoned-attempt';
      part: StepSpendFinishPart;
      attempt: number;
      selectedModel: AgentResolvedModel;
      ledger: RunProviderLedger;
    }
  | {
      phase: 'compaction';
      usage: AgentUsage;
      attempt: number;
    };

/**
 * Normalize one step's usage through the resolved model adapter when it
 * provides `normalizeUsage`, falling back to SDK usage normalization.
 */
export function normalizeStepUsage(
  selectedModel: AgentResolvedModel | undefined,
  usage: LanguageModelUsage,
  providerMetadata?: unknown,
): AgentUsage {
  return (
    selectedModel?.normalizeUsage?.({
      usage,
      providerMetadata,
    }) ?? normalizeSdkUsage(usage)
  );
}

/** Why a spend hook did not finish: it threw, or it outlived `stepSpendTimeoutMs`. */
interface StepSpendHookFailure {
  code: 'hook_error' | 'hook_timeout';
  cause: unknown;
}

/**
 * Call one spend hook within `stepSpendTimeoutMs`.
 *
 * The one bound for `onStepSpend` and for its reporter `onStepSpendError`: a
 * store that hangs the hook usually hangs its reporter too, and the run waits
 * on neither past the timeout. A hook left behind at the timeout is detached,
 * and its late rejection is not an unhandled one.
 */
async function callStepSpendHook(
  name: 'onStepSpend' | 'onStepSpendError',
  timeoutMs: number,
  call: () => void | Promise<void>,
): Promise<StepSpendHookFailure | undefined> {
  let pending: Promise<void>;
  try {
    pending = Promise.resolve(call());
  } catch (error) {
    return { code: 'hook_error', cause: error };
  }
  try {
    if ((await withDeadline(pending, timeoutMs)).settled) return undefined;
  } catch (error) {
    return { code: 'hook_error', cause: error };
  }
  void pending.catch(() => undefined);
  return {
    code: 'hook_timeout',
    cause: new Error(`Agent ${name} hook timed out after ${timeoutMs}ms`),
  };
}

/**
 * Single owner of per-step spend recording: normalizes usage, writes the
 * provider response ledger entry (when applicable), accumulates run totals,
 * invokes `onStepSpend` under its timeout, and emits `observe` `step-finished`
 * from the exact same fact.
 */
export async function recordStepSpend<CONTEXT, TOOLS extends ToolSet>(
  execution: RunExecution<CONTEXT, TOOLS>,
  input: RecordStepSpendInput,
): Promise<AgentStepSpend> {
  const { config, generateId, now } = execution.dependencies;
  const { state, trace } = execution;
  const base = {
    conversationId: state.run.conversationId,
    runId: state.run.id,
    step: state.step,
    attempt: input.attempt,
    ...(execution.invocationTrace !== undefined && { trace: execution.invocationTrace }),
  };
  let spend: AgentStepSpend;

  if (input.phase === 'compaction') {
    const usage = statedUsage(input.usage);
    state.nonModelUsage = addUsage(state.nonModelUsage, usage);
    spend = AgentStepSpendSchema.parse({ ...base, phase: input.phase, usage });
  } else {
    const usage = statedUsage(
      normalizeStepUsage(input.selectedModel, input.part.usage, input.part.providerMetadata),
    );
    const response = await input.ledger.recordResponse({
      id: input.part.response.id,
      providerMetadata: input.part.providerMetadata,
      stepNumber: state.step,
      attempt: input.attempt,
      usage,
    });
    if (input.phase === 'step') {
      state.lastPromptTokens = usage.inputTokens;
      state.modelUsage = addUsage(state.modelUsage, usage);
    } else {
      state.abandonedUsage = state.abandonedUsage
        ? addUsage(state.abandonedUsage, usage)
        : usage;
    }
    spend = AgentStepSpendSchema.parse({
      ...base,
      phase: input.phase,
      model: input.selectedModel.descriptor.modelId,
      provider: {
        key: input.selectedModel.descriptor.provider,
        ...(response.provider !== undefined && { upstream: response.provider }),
      },
      response,
      usage,
    });
  }
  state.usage = runUsage(state);

  const { stepSpendTimeoutMs } = execution.dependencies;
  const hook = config.onStepSpend;
  const runtimeContext = execution.runtimeContext;
  let spendHookError:
    | (StepSpendHookFailure & { reportFailed?: true; reportError?: unknown })
    | undefined =
    hook && runtimeContext
      ? await callStepSpendHook('onStepSpend', stepSpendTimeoutMs, () =>
          hook({ ...runtimeContext, ...spend }),
        )
      : undefined;
  const report = config.onStepSpendError;
  if (spendHookError !== undefined && report !== undefined) {
    const error = spendHookError.cause;
    const reportFailure = await callStepSpendHook('onStepSpendError', stepSpendTimeoutMs, () =>
      report({ spend, error }),
    );
    // The step is billed and stands. The reporter's own failure travels with the event
    // it was reporting, so an operator sees that the report never arrived.
    if (reportFailure !== undefined)
      spendHookError = {
        ...spendHookError,
        reportFailed: true,
        reportError: reportFailure.cause,
      };
  }

  const stepTrace = trace ? config.observe?.rootTrace(trace) : undefined;
  config.observe?.emit({
    schemaVersion: 1,
    eventId: generateId(),
    type: 'step-finished',
    conversationId: spend.conversationId,
    runId: spend.runId,
    traceId: stepTrace?.traceId ?? trace?.traceId ?? generateId(),
    spanId: stepTrace?.spanId ?? generateId(),
    ...(stepTrace?.parentSpanId && { parentSpanId: stepTrace.parentSpanId }),
    state: state.run.state,
    step: spend.step,
    attempt: spend.attempt,
    phase: spend.phase,
    ...(spend.phase !== 'compaction' && {
      modelId: spend.model,
      provider: spend.provider,
      response: spend.response,
    }),
    usage: spend.usage,
    ...(spendHookError !== undefined && { spendHookError }),
    emittedAt: now().toISOString(),
  });

  return spend;
}
