import {
  type ModelMessage,
  type StopCondition,
  stepCountIs,
  streamText,
  type ToolSet,
} from 'ai';
import { isToolExecutionControlError } from '../tools/execute';
import { type AgentRuntimeEvent, agentDurableEventId } from './events';
import { projectAgentHistory } from './history';
import { createAgentToolFenceLifecycle } from './managed-tools';
import type { AgentResolvedModel } from './models';
import type { AgentRuntimeConfig } from './runtime';
import {
  abortTerminalReason,
  addUsage,
  appendText,
  createIdleDeadline,
  findRun,
  jsonValue,
  mergeRunTotals,
  normalizeSdkUsage,
  providerEnvelope,
  statedUsage,
} from './runtime-internals';
import type { AgentRuntimeResult } from './runtime-result';
import {
  type AgentMessagePart,
  AgentMessagePartSchema,
  AgentMessageSchema,
  type AgentRun,
  type AgentSnapshot,
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
    /** Run ids the application submitted under `inputPolicy: 'inject'`. */
    absorbable?: ReadonlySet<string>;
    /** Told which queued run this one took on, so its ticket can be answered. */
    onAbsorbed?(absorbedRunId: string): void;
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
    // A requeued run re-executes from scratch and pays the provider again, so
    // its figure continues the one the earlier attempt persisted rather than
    // replacing it. Without the durable field there was nothing to continue
    // from: the crashed attempt's tokens lived only in an event its executor
    // never survived to emit.
    let usage: AgentUsage | undefined = input.acceptedRun.usage;
    // Whether the provider ever told us the run was over. It is the difference
    // between a total and a floor, and it is the only thing `partial` can
    // honestly mean on a terminal event — it used to be a constant per event
    // kind, `true` on every checkpoint and `false` on every terminal including
    // the ones that were abandoned mid-stream.
    let sawProviderFinish = false;
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
          usage: statedUsage(usage),
        }),
        'assistant checkpoint',
      );
      run = findRun(snapshot.runs, run.id);
      const checkpointMetrics = {
        // Always true here, and now for a reason rather than by construction:
        // a checkpoint is by definition taken before the provider has finished.
        partial: true,
        durationMs: performance.now() - runStartedAt,
        usage: statedUsage(usage),
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
        // A model call the run caused is the run's cost, even though it made no
        // step and emitted no event of its own.
        if (compacted.usage) usage = addUsage(usage, compacted.usage);
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
      const projectHistory = (source: AgentSnapshot) =>
        config.history?.project
          ? config.history.project(source.messages)
          : projectAgentHistory(source.messages, {
              ...(config.history?.resolveFile && { resolveFile: config.history.resolveFile }),
              ...(config.history?.unresolvedFile && {
                unresolvedFile: config.history.unresolvedFile,
              }),
              ...(config.history?.interruptedAssistant && {
                interruptedAssistant: config.history.interruptedAssistant,
              }),
            });
      const history = await projectHistory(snapshot);

      /**
       * Take on a queued successor's inputs, if the application asked for it.
       *
       * Returns the re-projected history when something was absorbed, so the
       * next provider call carries the new message. A conflict means the world
       * moved — another owner, a successor that started, a revision that
       * advanced — and the honest response is to do nothing and let the
       * successor run on its own, which is what every other policy does anyway.
       */
      const absorbPending = async (): Promise<ModelMessage[] | undefined> => {
        if (!input.absorbable?.size || executionSignal.aborted) return undefined;
        const latest = await config.store.loadSnapshot(run.conversationId);
        const current = latest.runs.find((candidate) => candidate.id === run.id);
        if (current?.state !== 'running' || current.ownerId !== runtimeEpoch) {
          return undefined;
        }
        const pending = latest.runs.find(
          (candidate) => candidate.state === 'queued' && input.absorbable?.has(candidate.id),
        );
        if (!pending) return undefined;
        const absorbed = await config.store.absorbQueuedRun({
          conversationId: run.conversationId,
          runningRunId: current.id,
          runningExpectedRevision: current.revision,
          ownerId: runtimeEpoch,
          ...(current.fencingToken !== undefined && { fencingToken: current.fencingToken }),
          queuedRunId: pending.id,
          queuedExpectedRevision: pending.revision,
        });
        if (absorbed.outcome !== 'applied') return undefined;
        input.onAbsorbed?.(pending.id);
        snapshot = absorbed.snapshot;
        run = findRun(snapshot.runs, run.id);
        await publish({
          type: 'run-state',
          eventId: agentDurableEventId('run-state', run.id, snapshot.version),
          conversationId: run.conversationId,
          runId: run.id,
          snapshotVersion: snapshot.version,
          state: run.state,
          emittedAt: now().toISOString(),
        });
        return [...(await projectHistory(snapshot))];
      };
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
        prepareStep: async (options) => {
          // A step boundary is the only place an in-flight run may take on new
          // input: the provider is between calls, so the next request can carry
          // it. `absorbPending` is a no-op unless the application asked for it.
          const absorbed = await absorbPending();
          const prepared =
            (await config.loop?.prepareStep?.({ ...options, ...runtimeContext })) ?? {};
          // An application-supplied `prepareStep` wins if it set `messages`
          // itself: it is the one that knows why.
          return absorbed && !prepared.messages
            ? { ...prepared, messages: absorbed }
            : prepared;
        },
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
          usage = addUsage(usage, stepUsage);
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
          // A provider that errors mid-stream still delivers a `finish`, and
          // this branch used to overwrite the `provider_failure` the `error`
          // part had just set — reporting a stop policy that does not exist,
          // with no `policyName`, for a provider outage. A reason an earlier
          // part already decided describes the same event and wins.
          if (terminalReason === 'success') {
            terminalReason =
              part.finishReason === 'error' ? 'provider_failure' : 'provider_stop';
            // Which cap it hit — `length`, `content-filter`, `other` — is the
            // provider's word and belongs in the operator-only cause, not in a
            // terminal reason the core would have to grow a member for each of.
            internalCause ??= { finishReason: part.finishReason };
          }
        }
        if (part.type === 'finish') {
          sawProviderFinish = true;
          // This line used to graft the LAST STEP's cost onto every step's
          // tokens — a successful three-step run reported a third of the money
          // beside all of the tokens, and called it `provider-reported`.
          usage = mergeRunTotals(normalizeSdkUsage(part.totalUsage), usage);
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
    // Never absent. An omitted `usage` said the same thing about a run that
    // never reached the provider and a run that burned a minute of the most
    // expensive model available — and only one of those spent money.
    const spent = statedUsage(usage);
    const emitSpend = (report: {
      eventId: string;
      state: AgentRun['state'];
      reason: AgentTerminalReason;
    }): void => {
      config.observe?.emit({
        schemaVersion: 1,
        eventId: report.eventId,
        type: 'run-terminal',
        conversationId: run.conversationId,
        runId: run.id,
        traceId: trace?.traceId ?? generateId(),
        spanId: trace?.spanId ?? generateId(),
        ...(trace?.parentSpanId && { parentSpanId: trace.parentSpanId }),
        state: report.state,
        terminalReason: report.reason,
        ...(selectedModel && { modelId: selectedModel.descriptor.modelId }),
        durationMs: performance.now() - runStartedAt,
        usage: spent,
        ...(internalCause !== undefined && { internalCause }),
        ...(firstOutputAt !== undefined && { ttftMs: firstOutputAt - runStartedAt }),
        emittedAt: now().toISOString(),
      });
    };
    // A losing executor reports a DIFFERENT fact — its own spend for a run it
    // did not settle — so its event must not wear the winner's identity. Both
    // used to derive `${runId}:terminal:${version}` from the same post-commit
    // snapshot, and the sink's default deduplication then dropped whichever
    // arrived second, discarding one of the two spend figures. Qualified by the
    // epoch, the id is still stable for this executor and unique between them.
    const unsettledEventId = (version: number): string =>
      agentDurableEventId('terminal', `${run.id}:${runtimeEpoch}`, version);

    let terminal: Awaited<ReturnType<typeof commitAgentRunTerminal>>;
    try {
      terminal = await commitAgentRunTerminal({
        store: config.store,
        runtimeEpoch,
        candidate: {
          run,
          assistant,
          reason: terminalReason,
          ...(terminalPolicyName && { policyName: terminalPolicyName }),
          usage: spent,
        },
        now,
      });
    } catch (error) {
      // Where the record ends up is now someone else's to decide — the lease
      // was taken, or the row moved under us. What this executor SPENT getting
      // here is not in doubt, and dropping it is how a stolen run produced four
      // fully billed steps and no row on either channel. `state` is the run as
      // this executor last knew it, which is exactly the claim being made: an
      // execution stopped here, and it did not settle the record.
      emitSpend({
        eventId: unsettledEventId(snapshot.version),
        state: run.state,
        reason: terminalReason,
      });
      throw error;
    }
    snapshot = terminal.snapshot;
    run = terminal.run;
    assistant = terminal.assistant;
    terminalReason = terminal.reason;
    terminalPolicyName = terminal.policyName;
    const terminalMetrics = terminal.committedByCaller
      ? {
          partial: !sawProviderFinish,
          durationMs: performance.now() - runStartedAt,
          usage: spent,
          ...(firstOutputAt !== undefined && { ttftMs: firstOutputAt - runStartedAt }),
        }
      : undefined;
    // The two channels are not gated alike, because they are not for the same
    // reader. Observability is the operator's, and it is about what THIS
    // executor spent — money that is real whether or not this executor won the
    // terminal CAS. Delivery carries the assistant message to the application's
    // transport, so emitting it for a run someone else committed would deliver
    // the same turn twice. Gating both on `committedByCaller` is why an
    // executor that lost the race reported nothing at all.
    emitSpend({
      eventId: terminal.committedByCaller
        ? agentDurableEventId('terminal', run.id, snapshot.version)
        : unsettledEventId(snapshot.version),
      state: run.state,
      reason: terminalReason,
    });
    if (terminalMetrics) {
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
