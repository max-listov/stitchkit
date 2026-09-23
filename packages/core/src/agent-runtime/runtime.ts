import type {
  GeneratedFile,
  ModelMessage,
  PrepareStepFunction,
  StopCondition,
  ToolApprovalConfiguration,
  ToolSet,
} from 'ai';
import type { z } from 'zod';
import type { LocalStepDurability } from '../durability/engine';
import type { ToolLifecycle } from '../tools/execute';
import type { AgentChildManager } from './children';
import type { AgentCompactionResult } from './compaction';
import type {
  AgentInputPolicy,
  AgentSessionCloseOptions,
  AgentSessionCloseResult,
  AgentStopReason,
} from './coordinator';
import type { AgentRuntimeEvent, AgentRuntimePublisher } from './events';
import type { AgentHistoryProjectionOptions } from './history';
import type { AgentResolvedModel } from './models';
import type { AgentObservability } from './observability';
import type { ComposedAgentPrompt } from './prompt';
import type { AgentTerminalAcceptanceInput } from './protocol';
import type { AgentRetryPolicy } from './retry-policy';
import { abandonAgentRun, closeAgentRuntime, interruptAgentRun } from './runtime-control';
import { recoverAgentRuns, resumeAgentRun } from './runtime-recovery';
import type { AgentRuntimeResult } from './runtime-result';
import { createAgentRuntimeState } from './runtime-state';
import { submitAgentInput } from './runtime-submit';
import type {
  AgentAssistantPlaceholder,
  AgentJsonObjectSchema,
  AgentMessage,
  AgentMessagePart,
  AgentRun,
  AgentSnapshot,
  AgentUsageValue,
} from './schemas';
import type { AnyAgentStateSlot } from './state-slots';
import type {
  AgentRecoverableDescriptor,
  AgentRuntimeStore,
  AgentStoreMutationResult,
} from './store';
import type { AgentHistoryEvidencePolicy } from './terminal-status';

export interface AgentRuntimeProtocolInput<CONTEXT> {
  parseContext(input: unknown): CONTEXT;
  parseInputMetadata(input: unknown): z.infer<typeof AgentJsonObjectSchema>;
  parsePart(input: unknown): AgentMessagePart;
  acceptTerminal?(input: AgentTerminalAcceptanceInput): boolean | Promise<boolean>;
}

export interface AgentRuntimeInput {
  conversationId: string;
  idempotencyKey: string;
  context: unknown;
  parts: readonly AgentMessagePart[];
  metadata?: unknown;
  recordIds?: AgentRuntimeRecordIds;
  /** Tool-role input is reserved for a durable approval continuation. */
  role?: 'user' | 'tool';
}

export interface AgentRuntimeRecordIds {
  inputMessageId: string;
  runId: string;
  assistantMessageId: string;
}

export interface AgentRuntimeAdmission {
  inputMessageId: string;
  runId: string;
  assistantMessageId: string;
  input: AgentMessage;
  run: AgentRun;
  assistant: AgentAssistantPlaceholder | AgentMessage;
  snapshotVersion: number;
}

export interface AgentRuntimeRecoveryInput {
  conversationId: string;
  runId: string;
  context: unknown;
  conversationKey?: string;
}

export type AgentRuntimeRecoveryDecision =
  | { action: 'resume' }
  | { action: 'skip' }
  | { action: 'requeue'; replaySafe: true }
  | { action: 'abandon'; staleOwner: true };

export interface AgentRuntimeRecoverOptions<CONTEXT> {
  resolveContext(input: AgentRecoverableDescriptor): CONTEXT | Promise<CONTEXT>;
  decide?(
    input: AgentRecoverableDescriptor,
  ): AgentRuntimeRecoveryDecision | Promise<AgentRuntimeRecoveryDecision>;
  pageSize?: number;
  maxRuns?: number;
  signal?: AbortSignal;
}

export interface AgentRuntimeRecoveryOutcome {
  conversationId: string;
  runId: string;
  outcome: 'resumed' | 'requeued' | 'abandoned' | 'skipped' | 'failed';
  error?: unknown;
  /** Terminal execution result for work handed to the local coordinator. */
  result?: Promise<AgentRuntimeResult>;
}

export interface AgentRuntimeInterruptInput {
  conversationId: string;
  runId: string;
  conversationKey?: string;
}

/**
 * Operator evidence for terminalizing one run whose former executor is known
 * to be gone. The revision makes that evidence stale-safe: a run that moved
 * after the operator read it is not closed.
 */
export interface AgentRuntimeAbandonInput {
  conversationId: string;
  runId: string;
  expectedRevision: number;
  staleOwner: true;
}

/**
 * How full the model's context is, as the runtime knows it.
 *
 * The runtime is the only party that knows: the consumer counts what it sends,
 * the provider reports what it received, and neither sees both. Observed
 * consequence of not saying: a model ran to a hard context overflow without
 * changing its behaviour on a single step before it, because nothing had told
 * it there was a limit approaching.
 *
 * `usedTokens` is the **prompt size of the last completed step**, not the run's
 * cumulative usage: cumulative input tokens count every step's prompt again and
 * are several times the context fill. Before any step completes there is no
 * provider-reported number and the value is `unavailable` — which is a
 * different fact from zero, and is reported as one.
 *
 * No fraction is exposed. Dividing is one line at the point of rendering, and a
 * quotient of an estimated numerator would need its own provenance to be honest
 * about what it is. The output reserve is not here either: the runtime does not
 * choose it — the consumer's prompt budget does — and reporting a number this
 * layer does not own would be a second copy that can disagree.
 */
export interface AgentContextUsage {
  usedTokens: AgentUsageValue;
  contextWindow: number;
}

export interface AgentRuntimeRunContext<CONTEXT> {
  context: CONTEXT;
  run: AgentRun;
  signal: AbortSignal;
  toolFenceLifecycle: ToolLifecycle;
  /**
   * Absent until a model is resolved for the run; then present on every step,
   * with `usedTokens.provenance === 'unavailable'` until the first step lands.
   */
  contextUsage?: AgentContextUsage;
}

export type AgentRuntimePrepareStep<CONTEXT, TOOLS extends ToolSet = ToolSet> = (
  input: Parameters<PrepareStepFunction<TOOLS>>[0] & AgentRuntimeRunContext<CONTEXT>,
) => ReturnType<PrepareStepFunction<TOOLS>>;

export interface AgentRuntimeConfig<CONTEXT, TOOLS extends ToolSet = ToolSet> {
  protocol: AgentRuntimeProtocolInput<CONTEXT>;
  store: AgentRuntimeStore;
  /** Tool-call durability; the host retains process placement and cross-process run leases. */
  durability?:
    | true
    | ((input: {
        store: AgentRuntimeStore;
        conversationId: string;
        runId: string;
        toolName: string;
        toolCallId: string;
        signal?: AbortSignal;
      }) => LocalStepDurability);
  models: {
    preflight?(input: { context: CONTEXT; conversationId: string }): void | Promise<void>;
    resolve(input: {
      context: CONTEXT;
      conversationId: string;
      run: AgentRun;
      snapshot: AgentSnapshot;
    }): AgentResolvedModel | Promise<AgentResolvedModel>;
  };
  prompt(input: {
    context: CONTEXT;
    signal: AbortSignal;
    event: 'session.started' | 'turn.started';
    model: AgentResolvedModel;
    snapshot: AgentSnapshot;
  }): ComposedAgentPrompt | Promise<ComposedAgentPrompt>;
  tools(input: AgentRuntimeRunContext<CONTEXT>): TOOLS | Promise<TOOLS>;
  runs?: {
    key?(input: AgentRuntimeInput): string;
    inputPolicy?: AgentInputPolicy | ((input: AgentRuntimeInput) => AgentInputPolicy);
    coalescePending?: boolean;
  };
  loop?: {
    maxSteps?: number;
    checkpointEveryEvents?: number;
    /**
     * How long the provider stream may produce nothing before the run is ended
     * as `timeout`. Default 60 000; `null` disables it.
     * Starts at the provider-call boundary and pauses during local tool execution.
     * Preparation and approval waiting are outside this clock; tool deadlines are host-owned.
     *
     * There used to be no default, so a hung provider held the conversation's
     * lane forever — the guide states the consequence itself ("a hung
     * predecessor blocks the lane") without saying that the out-of-the-box
     * setting is the one that produces it. `maxSteps` bounds steps, not a
     * single stalled one.
     */
    idleTimeoutMs?: number | null;
    /**
     * Prepare each provider step. Throw `AgentContextOverflowError` when the
     * application can prove the assembled step exceeds the model budget.
     */
    prepareStep?: AgentRuntimePrepareStep<CONTEXT, TOOLS>;
    stopPolicies?: readonly AgentRuntimeStopPolicy<TOOLS>[];
    toolApproval?: ToolApprovalConfiguration<TOOLS, CONTEXT>;
    /** Enables the SDK's HMAC binding between approval request and exact tool call/input. */
    toolApprovalSecret?: string | Uint8Array;
    /** Retry provider stream failures only before any tool call in that attempt. */
    retry?: AgentRetryPolicy;
  };
  history?: {
    compact?(input: {
      conversationId: string;
      store: AgentRuntimeStore;
      signal: AbortSignal;
    }): AgentCompactionResult | Promise<AgentCompactionResult>;
    project?(messages: readonly AgentMessage[]): ModelMessage[] | Promise<ModelMessage[]>;
    resolveFile?: AgentHistoryProjectionOptions['resolveFile'];
    unresolvedFile?: AgentHistoryProjectionOptions['unresolvedFile'];
    interruptedAssistant?: AgentHistoryProjectionOptions['interruptedAssistant'];
    evidencePolicy?: AgentHistoryEvidencePolicy;
  };
  /** Durable state injected on every provider request, including after compaction. */
  stateSlots?: readonly AnyAgentStateSlot[];
  /**
   * Children of a conversation stop when their parent's run does.
   *
   * Given, the executor calls `stopChildren` after a run of the parent
   * conversation is interrupted, cancelled, timed out or shut down — after
   * the parent's terminal is durable, so the cascade can never undo it.
   */
  children?: Pick<AgentChildManager, 'stopChildren'>;
  publish?: AgentRuntimePublisher;
  onPublishError?(input: { event: AgentRuntimeEvent; error: unknown }): void | Promise<void>;
  observe?: AgentObservability;
  persistGeneratedFile?(
    file: GeneratedFile,
  ):
    | { reference: string; filename?: string }
    | Promise<{ reference: string; filename?: string }>;
  generateId?: () => string;
  now?: () => Date;
}

export interface AgentRuntimeStopPolicy<TOOLS extends ToolSet = ToolSet> {
  name: string;
  when: StopCondition<TOOLS>;
}

export interface AgentRuntime<CONTEXT = unknown> {
  submit(input: AgentRuntimeInput): {
    accepted: Promise<void>;
    admission: Promise<AgentRuntimeAdmission>;
    result: Promise<AgentRuntimeResult>;
  };
  resume(input: AgentRuntimeRecoveryInput): {
    accepted: Promise<void>;
    result: Promise<AgentRuntimeResult>;
  };
  interrupt(input: AgentRuntimeInterruptInput): Promise<AgentStoreMutationResult>;
  abandon(input: AgentRuntimeAbandonInput): Promise<AgentStoreMutationResult>;
  recover(
    options: AgentRuntimeRecoverOptions<CONTEXT>,
  ): Promise<readonly AgentRuntimeRecoveryOutcome[]>;
  stop(conversationKey: string, reason?: AgentStopReason): boolean;
  /**
   * Stop accepting local work and wind down what is running.
   *
   * The result says what happened rather than implying it: `settled` when every
   * in-flight run finished, `timedOut` with `remaining` when the force budget
   * expired first. Only omitting `forceTimeoutMs` guarantees no run is still in
   * flight on return — naming one is a decision to stop waiting.
   */
  close(options?: AgentSessionCloseOptions): Promise<AgentSessionCloseResult>;
}

/**
 * The runtime is wiring: its state is built once, and each entry point is a
 * phase in its own module taking that state — submission (`runtime-submit`),
 * recovery (`runtime-recovery`), and run control and close (`runtime-control`).
 */
export function createAgentRuntime<CONTEXT, TOOLS extends ToolSet>(
  config: AgentRuntimeConfig<CONTEXT, TOOLS>,
): AgentRuntime<CONTEXT> {
  const state = createAgentRuntimeState(config);
  return {
    submit: (rawInput) => submitAgentInput(state, rawInput),
    resume: (rawInput) => resumeAgentRun(state, rawInput),
    interrupt: (input) => interruptAgentRun(state, input),
    abandon: (input) => abandonAgentRun(state, input),
    recover: (options) => recoverAgentRuns(state, options),
    stop: (conversationKey, reason) => state.coordinator.stop(conversationKey, reason),
    close: (options = {}) => closeAgentRuntime(state, options),
  };
}
