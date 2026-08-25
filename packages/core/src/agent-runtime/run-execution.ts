import { type StopCondition, stepCountIs, streamText, type ToolSet } from 'ai';
import { isToolExecutionControlError } from '../tools/execute';
import { type AgentRuntimeEvent, agentDurableEventId } from './events';
import { projectAgentHistory } from './history';
import { createAgentToolFenceLifecycle } from './managed-tools';
import type { AgentResolvedModel } from './models';
import type { AgentRuntimeConfig } from './runtime';
import {
  abortTerminalReason,
  appendText,
  createIdleDeadline,
  findRun,
  jsonValue,
  normalizeSdkUsage,
  providerEnvelope,
} from './runtime-internals';
import type { AgentRuntimeResult } from './runtime-result';
import {
  type AgentMessagePart,
  AgentMessagePartSchema,
  AgentMessageSchema,
  type AgentRun,
  type AgentTerminalReason,
  type AgentUsage,
} from './schemas';
import {
  AgentRuntimeConflictError,
  appliedSnapshot,
  commitAgentRunTerminal,
} from './terminal-commit';
import { assistantStatus } from './terminal-status';

/** Everything one run needs from the factory that owns it. */
export interface RunExecutorDependencies<CONTEXT, TOOLS extends ToolSet> {
  config: AgentRuntimeConfig<CONTEXT, TOOLS>;
  publish(event: AgentRuntimeEvent): Promise<void>;
  runtimeEpoch: string;
  generateId(): string;
  now(): Date;
  checkpointEveryEvents: number;
  maxSteps: number;
  idleTimeoutMs?: number;
}

/**
 * One acquired run, executed to a terminal commit.
 *
 * Extracted from `createAgentRuntime` because it is a different job: the
 * factory wires dependencies and owns process-local admission, this owns the
 * stream loop, checkpoints, fencing and the terminal transition for exactly one
 * run. Dependencies arrive as parameters rather than as a closure over the
 * whole factory, so what a run can touch is visible in one place.
 */
export function createRunExecutor<CONTEXT, TOOLS extends ToolSet>(
  dependencies: RunExecutorDependencies<CONTEXT, TOOLS>,
) {
  const {
    config,
    publish,
    runtimeEpoch,
    generateId,
    now,
    checkpointEveryEvents,
    maxSteps,
    idleTimeoutMs,
  } = dependencies;

  return async function executeRun(input: {
    acceptedRun: AgentRun;
    context: CONTEXT;
    signal: AbortSignal;
  }): Promise<AgentRuntimeResult> {
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
      eventId: agentDurableEventId('run-state', run.id, acquired.version),
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
        ...(run.fencingToken !== undefined && { fencingToken: run.fencingToken }),
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
          ...(run.fencingToken !== undefined && { fencingToken: run.fencingToken }),
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
        eventId: agentDurableEventId('assistant-checkpoint', run.id, snapshot.version),
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
        if (currentRun.fencingToken !== run.fencingToken) return 'stale_run';
        if (currentRun.state === 'interrupt_requested') return 'run_interrupted';
        if (currentRun.state !== 'running') return 'stale_run';
        return undefined;
      };
      const toolFenceLifecycle = createAgentToolFenceLifecycle({
        runId: run.id,
        assertCurrent,
        context: () => ({
          ...(run.fencingToken !== undefined && { fencingToken: run.fencingToken }),
        }),
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
    } finally {
      // In a `finally` because the `catch` above does its own I/O: a
      // `loadSnapshot` that throws used to skip this line and leave the idle
      // timer armed for the rest of the process's life.
      idleDeadline.dispose();
    }

    assistant = AgentMessageSchema.parse({
      ...assistant,
      status: assistantStatus(terminalReason),
      parts,
      updatedAt: now().toISOString(),
    });
    const terminal = await commitAgentRunTerminal({
      store: config.store,
      runtimeEpoch,
      candidate: {
        run,
        assistant,
        reason: terminalReason,
        ...(terminalPolicyName && { policyName: terminalPolicyName }),
      },
      now,
    });
    snapshot = terminal.snapshot;
    run = terminal.run;
    assistant = terminal.assistant;
    terminalReason = terminal.reason;
    terminalPolicyName = terminal.policyName;
    const terminalMetrics = terminal.committedByCaller
      ? {
          partial: false,
          durationMs: performance.now() - runStartedAt,
          ...(usage && { usage }),
          ...(firstOutputAt !== undefined && { ttftMs: firstOutputAt - runStartedAt }),
        }
      : undefined;
    if (terminalMetrics) {
      config.observe?.emit({
        schemaVersion: 1,
        eventId: agentDurableEventId('terminal', run.id, snapshot.version),
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
        eventId: agentDurableEventId('terminal', run.id, snapshot.version),
        conversationId: run.conversationId,
        runId: run.id,
        snapshotVersion: snapshot.version,
        reason: terminalReason,
        ...(terminalPolicyName && { policyName: terminalPolicyName }),
        message: assistant,
        metrics: terminalMetrics,
        emittedAt: now().toISOString(),
      });
    }
    return {
      run,
      message: assistant,
      reason: terminalReason,
      snapshotVersion: snapshot.version,
      ...(terminalMetrics && { metrics: terminalMetrics }),
      ...(terminalPolicyName && { policyName: terminalPolicyName }),
    };
  };
}
