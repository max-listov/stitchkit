import {
  type GeneratedFile,
  type LanguageModelUsage,
  type ModelMessage,
  type PrepareStepFunction,
  type StopCondition,
  stepCountIs,
  streamText,
  type ToolSet,
} from 'ai';
import { z } from 'zod';
import { isToolExecutionControlError, type ToolLifecycle } from '../tools/execute';
import type { AgentCompactionResult } from './compaction';
import {
  type AgentInputPolicy,
  type AgentSessionCloseOptions,
  type AgentStopReason,
  createAgentSessionCoordinator,
} from './coordinator';
import type { AgentRuntimeEvent, AgentRuntimePublisher } from './events';
import { type AgentHistoryProjectionOptions, projectAgentHistory } from './history';
import { createAgentToolFenceLifecycle } from './managed-tools';
import type { AgentResolvedModel } from './models';
import type { AgentObservability } from './observability';
import type { ComposedAgentPrompt } from './prompt';
import {
  type AgentAssistantPlaceholder,
  AgentAssistantPlaceholderSchema,
  AgentJsonObjectSchema,
  type AgentMessage,
  type AgentMessagePart,
  AgentMessagePartSchema,
  AgentMessageSchema,
  type AgentRun,
  type AgentRunMetrics,
  AgentRunSchema,
  type AgentSnapshot,
  type AgentTerminalReason,
  type AgentUsage,
} from './schemas';
import type { AgentRuntimeStore, AgentStoreMutationResult } from './store';
import type { AgentRecoverableDescriptor } from './store-driver';

export interface AgentRuntimeProtocolInput<CONTEXT> {
  parseContext(input: unknown): CONTEXT;
  parseInputMetadata(input: unknown): z.infer<typeof AgentJsonObjectSchema>;
  parsePart(input: unknown): AgentMessagePart;
}

export interface AgentRuntimeInput {
  conversationId: string;
  idempotencyKey: string;
  context: unknown;
  parts: readonly AgentMessagePart[];
  metadata?: unknown;
  recordIds?: AgentRuntimeRecordIds;
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
}

export interface AgentRuntimeInterruptInput {
  conversationId: string;
  runId: string;
  conversationKey?: string;
}

export interface AgentRuntimeRunContext<CONTEXT> {
  context: CONTEXT;
  run: AgentRun;
  signal: AbortSignal;
  toolFenceLifecycle: ToolLifecycle;
}

export type AgentRuntimePrepareStep<CONTEXT, TOOLS extends ToolSet = ToolSet> = (
  input: Parameters<PrepareStepFunction<TOOLS>>[0] & AgentRuntimeRunContext<CONTEXT>,
) => ReturnType<PrepareStepFunction<TOOLS>>;

export interface AgentRuntimeConfig<CONTEXT, TOOLS extends ToolSet = ToolSet> {
  protocol: AgentRuntimeProtocolInput<CONTEXT>;
  store: AgentRuntimeStore;
  models: {
    resolve(input: {
      context: CONTEXT;
      conversationId: string;
    }): AgentResolvedModel | Promise<AgentResolvedModel>;
  };
  prompt(input: {
    context: CONTEXT;
    signal: AbortSignal;
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
    idleTimeoutMs?: number;
    prepareStep?: AgentRuntimePrepareStep<CONTEXT, TOOLS>;
    stopPolicies?: readonly AgentRuntimeStopPolicy<TOOLS>[];
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
  };
  publish?: AgentRuntimePublisher;
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

export interface AgentRuntimeResult {
  run: AgentRun;
  message: AgentMessage;
  reason: AgentTerminalReason;
  snapshotVersion: number;
  policyName?: string;
  metrics?: AgentRunMetrics;
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
  recover(
    options: AgentRuntimeRecoverOptions<CONTEXT>,
  ): Promise<readonly AgentRuntimeRecoveryOutcome[]>;
  stop(conversationKey: string, reason?: AgentStopReason): boolean;
  close(options?: AgentSessionCloseOptions): Promise<void>;
}

class AgentRuntimeConflictError extends Error {
  constructor(operation: string) {
    super(`Agent runtime store conflict during ${operation}`);
    this.name = 'AgentRuntimeConflictError';
  }
}

function appliedSnapshot(result: AgentStoreMutationResult, operation: string) {
  if (result.outcome === 'applied' || result.outcome === 'duplicate') return result.snapshot;
  throw new AgentRuntimeConflictError(operation);
}

function findRun(runs: readonly AgentRun[], runId: string): AgentRun {
  const run = runs.find((candidate) => candidate.id === runId);
  if (!run) throw new AgentRuntimeConflictError('run lookup');
  return run;
}

function jsonValue(value: unknown): z.infer<ReturnType<typeof z.json>> {
  const parsed = z.json().safeParse(value);
  return parsed.success ? parsed.data : { message: 'Non-JSON tool output omitted' };
}

function providerEnvelope(value: unknown) {
  const parsed = AgentJsonObjectSchema.safeParse(value);
  if (!parsed.success) return undefined;
  return { schemaVersion: 1, provider: 'ai-sdk', data: parsed.data };
}

function appendText(parts: AgentMessagePart[], text: string): void {
  const previous = parts.at(-1);
  if (previous?.type === 'text') {
    const next = AgentMessagePartSchema.parse({ ...previous, text: previous.text + text });
    parts.splice(parts.length - 1, 1, next);
    return;
  }
  parts.push(AgentMessagePartSchema.parse({ type: 'text', text }));
}

function assistantStatus(reason: AgentTerminalReason): AgentMessage['status'] {
  if (reason === 'success' || reason === 'policy_stop') return 'completed';
  if (reason === 'interrupted' || reason === 'cancelled' || reason === 'shutdown') {
    return 'interrupted';
  }
  return 'failed';
}

function abortTerminalReason(signal: AbortSignal): AgentTerminalReason {
  if (signal.reason === 'shutdown') return 'shutdown';
  if (signal.reason === 'timeout') return 'timeout';
  return 'interrupted';
}

function normalizeSdkUsage(value: LanguageModelUsage): AgentUsage {
  const reported = (tokens: number | undefined): AgentUsage['inputTokens'] =>
    tokens === undefined
      ? { provenance: 'unavailable' }
      : { value: tokens, provenance: 'provider-reported' };
  return {
    inputTokens: reported(value.inputTokens),
    outputTokens: reported(value.outputTokens),
    reasoningTokens: reported(value.outputTokenDetails.reasoningTokens),
    cacheReadTokens: reported(value.inputTokenDetails.cacheReadTokens),
    cacheWriteTokens: reported(value.inputTokenDetails.cacheWriteTokens),
  };
}

function createIdleDeadline(parent: AbortSignal, timeoutMs: number | undefined) {
  if (timeoutMs === undefined) {
    const noop = (): void => undefined;
    return { signal: parent, touch: noop, dispose: noop };
  }
  const controller = new AbortController();
  let timer: ReturnType<typeof setTimeout> | undefined;
  const touch = (): void => {
    if (timer !== undefined) clearTimeout(timer);
    timer = setTimeout(() => controller.abort('timeout'), timeoutMs);
  };
  touch();
  return {
    signal: AbortSignal.any([parent, controller.signal]),
    touch,
    dispose() {
      if (timer !== undefined) clearTimeout(timer);
    },
  };
}

export function createAgentRuntime<CONTEXT, TOOLS extends ToolSet>(
  config: AgentRuntimeConfig<CONTEXT, TOOLS>,
): AgentRuntime<CONTEXT> {
  const coordinator = createAgentSessionCoordinator();
  interface RuntimeTicket {
    accepted: Promise<void>;
    admission: Promise<AgentRuntimeAdmission>;
    result: Promise<AgentRuntimeResult>;
  }
  const tickets = new Map<string, Map<string, RuntimeTicket>>();
  const generateId = config.generateId ?? (() => crypto.randomUUID());
  const now = config.now ?? (() => new Date());
  const runtimeEpoch = generateId();
  interface RuntimeAdmission {
    runId: string;
    completion: {
      promise: Promise<AgentRuntimeResult>;
      resolve(value: AgentRuntimeResult | PromiseLike<AgentRuntimeResult>): void;
      reject(reason?: unknown): void;
    };
  }
  interface RuntimeAdmissionLane {
    head?: RuntimeAdmission;
    pending?: RuntimeAdmission;
    acceptanceTail: Promise<void>;
  }
  const admissionLanes = new Map<string, RuntimeAdmissionLane>();
  const reserveAdmission = (key: string, runId: string) => {
    const existing = admissionLanes.get(key);
    const lane: RuntimeAdmissionLane = existing ?? { acceptanceTail: Promise.resolve() };
    if (!existing) admissionLanes.set(key, lane);
    if (!lane.head) {
      const admission = { runId, completion: Promise.withResolvers<AgentRuntimeResult>() };
      void admission.completion.promise.catch(() => undefined);
      lane.head = admission;
      return { lane, admission, shouldSchedule: true };
    }
    if (!lane.pending) {
      const admission = { runId, completion: Promise.withResolvers<AgentRuntimeResult>() };
      void admission.completion.promise.catch(() => undefined);
      lane.pending = admission;
      return { lane, admission, shouldSchedule: true };
    }
    return { lane, admission: lane.pending, shouldSchedule: false };
  };
  const settleAdmission = (key: string, admission: RuntimeAdmission): void => {
    const lane = admissionLanes.get(key);
    if (!lane) return;
    if (lane.head?.runId === admission.runId) {
      lane.head = lane.pending;
      lane.pending = undefined;
    } else if (lane.pending?.runId === admission.runId) {
      lane.pending = undefined;
    }
    if (!lane.head && !lane.pending) admissionLanes.delete(key);
  };
  const waitForAdmissionAcceptances = async (lane: RuntimeAdmissionLane): Promise<void> => {
    while (true) {
      const tail = lane.acceptanceTail;
      await tail.catch(() => undefined);
      if (tail === lane.acceptanceTail) return;
    }
  };
  const checkpointEveryEvents = config.loop?.checkpointEveryEvents ?? 20;
  const maxSteps = config.loop?.maxSteps ?? 50;
  const idleTimeoutMs = config.loop?.idleTimeoutMs;
  if (!Number.isSafeInteger(checkpointEveryEvents) || checkpointEveryEvents < 1) {
    throw new TypeError('checkpointEveryEvents must be a positive safe integer');
  }
  if (!Number.isSafeInteger(maxSteps) || maxSteps < 1) {
    throw new TypeError('maxSteps must be a positive safe integer');
  }
  if (
    idleTimeoutMs !== undefined &&
    (!Number.isSafeInteger(idleTimeoutMs) || idleTimeoutMs < 1)
  ) {
    throw new TypeError('idleTimeoutMs must be a positive safe integer');
  }
  const policyNames = new Set<string>(['max-steps']);
  for (const policy of config.loop?.stopPolicies ?? []) {
    if (!policy.name || policyNames.has(policy.name)) {
      throw new TypeError('Agent stop policy names must be non-empty and unique');
    }
    policyNames.add(policy.name);
  }

  const publish = async (event: AgentRuntimeEvent): Promise<void> => {
    try {
      await config.publish?.(event);
    } catch {
      // Product delivery cannot roll back an already committed runtime transition.
    }
  };

  const executeRun = async (input: {
    acceptedRun: AgentRun;
    context: CONTEXT;
    signal: AbortSignal;
  }): Promise<AgentRuntimeResult> => {
    const queuedSnapshot = await config.store.loadSnapshot(input.acceptedRun.conversationId);
    const queuedRun = findRun(queuedSnapshot.runs, input.acceptedRun.id);
    const acquired = appliedSnapshot(
      await config.store.acquireRun({
        conversationId: queuedRun.conversationId,
        runId: queuedRun.id,
        expectedRevision: queuedRun.revision,
        ownerId: runtimeEpoch,
      }),
      'run acquisition',
    );
    let run = findRun(acquired.runs, input.acceptedRun.id);
    await publish({
      type: 'run-state',
      eventId: generateId(),
      conversationId: run.conversationId,
      runId: run.id,
      snapshotVersion: acquired.version,
      state: run.state,
      emittedAt: now().toISOString(),
    });
    const trace = config.observe?.rootTrace();
    const runStartedAt = performance.now();
    config.observe?.emit({
      schemaVersion: 1,
      eventId: generateId(),
      type: 'run-started',
      conversationId: run.conversationId,
      runId: run.id,
      traceId: trace?.traceId ?? generateId(),
      spanId: trace?.spanId ?? generateId(),
      ...(trace?.parentSpanId && { parentSpanId: trace.parentSpanId }),
      state: run.state,
      queueWaitMs: Math.max(0, now().getTime() - new Date(run.createdAt).getTime()),
      emittedAt: now().toISOString(),
    });
    let assistant = AgentMessageSchema.parse({
      schemaVersion: 1,
      id: run.assistantMessageId,
      conversationId: run.conversationId,
      runId: run.id,
      role: 'assistant',
      status: 'streaming',
      parts: [],
      createdAt: now().toISOString(),
      updatedAt: now().toISOString(),
    });
    let snapshot = appliedSnapshot(
      await config.store.checkpointRunAssistant({
        conversationId: run.conversationId,
        runId: run.id,
        expectedRevision: run.revision,
        ownerId: runtimeEpoch,
        assistant,
      }),
      'assistant draft',
    );
    run = findRun(snapshot.runs, run.id);

    const parts: AgentMessagePart[] = [];
    let eventCount = 0;
    let sequence = 0;
    let terminalReason: AgentTerminalReason = 'success';
    let usage: AgentUsage | undefined;
    let step = 0;
    let selectedModel: AgentResolvedModel | undefined;
    let internalCause: unknown;
    let reasoningPartIndex: number | undefined;
    let firstOutputAt: number | undefined;
    let terminalPolicyName: string | undefined;
    const idleDeadline = createIdleDeadline(input.signal, idleTimeoutMs);
    const executionSignal = idleDeadline.signal;

    const updateReasoning = (text: string, metadata?: unknown): void => {
      const provider = providerEnvelope(metadata);
      if (reasoningPartIndex === undefined) {
        reasoningPartIndex = parts.length;
        parts.push(
          AgentMessagePartSchema.parse({
            type: 'reasoning',
            text,
            ...(provider && { provider }),
          }),
        );
        return;
      }
      const current = parts[reasoningPartIndex];
      if (current?.type !== 'reasoning') {
        throw new AgentRuntimeConflictError('reasoning accumulator');
      }
      parts.splice(
        reasoningPartIndex,
        1,
        AgentMessagePartSchema.parse({
          ...current,
          text: current.text + text,
          ...(provider && { provider }),
        }),
      );
    };

    const checkpoint = async (): Promise<void> => {
      assistant = AgentMessageSchema.parse({
        ...assistant,
        parts,
        updatedAt: now().toISOString(),
      });
      snapshot = appliedSnapshot(
        await config.store.checkpointRunAssistant({
          conversationId: run.conversationId,
          runId: run.id,
          expectedRevision: run.revision,
          ownerId: runtimeEpoch,
          assistant,
        }),
        'assistant checkpoint',
      );
      run = findRun(snapshot.runs, run.id);
      const checkpointMetrics = {
        partial: true,
        durationMs: performance.now() - runStartedAt,
        ...(usage && { usage }),
        ...(firstOutputAt !== undefined && { ttftMs: firstOutputAt - runStartedAt }),
      };
      await publish({
        type: 'assistant-checkpoint',
        eventId: generateId(),
        conversationId: run.conversationId,
        runId: run.id,
        snapshotVersion: snapshot.version,
        message: assistant,
        metrics: checkpointMetrics,
        emittedAt: now().toISOString(),
      });
    };

    try {
      if (config.history?.compact) {
        const compacted = await config.history.compact({
          conversationId: run.conversationId,
          store: config.store,
          signal: executionSignal,
        });
        snapshot = compacted.snapshot;
        run = findRun(snapshot.runs, run.id);
      }

      const assertCurrent = async (): Promise<'stale_run' | 'run_interrupted' | undefined> => {
        if (executionSignal.aborted) return 'run_interrupted';
        const current = await config.store.loadSnapshot(run.conversationId);
        const currentRun = current.runs.find((candidate) => candidate.id === run.id);
        if (!currentRun || currentRun.ownerId !== runtimeEpoch) return 'stale_run';
        if (currentRun.state === 'interrupt_requested') return 'run_interrupted';
        if (currentRun.state !== 'running') return 'stale_run';
        return undefined;
      };
      const toolFenceLifecycle = createAgentToolFenceLifecycle({
        runId: run.id,
        assertCurrent,
      });
      const runtimeContext = {
        context: input.context,
        run,
        signal: executionSignal,
        toolFenceLifecycle,
      };
      selectedModel = await config.models.resolve({
        context: input.context,
        conversationId: run.conversationId,
      });
      const [prompt, tools] = await Promise.all([
        config.prompt({
          context: input.context,
          signal: executionSignal,
          model: selectedModel,
          snapshot,
        }),
        config.tools(runtimeContext),
      ]);
      if (prompt.contextDecision === 'oversized') {
        throw new Error('Agent context exceeds the configured model budget');
      }
      if (prompt.contextDecision === 'requires-compaction') {
        throw new Error('Agent context still exceeds the model budget after compaction');
      }
      const history = await (config.history?.project
        ? config.history.project(snapshot.messages)
        : projectAgentHistory(snapshot.messages, {
            ...(config.history?.resolveFile && { resolveFile: config.history.resolveFile }),
            ...(config.history?.unresolvedFile && {
              unresolvedFile: config.history.unresolvedFile,
            }),
          }));
      const maxStepCondition = stepCountIs(maxSteps);
      const stopConditions: StopCondition<TOOLS>[] = [
        async (options) => {
          const stopped = await maxStepCondition(options);
          if (stopped && terminalPolicyName === undefined) terminalPolicyName = 'max-steps';
          return stopped;
        },
      ];
      for (const policy of config.loop?.stopPolicies ?? []) {
        stopConditions.push(async (options) => {
          const stopped = await policy.when(options);
          if (stopped && terminalPolicyName === undefined) terminalPolicyName = policy.name;
          return stopped;
        });
      }
      const result = streamText<TOOLS>({
        model: selectedModel.model,
        tools,
        instructions: prompt.instructions,
        messages: history,
        abortSignal: executionSignal,
        maxRetries: 0,
        stopWhen: stopConditions,
        ...(config.loop?.prepareStep && {
          prepareStep: (options) =>
            config.loop?.prepareStep?.({ ...options, ...runtimeContext }),
        }),
      });

      for await (const part of result.stream) {
        idleDeadline.touch();
        eventCount += 1;
        sequence += 1;
        if (
          firstOutputAt === undefined &&
          ['text-delta', 'reasoning-delta', 'tool-call', 'file', 'source'].includes(part.type)
        ) {
          firstOutputAt = performance.now();
        }
        if (part.type === 'text-delta') {
          appendText(parts, part.text);
          await publish({
            type: 'assistant-delta',
            conversationId: run.conversationId,
            runId: run.id,
            runtimeEpoch,
            sequence,
            textDelta: part.text,
            emittedAt: now().toISOString(),
          });
        } else if (part.type === 'reasoning-start') {
          reasoningPartIndex = undefined;
          updateReasoning('', part.providerMetadata);
          const provider = providerEnvelope(part.providerMetadata);
          await publish({
            type: 'reasoning-start',
            conversationId: run.conversationId,
            runId: run.id,
            runtimeEpoch,
            sequence,
            ...(provider && { provider }),
            emittedAt: now().toISOString(),
          });
        } else if (part.type === 'reasoning-delta') {
          updateReasoning(part.text, part.providerMetadata);
          const provider = providerEnvelope(part.providerMetadata);
          await publish({
            type: 'reasoning-delta',
            conversationId: run.conversationId,
            runId: run.id,
            runtimeEpoch,
            sequence,
            textDelta: part.text,
            ...(provider && { provider }),
            emittedAt: now().toISOString(),
          });
        } else if (part.type === 'reasoning-end') {
          updateReasoning('', part.providerMetadata);
          reasoningPartIndex = undefined;
          const provider = providerEnvelope(part.providerMetadata);
          await publish({
            type: 'reasoning-end',
            conversationId: run.conversationId,
            runId: run.id,
            runtimeEpoch,
            sequence,
            ...(provider && { provider }),
            emittedAt: now().toISOString(),
          });
        } else if (part.type === 'tool-call') {
          const provider = providerEnvelope(part.providerMetadata);
          parts.push(
            AgentMessagePartSchema.parse({
              type: 'tool-call',
              callId: part.toolCallId,
              toolName: part.toolName,
              input: jsonValue(part.input),
              ...(provider && { provider }),
            }),
          );
          await publish({
            type: 'tool-status',
            conversationId: run.conversationId,
            runId: run.id,
            runtimeEpoch,
            sequence,
            callId: part.toolCallId,
            toolName: part.toolName,
            status: 'started',
            input: jsonValue(part.input),
            emittedAt: now().toISOString(),
          });
        } else if (part.type === 'tool-result') {
          parts.push(
            AgentMessagePartSchema.parse({
              type: 'tool-result',
              callId: part.toolCallId,
              toolName: part.toolName,
              outcome: 'success',
              output: jsonValue(part.output),
            }),
          );
          await publish({
            type: 'tool-status',
            conversationId: run.conversationId,
            runId: run.id,
            runtimeEpoch,
            sequence,
            callId: part.toolCallId,
            toolName: part.toolName,
            status: 'completed',
            output: jsonValue(part.output),
            emittedAt: now().toISOString(),
          });
        } else if (part.type === 'tool-error') {
          internalCause = part.error;
          if (isToolExecutionControlError(part.error)) {
            await publish({
              type: 'tool-status',
              conversationId: run.conversationId,
              runId: run.id,
              runtimeEpoch,
              sequence,
              callId: part.toolCallId,
              toolName: part.toolName,
              status: 'interrupted',
              emittedAt: now().toISOString(),
            });
            throw part.error;
          }
          parts.push(
            AgentMessagePartSchema.parse({
              type: 'tool-result',
              callId: part.toolCallId,
              toolName: part.toolName,
              outcome: 'error',
              output: { message: 'Tool execution failed' },
            }),
          );
          await publish({
            type: 'tool-status',
            conversationId: run.conversationId,
            runId: run.id,
            runtimeEpoch,
            sequence,
            callId: part.toolCallId,
            toolName: part.toolName,
            status: 'failed',
            output: { message: 'Tool execution failed' },
            emittedAt: now().toISOString(),
          });
        } else if (part.type === 'tool-output-denied') {
          parts.push(
            AgentMessagePartSchema.parse({
              type: 'tool-result',
              callId: part.toolCallId,
              toolName: part.toolName,
              outcome: 'error',
              output: { message: 'Tool output denied' },
            }),
          );
          await publish({
            type: 'tool-status',
            conversationId: run.conversationId,
            runId: run.id,
            runtimeEpoch,
            sequence,
            callId: part.toolCallId,
            toolName: part.toolName,
            status: 'failed',
            output: { message: 'Tool output denied' },
            emittedAt: now().toISOString(),
          });
        } else if (part.type === 'source') {
          parts.push(
            AgentMessagePartSchema.parse({
              type: 'source',
              sourceId: part.id,
              ...(part.sourceType === 'url' && { url: part.url }),
              ...(part.title && { title: part.title }),
            }),
          );
        } else if (part.type === 'file' && config.persistGeneratedFile) {
          const persisted = await config.persistGeneratedFile(part.file);
          parts.push(
            AgentMessagePartSchema.parse({
              type: 'file',
              mediaType: part.file.mediaType,
              reference: persisted.reference,
              ...(persisted.filename && { filename: persisted.filename }),
            }),
          );
        } else if (part.type === 'file') {
          throw new Error('persistGeneratedFile is required for generated file output');
        } else if (part.type === 'reasoning-file' && config.persistGeneratedFile) {
          const persisted = await config.persistGeneratedFile(part.file);
          parts.push(
            AgentMessagePartSchema.parse({
              type: 'file',
              mediaType: part.file.mediaType,
              reference: persisted.reference,
              ...(persisted.filename && { filename: persisted.filename }),
            }),
          );
        } else if (part.type === 'reasoning-file') {
          throw new Error('persistGeneratedFile is required for generated reasoning files');
        } else if (
          part.type === 'tool-approval-request' ||
          part.type === 'tool-approval-response'
        ) {
          throw new Error('Durable tool approval/resume is outside this runtime version');
        } else if (part.type === 'custom') {
          const provider = providerEnvelope(part.providerMetadata);
          parts.push(
            AgentMessagePartSchema.parse({
              type: 'provider',
              envelope: {
                schemaVersion: 1,
                provider: 'ai-sdk-custom',
                data: { kind: part.kind, ...(provider && { provider: provider.data }) },
              },
            }),
          );
        } else if (part.type === 'raw') {
          parts.push(
            AgentMessagePartSchema.parse({
              type: 'provider',
              envelope: {
                schemaVersion: 1,
                provider: 'ai-sdk-raw',
                data: { value: jsonValue(part.rawValue) },
              },
            }),
          );
        } else if (part.type === 'abort') {
          terminalReason = 'interrupted';
        } else if (part.type === 'error') {
          terminalReason = 'provider_failure';
          internalCause = part.error;
        } else if (part.type === 'finish-step') {
          const stepTrace = trace ? config.observe?.rootTrace(trace) : undefined;
          const stepUsage =
            selectedModel.normalizeUsage?.({
              usage: part.usage,
              providerMetadata: part.providerMetadata,
            }) ?? normalizeSdkUsage(part.usage);
          usage = stepUsage;
          config.observe?.emit({
            schemaVersion: 1,
            eventId: generateId(),
            type: 'step-finished',
            conversationId: run.conversationId,
            runId: run.id,
            traceId: stepTrace?.traceId ?? trace?.traceId ?? generateId(),
            spanId: stepTrace?.spanId ?? generateId(),
            ...(stepTrace?.parentSpanId && { parentSpanId: stepTrace.parentSpanId }),
            state: run.state,
            modelId: selectedModel.descriptor.modelId,
            step,
            usage: stepUsage,
            emittedAt: now().toISOString(),
          });
          step += 1;
        } else if (part.type === 'finish' && part.finishReason !== 'stop') {
          terminalReason = 'policy_stop';
        }
        if (part.type === 'finish') {
          const aggregate = normalizeSdkUsage(part.totalUsage);
          usage = { ...aggregate, ...(usage?.cost && { cost: usage.cost }) };
        }
        if (eventCount % checkpointEveryEvents === 0) await checkpoint();
      }
      if (terminalPolicyName !== undefined) terminalReason = 'policy_stop';
      if (executionSignal.aborted) terminalReason = abortTerminalReason(executionSignal);
    } catch (error) {
      internalCause = error;
      const latest = await config.store.loadSnapshot(run.conversationId);
      const latestRun = latest.runs.find((candidate) => candidate.id === run.id);
      const durableInterrupt =
        latestRun?.ownerId === runtimeEpoch && latestRun.state === 'interrupt_requested';
      if (durableInterrupt && latestRun) {
        snapshot = latest;
        run = latestRun;
      }
      if (isToolExecutionControlError(error) || executionSignal.aborted || durableInterrupt) {
        terminalReason = executionSignal.aborted
          ? abortTerminalReason(executionSignal)
          : 'interrupted';
        parts.push(
          AgentMessagePartSchema.parse({
            type: 'control',
            reason:
              isToolExecutionControlError(error) && error.reason === 'stale_run'
                ? 'stale-run'
                : 'run-interrupted',
          }),
        );
      } else {
        terminalReason = 'provider_failure';
      }
    }
    idleDeadline.dispose();

    assistant = AgentMessageSchema.parse({
      ...assistant,
      status: assistantStatus(terminalReason),
      parts,
      updatedAt: now().toISOString(),
    });
    snapshot = appliedSnapshot(
      await config.store.commitRunTerminal({
        conversationId: run.conversationId,
        runId: run.id,
        expectedRevision: run.revision,
        ownerId: runtimeEpoch,
        assistant,
        reason: terminalReason,
        ...(terminalPolicyName && { policyName: terminalPolicyName }),
      }),
      'terminal commit',
    );
    run = findRun(snapshot.runs, run.id);
    const terminalMetrics = {
      partial: false,
      durationMs: performance.now() - runStartedAt,
      ...(usage && { usage }),
      ...(firstOutputAt !== undefined && { ttftMs: firstOutputAt - runStartedAt }),
    };
    config.observe?.emit({
      schemaVersion: 1,
      eventId: generateId(),
      type: 'run-terminal',
      conversationId: run.conversationId,
      runId: run.id,
      traceId: trace?.traceId ?? generateId(),
      spanId: trace?.spanId ?? generateId(),
      ...(trace?.parentSpanId && { parentSpanId: trace.parentSpanId }),
      state: run.state,
      terminalReason,
      ...(selectedModel && { modelId: selectedModel.descriptor.modelId }),
      durationMs: terminalMetrics.durationMs,
      ...(usage && { usage }),
      ...(internalCause !== undefined && { internalCause }),
      ...(firstOutputAt !== undefined && { ttftMs: firstOutputAt - runStartedAt }),
      emittedAt: now().toISOString(),
    });
    await publish({
      type: 'terminal',
      eventId: generateId(),
      conversationId: run.conversationId,
      runId: run.id,
      snapshotVersion: snapshot.version,
      reason: terminalReason,
      ...(terminalPolicyName && { policyName: terminalPolicyName }),
      message: assistant,
      metrics: terminalMetrics,
      emittedAt: now().toISOString(),
    });
    return {
      run,
      message: assistant,
      reason: terminalReason,
      snapshotVersion: snapshot.version,
      metrics: terminalMetrics,
      ...(terminalPolicyName && { policyName: terminalPolicyName }),
    };
  };

  const resume = (rawInput: AgentRuntimeRecoveryInput) => {
    const context = config.protocol.parseContext(rawInput.context);
    const accepted = Promise.withResolvers<void>();
    const result = Promise.withResolvers<AgentRuntimeResult>();
    void (async () => {
      try {
        const snapshot = await config.store.loadSnapshot(rawInput.conversationId);
        const recoveredRun = findRun(snapshot.runs, rawInput.runId);
        if (recoveredRun.state !== 'queued') {
          throw new Error('Only a queued recovered agent run can be resumed');
        }
        accepted.resolve();
        const ticket = coordinator.submit({
          key: rawInput.conversationKey ?? rawInput.conversationId,
          policy: 'queue',
          create: (signal) => ({
            runId: recoveredRun.id,
            execute: () => executeRun({ acceptedRun: recoveredRun, context, signal }),
          }),
        });
        void ticket.result.then(result.resolve, result.reject);
      } catch (error) {
        accepted.reject(error);
        result.reject(error);
      }
    })();
    return { accepted: accepted.promise, result: result.promise };
  };

  return {
    submit(rawInput) {
      const metadata =
        rawInput.metadata === undefined
          ? undefined
          : config.protocol.parseInputMetadata(rawInput.metadata);
      const input = {
        conversationId: rawInput.conversationId,
        idempotencyKey: rawInput.idempotencyKey,
        context: rawInput.context,
        parts: rawInput.parts.map((part) => config.protocol.parsePart(part)),
        ...(metadata !== undefined && { metadata }),
      };
      const context = config.protocol.parseContext(input.context);
      const conversationTickets = tickets.get(input.conversationId);
      const existingTicket = conversationTickets?.get(input.idempotencyKey);
      if (existingTicket) return existingTicket;
      const key = config.runs?.key?.(input) ?? input.conversationId;
      const policy =
        typeof config.runs?.inputPolicy === 'function'
          ? config.runs.inputPolicy(input)
          : (config.runs?.inputPolicy ?? 'queue');
      const nowIso = now().toISOString();
      const inputMessageId = rawInput.recordIds?.inputMessageId ?? generateId();
      const runId = rawInput.recordIds?.runId ?? generateId();
      const assistantMessageId = rawInput.recordIds?.assistantMessageId ?? generateId();
      const userMessage = AgentMessageSchema.parse({
        schemaVersion: 1,
        id: inputMessageId,
        conversationId: input.conversationId,
        role: 'user',
        status: 'committed',
        parts: input.parts,
        ...(input.metadata && { metadata: input.metadata }),
        createdAt: nowIso,
        updatedAt: nowIso,
      });
      const queuedRun = AgentRunSchema.parse({
        schemaVersion: 1,
        id: runId,
        conversationId: input.conversationId,
        inputMessageIds: [inputMessageId],
        assistantMessageId,
        state: 'queued',
        revision: 0,
        createdAt: nowIso,
        updatedAt: nowIso,
      });
      const outerAccepted = Promise.withResolvers<void>();
      const outerAdmission = Promise.withResolvers<AgentRuntimeAdmission>();
      void outerAdmission.promise.catch(() => undefined);
      const outerResult = Promise.withResolvers<AgentRuntimeResult>();
      const reservation = config.runs?.coalescePending
        ? reserveAdmission(key, runId)
        : undefined;
      const previousAcceptance = reservation?.lane.acceptanceTail ?? Promise.resolve();
      const acceptanceDone = Promise.withResolvers<void>();
      if (reservation) {
        reservation.lane.acceptanceTail = previousAcceptance
          .catch(() => undefined)
          .then(() => acceptanceDone.promise);
      }
      const publicTicket = {
        accepted: outerAccepted.promise,
        admission: outerAdmission.promise,
        result: outerResult.promise,
      };
      const currentConversationTickets =
        conversationTickets ?? new Map<string, RuntimeTicket>();
      currentConversationTickets.set(input.idempotencyKey, publicTicket);
      if (!conversationTickets) tickets.set(input.conversationId, currentConversationTickets);
      const forgetTicket = (): void => {
        if (currentConversationTickets.get(input.idempotencyKey) !== publicTicket) return;
        currentConversationTickets.delete(input.idempotencyKey);
        if (currentConversationTickets.size === 0) tickets.delete(input.conversationId);
      };
      void outerResult.promise.then(forgetTicket, forgetTicket);
      void (async () => {
        try {
          await previousAcceptance.catch(() => undefined);
          const acceptance = await config.store.acceptInputAndAssignRun({
            idempotencyKey: input.idempotencyKey,
            input: userMessage,
            run: queuedRun,
            ...(reservation &&
              !reservation.shouldSchedule && {
                coalesceIntoRunId: reservation.admission.runId,
              }),
          });
          const acceptedSnapshot = appliedSnapshot(acceptance, 'input acceptance');
          const assignedRunId =
            acceptance.outcome === 'duplicate'
              ? acceptance.runId
              : (reservation?.admission.runId ?? runId);
          const acceptedRun = findRun(acceptedSnapshot.runs, assignedRunId);
          const actualInputMessageId =
            acceptance.outcome === 'duplicate' ? acceptance.inputMessageId : userMessage.id;
          const acceptedInput =
            acceptance.outcome === 'duplicate'
              ? acceptance.input
              : acceptedSnapshot.messages.find(
                  (candidate) => candidate.id === actualInputMessageId,
                );
          if (!acceptedInput) {
            throw new AgentRuntimeConflictError('admission input projection');
          }
          const assistantPlaceholder = AgentAssistantPlaceholderSchema.parse({
            schemaVersion: 1,
            id: acceptedRun.assistantMessageId,
            conversationId: acceptedRun.conversationId,
            runId: acceptedRun.id,
            status: 'pending',
            createdAt: acceptedRun.createdAt,
            updatedAt: acceptedRun.updatedAt,
          });
          const acceptedAssistant =
            acceptance.outcome === 'duplicate'
              ? (acceptedSnapshot.messages.find(
                  (candidate) => candidate.id === acceptedRun.assistantMessageId,
                ) ?? assistantPlaceholder)
              : assistantPlaceholder;
          const admission = {
            inputMessageId: acceptedInput.id,
            runId: acceptedRun.id,
            assistantMessageId: assistantPlaceholder.id,
            input: acceptedInput,
            run: acceptedRun,
            assistant: acceptedAssistant,
            snapshotVersion: acceptedSnapshot.version,
          };
          outerAdmission.resolve(admission);
          await publish({
            type: 'admission',
            eventId: generateId(),
            conversationId: acceptedRun.conversationId,
            runId: acceptedRun.id,
            snapshotVersion: acceptedSnapshot.version,
            input: acceptedInput,
            run: acceptedRun,
            assistant: acceptedAssistant,
            emittedAt: now().toISOString(),
          });
          await publish({
            type: 'run-state',
            eventId: generateId(),
            conversationId: acceptedRun.conversationId,
            runId: acceptedRun.id,
            snapshotVersion: acceptedSnapshot.version,
            state: acceptedRun.state,
            emittedAt: now().toISOString(),
          });
          outerAccepted.resolve();
          if (acceptance.outcome === 'duplicate') {
            if (!acceptedRun.terminalReason) {
              const error = new Error(
                'Duplicate input is already owned by another runtime execution',
              );
              outerResult.reject(error);
              if (reservation?.shouldSchedule) {
                reservation.admission.completion.reject(error);
                settleAdmission(key, reservation.admission);
              }
              return;
            }
            const message = acceptedSnapshot.messages.find(
              (candidate) => candidate.id === acceptedRun.assistantMessageId,
            );
            if (!message) {
              const error = new Error('Duplicate terminal run has no assistant message');
              outerResult.reject(error);
              if (reservation?.shouldSchedule) {
                reservation.admission.completion.reject(error);
                settleAdmission(key, reservation.admission);
              }
              return;
            }
            outerResult.resolve({
              run: acceptedRun,
              message,
              reason: acceptedRun.terminalReason,
              snapshotVersion: acceptedSnapshot.version,
              ...(acceptedRun.terminalPolicyName && {
                policyName: acceptedRun.terminalPolicyName,
              }),
            });
            if (reservation?.shouldSchedule) {
              reservation.admission.completion.reject(
                new Error('Reserved run resolved to a duplicate durable input'),
              );
              settleAdmission(key, reservation.admission);
            }
            return;
          }
          if (reservation && !reservation.shouldSchedule) {
            void reservation.admission.completion.promise.then(
              outerResult.resolve,
              outerResult.reject,
            );
            return;
          }
          const ticket = coordinator.submit({
            key,
            policy,
            create: async (signal) => {
              if (reservation) await waitForAdmissionAcceptances(reservation.lane);
              return {
                runId: acceptedRun.id,
                execute: () => executeRun({ acceptedRun, context, signal }),
              };
            },
          });
          if (reservation) {
            void ticket.result.then(
              reservation.admission.completion.resolve,
              reservation.admission.completion.reject,
            );
            void reservation.admission.completion.promise.then(
              (value) => {
                settleAdmission(key, reservation.admission);
                outerResult.resolve(value);
              },
              (error) => {
                settleAdmission(key, reservation.admission);
                outerResult.reject(error);
              },
            );
          } else {
            void ticket.result.then(outerResult.resolve, outerResult.reject);
          }
        } catch (error) {
          outerAccepted.reject(error);
          outerAdmission.reject(error);
          outerResult.reject(error);
          if (reservation?.shouldSchedule) {
            reservation.admission.completion.reject(error);
            settleAdmission(key, reservation.admission);
          }
        } finally {
          acceptanceDone.resolve();
        }
      })();
      return publicTicket;
    },
    resume,
    async interrupt(input) {
      const snapshot = await config.store.loadSnapshot(input.conversationId);
      const run = findRun(snapshot.runs, input.runId);
      const requested = await config.store.requestRunInterrupt({
        conversationId: input.conversationId,
        runId: input.runId,
        expectedRevision: run.revision,
      });
      if (requested.outcome === 'applied') {
        const interruptedRun = findRun(requested.snapshot.runs, input.runId);
        await publish({
          type: 'run-state',
          eventId: generateId(),
          conversationId: interruptedRun.conversationId,
          runId: interruptedRun.id,
          snapshotVersion: requested.snapshot.version,
          state: interruptedRun.state,
          emittedAt: now().toISOString(),
        });
        coordinator.stop(input.conversationKey ?? input.conversationId, 'user-interrupt');
      }
      return requested;
    },
    async recover(options) {
      if (!config.store.scanRecoverablePage) {
        throw new Error('The configured agent store does not support bounded recovery scans');
      }
      const pageSize = options.pageSize ?? 100;
      const maxRuns = options.maxRuns ?? 1_000;
      if (!Number.isSafeInteger(pageSize) || pageSize < 1 || pageSize > 1_000) {
        throw new TypeError('Recovery pageSize must be an integer between 1 and 1000');
      }
      if (!Number.isSafeInteger(maxRuns) || maxRuns < 1) {
        throw new TypeError('Recovery maxRuns must be a positive safe integer');
      }
      const outcomes: AgentRuntimeRecoveryOutcome[] = [];
      let cursor: string | undefined;
      while (outcomes.length < maxRuns && !options.signal?.aborted) {
        const page = await config.store.scanRecoverablePage({
          ...(cursor && { cursor }),
          limit: Math.min(pageSize, maxRuns - outcomes.length),
        });
        for (const item of page.items) {
          if (options.signal?.aborted) break;
          try {
            if (item.run.state === 'queued') {
              const snapshot = await config.store.loadSnapshot(item.conversationId);
              const blockedByAcquiredPredecessor = snapshot.runs.some(
                (run) =>
                  run.id !== item.run.id &&
                  (run.state === 'running' || run.state === 'interrupt_requested'),
              );
              if (blockedByAcquiredPredecessor) {
                outcomes.push({
                  conversationId: item.conversationId,
                  runId: item.run.id,
                  outcome: 'skipped',
                });
                continue;
              }
            }
            const decision =
              (await options.decide?.(item)) ??
              (item.run.state === 'queued' ? { action: 'resume' } : { action: 'skip' });
            if (decision.action === 'skip') {
              outcomes.push({
                conversationId: item.conversationId,
                runId: item.run.id,
                outcome: 'skipped',
              });
              continue;
            }
            if (decision.action === 'abandon') {
              const abandoned = await config.store.recoverRun({
                conversationId: item.conversationId,
                runId: item.run.id,
                expectedRevision: item.run.revision,
                action: 'abandon',
              });
              if (abandoned.outcome !== 'applied') {
                throw new AgentRuntimeConflictError('recovery abandon');
              }
              outcomes.push({
                conversationId: item.conversationId,
                runId: item.run.id,
                outcome: 'abandoned',
              });
              continue;
            }
            if (decision.action === 'requeue') {
              const requeued = await config.store.recoverRun({
                conversationId: item.conversationId,
                runId: item.run.id,
                expectedRevision: item.run.revision,
                action: 'requeue',
                replaySafe: true,
              });
              if (requeued.outcome !== 'applied') {
                throw new AgentRuntimeConflictError('recovery requeue');
              }
            }
            const context = await options.resolveContext(item);
            const resumed = resume({
              conversationId: item.conversationId,
              runId: item.run.id,
              context,
            });
            void resumed.result.catch(() => undefined);
            await resumed.accepted;
            outcomes.push({
              conversationId: item.conversationId,
              runId: item.run.id,
              outcome: decision.action === 'requeue' ? 'requeued' : 'resumed',
            });
          } catch (error) {
            outcomes.push({
              conversationId: item.conversationId,
              runId: item.run.id,
              outcome: 'failed',
              error,
            });
          }
        }
        cursor = page.nextCursor;
        if (!cursor || page.items.length === 0) break;
      }
      return outcomes;
    },
    stop: (conversationKey, reason) => coordinator.stop(conversationKey, reason),
    close: (options) => coordinator.close(options),
  };
}
