import type { z } from 'zod';
import type {
  AgentCacheControl,
  AgentInstructions,
  AgentModelMessage,
  AgentModelProviderOptions,
  AgentModelResponseFormat,
} from '../agent-parts/model';
import type { AgentProviderEnvelope } from '../agent-parts/parts';
import type { AgentToolSet } from '../tools/agent-tools';
import type {
  AgentModelCallSettings,
  AgentModelCorrelation,
  AgentModelDriver,
  AgentModelFinishReason,
  AgentModelStreamPart,
  AgentModelToolChoice,
} from './models-driver';
import type {
  AgentPrepareStepInput,
  AgentPrepareStepResult,
  AgentStepResult,
  AgentToolCallRepairFunction,
} from './models-driver-step';
import type { AgentProviderFailure, AgentProviderFailureReason } from './provider-failure';
import type { AgentRetryPolicy } from './retry-policy';
import type { AgentUsage } from './schemas';

/** Why `completeObject` could not return a schema-valid structured object. */
export type AgentStructuredOutputErrorReason =
  | 'truncated'
  | 'tool-calls'
  | 'content-filter'
  | 'provider-error'
  | 'interrupted'
  | 'empty'
  | 'invalid-json'
  | 'schema-mismatch';

/** Structured details attached to an `AgentStructuredOutputError`. */
export interface AgentStructuredOutputErrorDetails {
  readonly reason: AgentStructuredOutputErrorReason;
  readonly finishReason: AgentModelFinishReason;
  readonly rawText: string;
  readonly usage: AgentUsage;
  readonly steps: readonly AgentStepResult[];
  readonly cause?: unknown;
}

/**
 * Typed failure raised by `completeObject` when the model response is truncated,
 * exhausts tool steps, is blocked by content filter, errors, is interrupted, is
 * empty, is not valid JSON, or fails Zod schema validation.
 */
export class AgentStructuredOutputError extends Error {
  readonly reason: AgentStructuredOutputErrorReason;
  readonly finishReason: AgentModelFinishReason;
  readonly rawText: string;
  readonly usage: AgentUsage;
  readonly steps: readonly AgentStepResult[];

  constructor(message: string, details: AgentStructuredOutputErrorDetails) {
    super(message, details.cause !== undefined ? { cause: details.cause } : undefined);
    this.name = 'AgentStructuredOutputError';
    this.reason = details.reason;
    this.finishReason = details.finishReason;
    this.rawText = details.rawText;
    this.usage = details.usage;
    this.steps = details.steps;
  }
}

/** Record of one failed provider attempt collected during standalone retry execution. */
export interface AgentRetryAttemptRecord {
  readonly attempt: number;
  readonly error: unknown;
  readonly failure: AgentProviderFailure;
  readonly usage?: AgentUsage;
}

/** Details attached to an `AgentRetryExhaustedError`. */
export interface AgentRetryExhaustedErrorDetails {
  readonly attempts: readonly AgentRetryAttemptRecord[];
  readonly lastError: unknown;
  readonly usage: AgentUsage;
}

/**
 * Typed failure raised by `completeText` / `completeObject` / `streamComplete` when
 * a configured `retry` policy exhausts its retryable attempts or stops on a
 * non-retryable failure after at least one prior attempt. Preserves every attempt
 * record and accumulated billable usage.
 */
export class AgentRetryExhaustedError extends Error {
  readonly attempts: readonly AgentRetryAttemptRecord[];
  readonly lastError: unknown;
  readonly usage: AgentUsage;

  constructor(message: string, details: AgentRetryExhaustedErrorDetails) {
    super(message, details.lastError !== undefined ? { cause: details.lastError } : undefined);
    this.name = 'AgentRetryExhaustedError';
    this.attempts = details.attempts;
    this.lastError = details.lastError;
    this.usage = details.usage;
  }
}

/** Rule evaluated after each step of `completeText` / `completeObject` before the next model call. */
export interface AgentCompleteStopPolicy {
  readonly name: string;
  readonly when: (input: {
    readonly steps: readonly AgentStepResult[];
  }) => boolean | Promise<boolean>;
}

/** One event yielded by `streamComplete` or delivered to `CompleteTextInput.onPart`. */
export type CompleteStreamPart =
  | Exclude<AgentModelStreamPart, { type: 'tool-call' }>
  | {
      readonly type: 'tool-call';
      readonly toolCallId: string;
      readonly toolName: string;
      readonly input: unknown;
      readonly providerExecuted?: boolean;
      readonly dynamic?: boolean;
      readonly provider?: AgentProviderEnvelope;
      readonly invalid?: true;
      readonly error?: unknown;
    }
  | {
      readonly type: 'tool-result';
      readonly toolCallId: string;
      readonly toolName: string;
      readonly input: unknown;
      readonly result: unknown;
      readonly preliminary?: boolean;
      readonly providerExecuted: false;
    }
  | {
      readonly type: 'tool-error';
      readonly toolCallId: string;
      readonly toolName: string;
      readonly input: unknown;
      readonly error: unknown;
    }
  | {
      readonly type: 'attempt-reset';
      readonly attempt: number;
      readonly reason: AgentProviderFailureReason;
      readonly usage?: AgentUsage;
    }
  | {
      readonly type: 'finish-step';
      readonly step: AgentStepResult;
    };

/** Per-step preparation hook for standalone `completeText` / `completeObject` / `streamComplete`. */
export type CompletePrepareStep<TOOLS extends AgentToolSet = AgentToolSet> = (
  input: AgentPrepareStepInput<TOOLS>,
) =>
  | AgentPrepareStepResult<TOOLS>
  | undefined
  | void
  | Promise<AgentPrepareStepResult<TOOLS> | undefined>
  | Promise<void>;

/** Compile-time XOR requiring either `prompt` or `messages`, never both or neither. */
export type CompletePromptInput =
  | { readonly prompt: string; readonly messages?: never }
  | { readonly messages: readonly AgentModelMessage[]; readonly prompt?: never };

/** Shared options for peer-free `completeText` and `streamComplete`. */
export interface CompleteTextOptions<TOOLS extends AgentToolSet = AgentToolSet> {
  readonly driver: AgentModelDriver;
  readonly instructions?: AgentInstructions;
  readonly tools?: TOOLS;
  readonly toolChoice?: AgentModelToolChoice;
  readonly maxSteps?: number;
  readonly idleTimeoutMs?: number;
  readonly retry?: AgentRetryPolicy;
  readonly stopPolicies?: readonly AgentCompleteStopPolicy[];
  readonly prepareStep?: CompletePrepareStep<TOOLS>;
  readonly repairToolCall?: AgentToolCallRepairFunction;
  readonly responseFormat?: AgentModelResponseFormat;
  readonly cacheControl?: AgentCacheControl;
  readonly settings?: AgentModelCallSettings;
  readonly providerOptions?: AgentModelProviderOptions;
  readonly headers?: Readonly<Record<string, string>>;
  readonly correlation?: Partial<AgentModelCorrelation>;
  readonly signal?: AbortSignal;
  readonly onStepFinish?: (step: AgentStepResult) => void | Promise<void>;
  readonly onAttemptDiscarded?: (input: {
    readonly attempt: number;
    readonly reason: AgentProviderFailureReason;
    readonly usage?: AgentUsage;
  }) => void | Promise<void>;
  readonly onPart?: (part: CompleteStreamPart) => void | Promise<void>;
}

/** Input to `completeText` and `streamComplete`, enforcing compile-time XOR on `prompt` vs `messages`. */
export type CompleteTextInput<TOOLS extends AgentToolSet = AgentToolSet> =
  CompleteTextOptions<TOOLS> & CompletePromptInput;

/** Final result returned by `completeText` and `streamComplete.result`. */
export interface CompleteTextResult {
  readonly text: string;
  readonly finishReason: AgentModelFinishReason;
  readonly rawFinishReason?: string;
  readonly usage: AgentUsage;
  readonly steps: readonly AgentStepResult[];
  readonly responseMessages: readonly AgentModelMessage[];
  /** Name of the `stopPolicies` rule that halted the loop, when one triggered. */
  readonly stoppedByPolicy?: string;
}

/** Streaming handle returned by `streamComplete` without requiring an `AgentRuntimeStore`. */
export interface CompleteTextStream {
  readonly parts: AsyncIterable<CompleteStreamPart>;
  readonly result: Promise<CompleteTextResult>;
}

/** Input to `completeObject`, enforcing compile-time XOR on `prompt` vs `messages`. */
export type CompleteObjectInput<
  TSchema extends z.ZodType,
  TOOLS extends AgentToolSet = AgentToolSet,
> = Omit<CompleteTextOptions<TOOLS>, 'responseFormat'> &
  CompletePromptInput & {
    readonly schema: TSchema;
    readonly schemaName?: string;
    readonly schemaDescription?: string;
    readonly strict?: boolean;
  };

/** Final structured-output result returned by `completeObject`. */
export interface CompleteObjectResult<TOutput> extends CompleteTextResult {
  readonly object: TOutput;
}
