import type { z } from 'zod';
import type {
  AgentCacheControl,
  AgentGeneratedFileData,
  AgentModelMessage,
  AgentModelProviderOptions,
  AgentModelProviderOptionValue,
  AgentModelResponseFormat,
  AgentModelSystemMessage,
} from '../agent-parts/model';
import type { AgentProviderEnvelope, AgentSourcePart } from '../agent-parts/parts';
import type { ToolPresentationSchema } from '../tools/schema/flatten';
import type {
  AgentModelCostDetailsSchema,
  AgentModelFinishReasonSchema,
  AgentStepChunkIntervalsSchema,
  AgentStepTimingsSchema,
} from './models-driver-telemetry';
import type { AgentUsage } from './schemas';

/** Client-declared function tool schema advertised to a model driver on one step. */
export interface AgentModelFunctionToolSpec {
  readonly type?: 'function';
  readonly name: string;
  readonly description?: string;
  readonly inputSchema: ToolPresentationSchema;
  readonly strict?: boolean;
  readonly cacheControl?: AgentCacheControl;
  readonly providerOptions?: AgentModelProviderOptions;
}

/** Provider-native server-executed tool declaration (e.g. web search, code execution). */
export interface AgentModelProviderToolSpec {
  readonly type: 'provider';
  readonly id: string;
  readonly name: string;
  readonly config?: Readonly<Record<string, AgentModelProviderOptionValue | undefined>>;
  readonly cacheControl?: AgentCacheControl;
}

/** Tool schema advertised to a model driver on one step. */
export type AgentModelToolSpec = AgentModelFunctionToolSpec | AgentModelProviderToolSpec;

/** Tool-choice directive for one model step. */
export type AgentModelToolChoice =
  | 'auto'
  | 'none'
  | 'required'
  | { readonly type: 'tool'; readonly toolName: string };

/** Sampling and output settings for one model step. */
export interface AgentModelCallSettings {
  readonly maxOutputTokens?: number;
  readonly temperature?: number;
  readonly topP?: number;
  readonly topK?: number;
  readonly presencePenalty?: number;
  readonly frequencyPenalty?: number;
  readonly seed?: number;
  readonly stopSequences?: readonly string[];
}

/** Non-secret execution correlation forwarded to drivers (e.g. sticky routing `session_id`). */
export interface AgentModelCorrelation {
  readonly conversationId: string;
  readonly runId?: string;
  readonly invocationId?: string;
  readonly attemptId: string;
  readonly step: number;
}

/** One single-step model request handed to an `AgentModelDriver`. */
export interface AgentModelRequest {
  readonly instructions: readonly AgentModelSystemMessage[];
  readonly messages: readonly AgentModelMessage[];
  readonly tools: readonly AgentModelToolSpec[];
  readonly toolChoice?: AgentModelToolChoice;
  readonly responseFormat?: AgentModelResponseFormat;
  readonly cacheControl?: AgentCacheControl;
  readonly settings: AgentModelCallSettings;
  readonly providerOptions?: AgentModelProviderOptions;
  /** Optional per-request HTTP headers (e.g. `traceparent`, custom auth/deadline); never overrides `content-type`. */
  readonly headers?: Readonly<Record<string, string>>;
  readonly correlation: AgentModelCorrelation;
}

/** Why one model step stopped producing output. */
export type AgentModelFinishReason = z.infer<typeof AgentModelFinishReasonSchema>;

/** Response identity emitted by a provider when known before or during streaming. */
export interface AgentModelResponseMetadata {
  readonly id?: string;
  readonly modelId?: string;
  readonly timestamp?: Date;
}

/** Optional provider-reported breakdown of cost and BYOK routing for one step. */
export type AgentModelCostDetails = z.infer<typeof AgentModelCostDetailsSchema>;

/** Summary quantiles (ms) of intervals between consecutive output chunks in one model step. */
export type AgentStepChunkIntervals = z.infer<typeof AgentStepChunkIntervalsSchema>;

/** Measured wall-clock latency breakdown for one model step. */
export type AgentStepTimings = z.infer<typeof AgentStepTimingsSchema>;

/** Stream event emitted by one `AgentModelDriver.stream()` call. */
export type AgentModelStreamPart =
  | { readonly type: 'ping' }
  | {
      readonly type: 'response-metadata';
      readonly id?: string;
      readonly modelId?: string;
      readonly timestamp?: Date;
    }
  | {
      readonly type: 'text-start';
      readonly id: string;
      readonly provider?: AgentProviderEnvelope;
    }
  | {
      readonly type: 'text-delta';
      readonly id: string;
      readonly delta: string;
      readonly provider?: AgentProviderEnvelope;
    }
  | {
      readonly type: 'text-end';
      readonly id: string;
      readonly provider?: AgentProviderEnvelope;
    }
  | {
      readonly type: 'reasoning-start';
      readonly id: string;
      readonly provider?: AgentProviderEnvelope;
    }
  | {
      readonly type: 'reasoning-delta';
      readonly id: string;
      readonly delta: string;
      readonly provider?: AgentProviderEnvelope;
    }
  | {
      readonly type: 'reasoning-end';
      readonly id: string;
      readonly provider?: AgentProviderEnvelope;
    }
  | {
      readonly type: 'tool-input-start';
      readonly toolCallId: string;
      readonly toolName: string;
      readonly providerExecuted?: boolean;
    }
  | { readonly type: 'tool-input-delta'; readonly toolCallId: string; readonly delta: string }
  | { readonly type: 'tool-input-end'; readonly toolCallId: string }
  | {
      readonly type: 'tool-call';
      readonly toolCallId: string;
      readonly toolName: string;
      /** Raw JSON text as emitted by the provider; parsing, validation and repair belong to the loop. */
      readonly input: string;
      readonly providerExecuted?: boolean;
      readonly dynamic?: boolean;
      readonly provider?: AgentProviderEnvelope;
    }
  | {
      readonly type: 'tool-result';
      readonly toolCallId: string;
      readonly toolName: string;
      readonly result: unknown;
      readonly providerExecuted: true;
      readonly isError?: boolean;
      readonly preliminary?: boolean;
      readonly provider?: AgentProviderEnvelope;
    }
  | {
      readonly type: 'tool-approval-request';
      readonly approvalId: string;
      readonly toolCallId: string;
      readonly provider?: AgentProviderEnvelope;
    }
  | { readonly type: 'source'; readonly source: AgentSourcePart }
  | {
      readonly type: 'file';
      readonly mediaType: string;
      readonly data: AgentGeneratedFileData;
      readonly filename?: string;
      readonly provider?: AgentProviderEnvelope;
    }
  | {
      readonly type: 'reasoning-file';
      readonly mediaType: string;
      readonly data: AgentGeneratedFileData;
      readonly provider?: AgentProviderEnvelope;
    }
  | {
      readonly type: 'custom';
      readonly kind: string;
      readonly provider?: AgentProviderEnvelope;
    }
  | { readonly type: 'raw'; readonly rawValue: unknown }
  | { readonly type: 'error'; readonly error: unknown }
  | {
      readonly type: 'finish';
      readonly finishReason: AgentModelFinishReason;
      readonly rawFinishReason?: string;
      readonly usage: AgentUsage;
      readonly costDetails?: AgentModelCostDetails;
      readonly responseProvider?: string;
      readonly response?: AgentModelResponseMetadata;
      readonly provider?: AgentProviderEnvelope;
    };

/** Stream handle returned by one `AgentModelDriver.stream()` call. */
export interface AgentModelStream {
  readonly response?: AgentModelResponseMetadata;
  readonly parts: AsyncIterable<AgentModelStreamPart>;
}

/**
 * Single model port owned by `stitchkit/agent-runtime`: one provider call per step.
 *
 * A driver never retries, executes tools or mutates history. Any throw out of
 * `stream()` or while iterating `parts` is provider-origin by construction. → ADR 0336.
 */
export interface AgentModelDriver {
  readonly provider: string;
  readonly modelId: string;
  stream(request: AgentModelRequest, signal: AbortSignal): Promise<AgentModelStream>;
}

/** Provider factory registered in `defineModelRegistry`. */
export interface AgentModelDriverFactory {
  create(modelId: string): AgentModelDriver;
}

/** Lifecycle outcome reported when one `AgentModelDriver.stream()` call settles. */
export type AgentModelDriverStreamOutcome =
  | {
      readonly status: 'finished';
      readonly finishReason: AgentModelFinishReason;
      readonly usage: AgentUsage;
      readonly rawFinishReason?: string;
      readonly costDetails?: AgentModelCostDetails;
      readonly responseProvider?: string;
      readonly response?: AgentModelResponseMetadata;
      readonly error?: unknown;
    }
  | { readonly status: 'errored'; readonly error: unknown }
  | { readonly status: 'cancelled' };

/**
 * Generic lifecycle interceptor around one `AgentModelDriver` call.
 *
 * `onClose` is guaranteed to run once on finish, error, or early stream cancellation,
 * making admission reservations, credit holds, and telemetry peer-free and leak-free.
 */
export interface AgentModelDriverDecorator<TState = unknown> {
  beforeStream?(
    request: AgentModelRequest,
    signal: AbortSignal,
    context: { readonly provider: string; readonly modelId: string },
  ): TState | Promise<TState>;
  transformRequest?(
    request: AgentModelRequest,
    state: TState,
  ): AgentModelRequest | Promise<AgentModelRequest>;
  /** Optional tighter `AbortSignal` linked with the caller's signal for this stream call. */
  transformSignal?(signal: AbortSignal, state: TState): AbortSignal | undefined;
  onPart?(part: AgentModelStreamPart, state: TState): void | Promise<void>;
  onClose?(outcome: AgentModelDriverStreamOutcome, state: TState): void | Promise<void>;
}
