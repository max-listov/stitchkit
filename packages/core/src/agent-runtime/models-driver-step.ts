import type {
  AgentCacheControl,
  AgentGeneratedFileData,
  AgentInstructions,
  AgentModelMessage,
  AgentModelProviderOptions,
  AgentModelResponseFormat,
  AgentModelSystemMessage,
} from '../agent-parts/model';
import type { AgentProviderEnvelope, AgentSourcePart } from '../agent-parts/parts';
import type { AgentToolError } from '../tools/agent-tool-error';
import type { AgentTool, AgentToolSet } from '../tools/agent-tools';
import type {
  AgentModelCostDetails,
  AgentModelDriver,
  AgentModelFinishReason,
  AgentModelToolChoice,
  AgentStepTimings,
} from './models-driver';
import type { AgentUsage } from './schemas';

/** Parsed tool call recorded in `AgentStepResult`. */
export interface AgentStepToolCall {
  readonly type: 'tool-call';
  readonly toolCallId: string;
  readonly toolName: string;
  readonly input: unknown;
  readonly providerExecuted?: boolean;
  readonly invalid?: boolean;
  readonly error?: unknown;
}

/** Executed tool result recorded in `AgentStepResult`. */
export interface AgentStepToolResult {
  readonly type: 'tool-result';
  readonly toolCallId: string;
  readonly toolName: string;
  readonly input: unknown;
  readonly output: unknown;
  readonly providerExecuted?: boolean;
}

/** One structured item in `AgentStepResult.content`. */
export type AgentStepContentPart =
  | { readonly type: 'text'; readonly text: string }
  | { readonly type: 'reasoning'; readonly text: string }
  | AgentStepToolCall
  | AgentStepToolResult
  | {
      readonly type: 'tool-error';
      readonly toolCallId: string;
      readonly toolName: string;
      readonly input: unknown;
      readonly error: unknown;
    }
  | {
      readonly type: 'tool-output-denied';
      readonly toolCallId: string;
      readonly toolName: string;
      readonly input: unknown;
      readonly reason?: string;
    }
  | {
      readonly type: 'tool-approval-request';
      readonly approvalId: string;
      readonly toolCall: AgentStepToolCall;
      readonly isAutomatic?: boolean;
      readonly signature?: string;
      readonly reason?: string;
    }
  | {
      readonly type: 'tool-approval-response';
      readonly approvalId: string;
      readonly approved: boolean;
      readonly reason?: string;
    }
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
  | { readonly type: 'source'; readonly source: AgentSourcePart }
  | {
      readonly type: 'custom';
      readonly kind: string;
      readonly provider?: AgentProviderEnvelope;
    };

/** Completed step summary delivered to `prepareStep` and `stopPolicies`. */
export interface AgentStepResult {
  readonly stepNumber: number;
  readonly model?: {
    readonly provider: string;
    readonly modelId: string;
  };
  readonly text: string;
  readonly content: readonly AgentStepContentPart[];
  readonly toolCalls: readonly AgentStepToolCall[];
  readonly toolResults: readonly AgentStepToolResult[];
  readonly finishReason: AgentModelFinishReason;
  readonly rawFinishReason?: string;
  readonly usage: AgentUsage;
  readonly costDetails?: AgentModelCostDetails;
  readonly timings?: AgentStepTimings;
  readonly response: {
    readonly id: string;
    readonly modelId?: string;
    readonly timestamp?: Date;
    readonly provider?: string;
    readonly messages: readonly AgentModelMessage[];
  };
  readonly provider?: AgentProviderEnvelope;
}

/** Outcome returned by `loop.toolApproval` for one tool call. */
export type AgentToolApprovalDecision =
  | 'approved'
  | 'denied'
  | 'user-approval'
  | 'not-applicable'
  | {
      readonly type: 'approved' | 'denied' | 'user-approval' | 'not-applicable';
      readonly reason?: string;
    };

/** Input handed to a function-form `loop.toolApproval` policy. */
export interface AgentToolApprovalCallOptions<CONTEXT = unknown> {
  readonly toolCall: {
    readonly toolCallId: string;
    readonly toolName: string;
    readonly input: unknown;
    readonly providerExecuted?: boolean;
  };
  readonly messages: readonly AgentModelMessage[];
  readonly runtimeContext: CONTEXT;
}

type ToolInputOf<T> = T extends AgentTool<infer TInput, infer _TOutput> ? TInput : unknown;

/**
 * Per-tool approval rule with typed input inferred from the corresponding `AgentTool`.
 * Uses bivariant method syntax so typed per-tool rules assign cleanly inside
 * `AgentToolApprovalConfiguration` without runtime casts.
 */
export type AgentToolApprovalToolRule<CONTEXT = unknown, INPUT = unknown> =
  | AgentToolApprovalDecision
  | {
      decide(
        input: INPUT,
        options: {
          readonly toolCallId: string;
          readonly messages: readonly AgentModelMessage[];
          readonly runtimeContext: CONTEXT;
        },
      ): AgentToolApprovalDecision | Promise<AgentToolApprovalDecision>;
    }['decide'];

/** Tool-approval policy: one function over every call, or a per-tool rule map. */
export type AgentToolApprovalConfiguration<
  TOOLS extends AgentToolSet = AgentToolSet,
  CONTEXT = unknown,
> =
  | ((
      options: AgentToolApprovalCallOptions<CONTEXT>,
    ) => AgentToolApprovalDecision | Promise<AgentToolApprovalDecision>)
  | {
      readonly [K in keyof TOOLS]?: AgentToolApprovalToolRule<CONTEXT, ToolInputOf<TOOLS[K]>>;
    };

/** Whole-step batch policy hook invoked once all tool calls of a step have been parsed and validated. */
export interface AgentStepToolCallBatchInput<CONTEXT = unknown> {
  readonly stepNumber: number;
  readonly calls: readonly {
    readonly toolCallId: string;
    readonly toolName: string;
    readonly input: unknown;
  }[];
  readonly instructions: readonly AgentModelSystemMessage[];
  readonly messages: readonly AgentModelMessage[];
  readonly context: CONTEXT;
}

/** Whole-step batch decision returned by `loop.beforeStepToolCalls`. */
export interface AgentStepToolCallBatchDecision {
  /** Refusals keyed by `toolCallId`; refused calls emit `tool-error` without executing. */
  readonly refuse?: ReadonlyMap<string, AgentToolError | Error>;
}

/** Whole-step batch policy hook evaluated before executing client tool calls. */
export type AgentStepToolCallBatchHook<CONTEXT = unknown> = (
  input: AgentStepToolCallBatchInput<CONTEXT>,
) =>
  | AgentStepToolCallBatchDecision
  | undefined
  | Promise<AgentStepToolCallBatchDecision | undefined>;

/** Input handed to a tool-call repair hook when a call targets an inactive/unknown tool or fails validation. */
export interface AgentToolCallRepairInput {
  readonly toolCall: {
    readonly toolCallId: string;
    readonly toolName: string;
    readonly input: string;
  };
  readonly activeTools: readonly string[];
  readonly tools: AgentToolSet;
  readonly messages: readonly AgentModelMessage[];
  readonly error: {
    readonly kind: 'unknown-tool' | 'invalid-input';
    readonly toolName: string;
    readonly cause: unknown;
  };
}

/** First-class hook that may rewrite an unresolvable or invalid tool call before execution. */
export type AgentToolCallRepairFunction = (input: AgentToolCallRepairInput) =>
  | { readonly toolCallId: string; readonly toolName: string; readonly input: string }
  | null
  | Promise<{
      readonly toolCallId: string;
      readonly toolName: string;
      readonly input: string;
    } | null>;

/** Overrides returned by `loop.prepareStep`. */
export interface AgentPrepareStepResult<TOOLS extends AgentToolSet = AgentToolSet> {
  readonly driver?: AgentModelDriver;
  readonly instructions?: AgentInstructions;
  readonly messages?: readonly AgentModelMessage[];
  readonly activeTools?: readonly (Extract<keyof TOOLS, string> | (string & {}))[];
  readonly toolChoice?: AgentModelToolChoice;
  readonly responseFormat?: AgentModelResponseFormat;
  readonly cacheControl?: AgentCacheControl;
  readonly maxOutputTokens?: number;
  readonly temperature?: number;
  readonly topP?: number;
  readonly topK?: number;
  readonly presencePenalty?: number;
  readonly frequencyPenalty?: number;
  readonly seed?: number;
  readonly stopSequences?: readonly string[];
  readonly providerOptions?: AgentModelProviderOptions;
  readonly headers?: Readonly<Record<string, string>>;
}

/** Step-preparation input before each provider call. */
export interface AgentPrepareStepInput<TOOLS extends AgentToolSet = AgentToolSet> {
  readonly stepNumber: number;
  readonly steps: readonly AgentStepResult[];
  readonly messages: readonly AgentModelMessage[];
  readonly responseMessages: readonly AgentModelMessage[];
  readonly initialMessages: readonly AgentModelMessage[];
  readonly initialInstructions: AgentInstructions;
  readonly instructions: AgentInstructions;
  readonly driver: AgentModelDriver;
  readonly activeTools: readonly (Extract<keyof TOOLS, string> | (string & {}))[];
}
