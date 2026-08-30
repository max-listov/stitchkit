import type {
  GeneratedFile,
  ModelMessage,
  PrepareStepFunction,
  StopCondition,
  ToolApprovalConfiguration,
  ToolSet,
} from 'ai';
import type { z } from 'zod';
import type { ToolLifecycle } from '../tools/execute';
import { createRuntimeAdmissionLanes } from './admission-lanes';
import type { AgentCompactionResult } from './compaction';
import {
  type AgentInputPolicy,
  type AgentSessionCloseOptions,
  type AgentSessionCloseResult,
  type AgentStopReason,
  assertCloseBudgets,
  createAgentSessionCoordinator,
} from './coordinator';
import {
  type AgentRuntimeEvent,
  type AgentRuntimePublisher,
  agentDurableEventId,
} from './events';
import type { AgentHistoryProjectionOptions } from './history';
import { createAgentInjectionRegistry } from './injection';
import type { AgentResolvedModel } from './models';
import type { AgentObservability } from './observability';
import type { ComposedAgentPrompt } from './prompt';
import type { AgentTerminalAcceptanceInput } from './protocol';
import { createRunExecutor } from './run-execution';
import { findRun } from './runtime-internals';
import type { AgentRuntimeResult } from './runtime-result';
import {
  type AgentAssistantPlaceholder,
  AgentAssistantPlaceholderSchema,
  type AgentJsonObjectSchema,
  type AgentMessage,
  type AgentMessagePart,
  AgentMessageSchema,
  type AgentRun,
  AgentRunSchema,
  type AgentSnapshot,
} from './schemas';
import type {
  AgentRecoverableDescriptor,
  AgentRuntimeStore,
  AgentStoreMutationResult,
} from './store';
import { AgentRuntimeConflictError, appliedSnapshot } from './terminal-commit';
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
  const admissionLanes = createRuntimeAdmissionLanes();
  /**
   * Whether this runtime can ever inject, decided once from the configuration.
   *
   * A function policy might return `'inject'` for any input, so its mere
   * presence enables the machinery. When it cannot, the executor keeps exactly
   * the path it had before — no `prepareStep` it did not ask for, and no work
   * at any boundary.
   */
  const injectionPossible =
    typeof config.runs?.inputPolicy === 'function' || config.runs?.inputPolicy === 'inject';
  const injection = injectionPossible ? createAgentInjectionRegistry() : undefined;
  const reserveAdmission = admissionLanes.reserve;
  const settleAdmission = admissionLanes.settle;
  const waitForAdmissionAcceptances = admissionLanes.waitForAcceptances;
  const checkpointEveryEvents = config.loop?.checkpointEveryEvents ?? 20;
  const maxSteps = config.loop?.maxSteps ?? 50;
  // A default, because the alternative is "hang forever" and that is what a
  // consumer who configured nothing used to get.
  const declaredIdleTimeoutMs = config.loop?.idleTimeoutMs;
  const idleTimeoutMs =
    declaredIdleTimeoutMs === null ? undefined : (declaredIdleTimeoutMs ?? 60_000);
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
    } catch (error) {
      // Product delivery cannot roll back an already committed runtime transition.
      try {
        await config.onPublishError?.({ event, error });
      } catch {
        // Delivery diagnostics are isolated from the canonical run as well.
      }
    }
  };

  const executeRun = createRunExecutor<CONTEXT, TOOLS>({
    config,
    publish,
    runtimeEpoch,
    generateId,
    now,
    checkpointEveryEvents,
    maxSteps,
    ...(idleTimeoutMs !== undefined && { idleTimeoutMs }),
    ...(injection && { injection }),
  });

  /**
   * Admission belongs to the RUNTIME, not only to the coordinator.
   *
   * `close()` used to delegate straight to `coordinator.close()`, which refuses to
   * *execute* — and by the time it refuses, `submit()` has already run preflight,
   * written a durable input and a queued run to the store, and resolved
   * `accepted`. The result is exactly the state the close exists to prevent:
   * durable work with no executor, indistinguishable from a crash.
   *
   * So the gate is checked twice, and the second one is the load-bearing half: a
   * close that arrives while a preflight is in flight must still stop the write
   * that follows it. Before the store call the answer is a clean refusal; after
   * it there is nothing to refuse, and the coordinator's own drain owns the run.
   */
  let admissionClosed = false;
  const closedError = (): Error =>
    new Error('[stitchkit] agent runtime is closed and admits no further work');

  /**
   * Admissions that are PAST the gate and not yet handed to the coordinator.
   *
   * The gate above stops what has not started. This holds what already has, and
   * without it the gate is only half a close: a submission that passed the
   * check and is inside `acceptInputAndAssignRun` owns no coordinator lane yet,
   * so a `close()` that drains only the coordinator finds nothing, reports
   * `settled: true, remaining: 0`, and the store then commits a queued run for
   * it. The run lands with nothing to execute it — the exact state close exists
   * to prevent, reached through the door marked closed.
   *
   * An entry is released the moment the admission reaches one side or the
   * other: a refusal before the durable write, or a handoff the coordinator's
   * own drain now owns. It is never held for the length of a run.
   */
  const admissionsInFlight = new Set<PromiseWithResolvers<void>>();
  const beginAdmission = (): (() => void) => {
    const handoff = Promise.withResolvers<void>();
    admissionsInFlight.add(handoff);
    return () => {
      if (admissionsInFlight.delete(handoff)) handoff.resolve();
    };
  };

  /**
   * Wait for those admissions, and say how many never arrived.
   *
   * Bounded by the SAME budget the caller gave, not a second one beside it:
   * whatever this spends is taken off what the coordinator is then allowed to
   * spend, so "every combination is bounded" survives the extra wait.
   */
  const drainAdmissions = async (budgetMs: number | undefined): Promise<number> => {
    const pending = [...admissionsInFlight].map((handoff) => handoff.promise);
    if (pending.length === 0) return 0;
    let stranded = pending.length;
    const settled = Promise.all(
      pending.map((promise) =>
        promise.then(() => {
          stranded -= 1;
        }),
      ),
    );
    if (budgetMs === undefined) {
      await settled;
      return 0;
    }
    let timer: ReturnType<typeof setTimeout> | undefined;
    await Promise.race([
      settled,
      new Promise<void>((resolve) => {
        timer = setTimeout(resolve, budgetMs);
      }),
    ]);
    if (timer !== undefined) clearTimeout(timer);
    return stranded;
  };
  const refuse = <T>(): { accepted: Promise<void>; result: Promise<T> } => {
    const error = closedError();
    const accepted = Promise.reject<void>(error);
    const result = Promise.reject<T>(error);
    // Rejections a caller may legitimately ignore must not become unhandled.
    void accepted.catch(() => undefined);
    void result.catch(() => undefined);
    return { accepted, result };
  };

  const resume = (rawInput: AgentRuntimeRecoveryInput) => {
    if (admissionClosed) return refuse<AgentRuntimeResult>();
    const context = config.protocol.parseContext(rawInput.context);
    const accepted = Promise.withResolvers<void>();
    const result = Promise.withResolvers<AgentRuntimeResult>();
    let acquisitionSettled = false;
    const resolveAcquisition = (): void => {
      acquisitionSettled = true;
      accepted.resolve();
    };
    const rejectAcquisition = (error: unknown): void => {
      if (!acquisitionSettled) accepted.reject(error);
    };
    const handedOff = beginAdmission();
    void (async () => {
      try {
        const recovered = await config.store.loadRun({
          conversationId: rawInput.conversationId,
          runId: rawInput.runId,
        });
        if (!recovered) throw new AgentRuntimeConflictError('run lookup');
        const recoveredRun = recovered.run;
        if (recoveredRun.state !== 'queued') {
          throw new Error('Only a queued recovered agent run can be resumed');
        }
        const ticket = coordinator.submit({
          key: rawInput.conversationKey ?? rawInput.conversationId,
          policy: 'queue',
          create: (signal) => ({
            runId: recoveredRun.id,
            execute: () =>
              executeRun({
                acceptedRun: recoveredRun,
                context,
                signal,
                key: rawInput.conversationKey ?? rawInput.conversationId,
                onAcquired: resolveAcquisition,
              }),
          }),
        });
        void ticket.accepted.catch(() => undefined);
        void ticket.result.then(result.resolve, (error) => {
          rejectAcquisition(error);
          result.reject(error);
        });
      } catch (error) {
        rejectAcquisition(error);
        result.reject(error);
      } finally {
        handedOff();
      }
    })();
    return { accepted: accepted.promise, result: result.promise };
  };

  return {
    submit(rawInput) {
      if (admissionClosed) {
        const refused = refuse<AgentRuntimeResult>();
        const admission = Promise.reject<AgentRuntimeAdmission>(closedError());
        void admission.catch(() => undefined);
        return { ...refused, admission };
      }
      const metadata =
        rawInput.metadata === undefined
          ? undefined
          : config.protocol.parseInputMetadata(rawInput.metadata);
      const input = {
        conversationId: rawInput.conversationId,
        idempotencyKey: rawInput.idempotencyKey,
        context: rawInput.context,
        parts: rawInput.parts.map((part) => config.protocol.parsePart(part)),
        role: rawInput.role ?? 'user',
        ...(metadata !== undefined && { metadata }),
      };
      if (
        input.role === 'tool' &&
        (input.parts.length === 0 ||
          input.parts.some((part) => part.type !== 'tool-approval-response'))
      ) {
        throw new TypeError('Tool-role Agent input only accepts approval responses');
      }
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
        role: input.role,
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
        ...(policy === 'interrupt-next' && { queuePriority: 'interrupt-next' }),
        createdAt: nowIso,
        updatedAt: nowIso,
      });
      const outerAccepted = Promise.withResolvers<void>();
      const outerAdmission = Promise.withResolvers<AgentRuntimeAdmission>();
      void outerAdmission.promise.catch(() => undefined);
      const outerResult = Promise.withResolvers<AgentRuntimeResult>();
      const reservation =
        config.runs?.coalescePending && policy !== 'interrupt-next'
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
      // The run this submission's input was offered under, which is the
      // *assigned* run and not necessarily the proposed one: a coalesced input
      // joins an existing queued successor.
      let offeredRunId: string | undefined;
      const forgetTicket = (): void => {
        // An offer outlives nothing: once this submission has a result there is
        // no run left that could usefully take it on, and an entry nobody
        // withdraws is an entry a much later run could absorb.
        if (offeredRunId !== undefined) injection?.withdraw(key, offeredRunId);
        if (currentConversationTickets.get(input.idempotencyKey) !== publicTicket) return;
        currentConversationTickets.delete(input.idempotencyKey);
        if (currentConversationTickets.size === 0) tickets.delete(input.conversationId);
      };
      void outerResult.promise.then(forgetTicket, forgetTicket);
      const handedOff = beginAdmission();
      void (async () => {
        try {
          await previousAcceptance.catch(() => undefined);
          await config.models.preflight?.({
            context,
            conversationId: input.conversationId,
          });
          // Re-checked HERE, not only at the entry: preflight is a network call
          // to a provider, and a close arriving inside it would otherwise be
          // followed by this write.
          if (admissionClosed) throw closedError();
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
          const acceptedRun =
            acceptance.outcome === 'duplicate'
              ? acceptance.run
              : findRun(acceptedSnapshot.runs, assignedRunId);
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
              ? (acceptance.assistant ?? assistantPlaceholder)
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
            eventId: agentDurableEventId(
              'admission',
              acceptedRun.id,
              acceptedSnapshot.version,
            ),
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
            eventId: agentDurableEventId(
              'run-state',
              acceptedRun.id,
              acceptedSnapshot.version,
            ),
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
            const message = acceptance.assistant;
            if (!message) {
              const error = new Error(
                'Duplicate terminal admission has no retained canonical assistant',
              );
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
          // Offered, not committed. The input is already a durable queued run;
          // this only tells a run in flight on the same key that it MAY take it
          // on, and the absorption is written by that run's terminal commit or
          // not at all (→ ADR 0113). Offered before the coordinator handoff so
          // an input that arrives while a run is streaming can be taken at the
          // very next boundary, and offered for a coalesced input too — a
          // successor is absorbed whole or not at all, so every one of its
          // inputs has to be on the table.
          if (policy === 'inject') {
            offeredRunId = acceptedRun.id;
            injection?.offer(key, { runId: acceptedRun.id, input: acceptedInput });
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
                execute: () => executeRun({ acceptedRun, context, signal, key }),
              };
            },
          });
          // A close that already spent its budget rejects this handoff, and a
          // rejection nobody observes becomes an unhandled one. The result is
          // reported through `outerResult` below; this is only the guard.
          void ticket.accepted.catch(() => undefined);
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
          handedOff();
        }
      })();
      return publicTicket;
    },
    resume,
    async interrupt(input) {
      const view = await config.store.loadRun({
        conversationId: input.conversationId,
        runId: input.runId,
      });
      if (!view) throw new AgentRuntimeConflictError('run lookup');
      const requested = await config.store.requestRunInterrupt({
        conversationId: input.conversationId,
        runId: input.runId,
        expectedRevision: view.run.revision,
      });
      if (requested.outcome === 'applied') {
        const interruptedRun = findRun(requested.snapshot.runs, input.runId);
        await publish({
          type: 'run-state',
          eventId: agentDurableEventId(
            'run-state',
            interruptedRun.id,
            requested.snapshot.version,
          ),
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
      if (admissionClosed) throw closedError();
      const pageSize = options.pageSize ?? 100;
      const maxRuns = options.maxRuns ?? 1_000;
      if (!Number.isSafeInteger(pageSize) || pageSize < 1 || pageSize > 1_000) {
        throw new TypeError('Recovery pageSize must be an integer between 1 and 1000');
      }
      if (!Number.isSafeInteger(maxRuns) || maxRuns < 1) {
        throw new TypeError('Recovery maxRuns must be a positive safe integer');
      }
      const recoverable: AgentRecoverableDescriptor[] = [];
      let cursor: string | undefined;
      while (recoverable.length < maxRuns && !options.signal?.aborted && !admissionClosed) {
        const page = await config.store.scanRecoverable({
          ...(cursor && { cursor }),
          limit: Math.min(pageSize, maxRuns - recoverable.length),
        });
        recoverable.push(...page.items);
        cursor = page.nextCursor;
        if (!cursor || page.items.length === 0) break;
      }

      // A recovery cursor is an identity cursor, not a queue. Buffering remains
      // bounded by `maxRuns`, then each conversation is put back into the
      // store's canonical causal order before anything can acquire. Grouping
      // after the complete bounded scan is what makes a page boundary
      // semantically invisible.
      const grouped = new Map<string, AgentRecoverableDescriptor[]>();
      for (const item of recoverable) {
        const items = grouped.get(item.conversationId) ?? [];
        items.push(item);
        grouped.set(item.conversationId, items);
      }
      const ordered: AgentRecoverableDescriptor[] = [];
      for (const [conversationId, items] of grouped) {
        const active = await config.store.listActiveRuns(conversationId);
        const position = new Map(active.map((run, index) => [run.id, index]));
        ordered.push(
          ...items.sort((left, right) => {
            const leftPosition = position.get(left.run.id);
            const rightPosition = position.get(right.run.id);
            if (leftPosition === undefined && rightPosition === undefined) return 0;
            if (leftPosition === undefined) return 1;
            if (rightPosition === undefined) return -1;
            return leftPosition - rightPosition;
          }),
        );
      }

      const outcomes: AgentRuntimeRecoveryOutcome[] = [];
      const scheduledRuns = new Map<string, Set<string>>();
      for (const item of ordered) {
        if (options.signal?.aborted) break;
        // Per ITEM, not per page: a close arriving in the middle of a page
        // used to leave the rest of it to be recovered afterwards.
        if (admissionClosed) break;
        // One item's mutating slice, inside the same barrier admission uses.
        //
        // The gate at the top of `recover` and the one in the loop condition
        // stop what has not started; neither stops what is between
        // `decide()` and the durable write it leads to. A close arriving
        // inside that user callback used to return `settled: true` and then
        // watch `recoverRun` commit — a write after the runtime said it had
        // stopped writing. Held until the item reaches `resume`, which owns
        // the handoff from there.
        const releaseAdmission = beginAdmission();
        try {
          const active = await config.store.listActiveRuns(item.conversationId);
          const position = active.findIndex((run) => run.id === item.run.id);
          const scheduled = scheduledRuns.get(item.conversationId) ?? new Set<string>();
          const blockedByUnscheduledPredecessor =
            position > 0 && active.slice(0, position).some((run) => !scheduled.has(run.id));
          if (blockedByUnscheduledPredecessor) {
            outcomes.push({
              conversationId: item.conversationId,
              runId: item.run.id,
              outcome: 'skipped',
            });
            continue;
          }
          const decision =
            (await options.decide?.(item)) ??
            (item.run.state === 'queued' ? { action: 'resume' } : { action: 'skip' });
          // Re-read AFTER the callback: this is the last point before the
          // first durable write, and the callback is where a close fits.
          if (admissionClosed) throw closedError();
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
          scheduled.add(item.run.id);
          scheduledRuns.set(item.conversationId, scheduled);
          outcomes.push({
            conversationId: item.conversationId,
            runId: item.run.id,
            outcome: decision.action === 'requeue' ? 'requeued' : 'resumed',
            result: resumed.result,
          });
        } catch (error) {
          outcomes.push({
            conversationId: item.conversationId,
            runId: item.run.id,
            outcome: 'failed',
            error,
          });
        } finally {
          releaseAdmission();
        }
      }
      return outcomes;
    },
    stop: (conversationKey, reason) => coordinator.stop(conversationKey, reason),
    close: async (options = {}) => {
      // BEFORE the flag. A budget that is not a budget used to be discovered by
      // the coordinator, one await later — leaving a runtime that had stopped
      // admitting work and a caller holding a TypeError, with no way to undo
      // either. A refused call changes nothing.
      assertCloseBudgets(options);
      // Set before anything is awaited, so no admission can slip past while the
      // active runs are being drained.
      admissionClosed = true;
      // Then wait for the ones already inside. Whatever this spends is taken
      // off the coordinator's budget rather than added to it.
      //
      // Measured monotonically, not with `config.now`: that clock is the
      // runtime's SEMANTIC one — a caller may set it to a fixed instant for
      // deterministic timestamps, and a wall clock steps backwards on its own.
      // Either makes the subtraction below meaningless.
      const startedAt = performance.now();
      // Nothing may be taken on after this point: an offer is only ever a
      // *permission* to absorb, and a closing runtime grants none. Every entry
      // dropped here is still a queued run in the store, so recovery answers it.
      injection?.clear();
      const stranded = await drainAdmissions(options.forceTimeoutMs);
      const spent = Math.max(0, Math.round(performance.now() - startedAt));
      const remainingBudget = (value: number | undefined): number | undefined =>
        value === undefined ? undefined : Math.max(0, value - spent);
      const grace = remainingBudget(options.gracePeriodMs);
      const force = remainingBudget(options.forceTimeoutMs);
      const result = await coordinator.close({
        ...(grace !== undefined && { gracePeriodMs: grace }),
        ...(force !== undefined && { forceTimeoutMs: force }),
      });
      // An admission that never handed off is work this close is walking away
      // from just as surely as an unfinished run, and it is counted as such.
      if (stranded === 0) return result;
      return { settled: false, timedOut: true, remaining: result.remaining + stranded };
    },
  };
}
