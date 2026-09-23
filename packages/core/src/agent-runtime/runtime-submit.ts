import type { ToolSet } from 'ai';
import type { z } from 'zod';
import type { RuntimeAdmissionReservation } from './admission-lanes';
import type { AgentInputPolicy } from './coordinator';
import { agentDurableEventId } from './events';
import type { AgentRuntimeAdmission, AgentRuntimeInput } from './runtime';
import { closedError, refuse } from './runtime-admission-gate';
import { findRun } from './runtime-internals';
import type { AgentRuntimeResult } from './runtime-result';
import type { AgentRuntimeState, RuntimeTicket } from './runtime-state';
import {
  AgentAssistantPlaceholderSchema,
  type AgentJsonObjectSchema,
  type AgentMessage,
  type AgentMessagePart,
  AgentMessageSchema,
  type AgentRun,
  AgentRunSchema,
} from './schemas';
import type { AgentStoreMutationResult } from './store';
import { AgentRuntimeConflictError, appliedSnapshot } from './terminal-commit';

/** The caller's input after the protocol has parsed every part of it. */
interface SubmittedInput {
  conversationId: string;
  idempotencyKey: string;
  context: unknown;
  parts: AgentMessagePart[];
  role: 'user' | 'tool';
  metadata?: z.infer<typeof AgentJsonObjectSchema>;
}

/**
 * One submission between its synchronous entry and its coordinator handoff.
 *
 * Were the locals of `submit`; one object now so the admission phases below
 * take what they touch rather than closing over it.
 */
interface Submission<CONTEXT> {
  input: SubmittedInput;
  context: CONTEXT;
  key: string;
  policy: AgentInputPolicy;
  runId: string;
  userMessage: AgentMessage;
  queuedRun: AgentRun;
  reservation?: RuntimeAdmissionReservation;
  previousAcceptance: Promise<void>;
  acceptanceDone: PromiseWithResolvers<void>;
  outerAccepted: PromiseWithResolvers<void>;
  outerAdmission: PromiseWithResolvers<AgentRuntimeAdmission>;
  outerResult: PromiseWithResolvers<AgentRuntimeResult>;
  /**
   * The run this submission's input was offered under, which is the
   * *assigned* run and not necessarily the proposed one: a coalesced input
   * joins an existing queued successor.
   */
  offeredRunId?: string;
}

export function submitAgentInput<CONTEXT, TOOLS extends ToolSet>(
  state: AgentRuntimeState<CONTEXT, TOOLS>,
  rawInput: AgentRuntimeInput,
): RuntimeTicket {
  if (state.gate.closed) {
    const refused = refuse<AgentRuntimeResult>();
    const admission = Promise.reject<AgentRuntimeAdmission>(closedError());
    void admission.catch(() => undefined);
    return { ...refused, admission };
  }
  const input = parseSubmittedInput(state, rawInput);
  const context = state.config.protocol.parseContext(input.context);
  const conversationTickets = state.tickets.get(input.conversationId);
  const existingTicket = conversationTickets?.get(input.idempotencyKey);
  if (existingTicket) return existingTicket;
  const submission = createSubmission(state, rawInput, input, context);
  const publicTicket = registerTicket(state, submission, conversationTickets);
  const handedOff = state.gate.begin();
  void admitSubmission(state, submission, handedOff);
  return publicTicket;
}

function parseSubmittedInput<CONTEXT, TOOLS extends ToolSet>(
  state: AgentRuntimeState<CONTEXT, TOOLS>,
  rawInput: AgentRuntimeInput,
): SubmittedInput {
  const { protocol } = state.config;
  const metadata =
    rawInput.metadata === undefined
      ? undefined
      : protocol.parseInputMetadata(rawInput.metadata);
  const input = {
    conversationId: rawInput.conversationId,
    idempotencyKey: rawInput.idempotencyKey,
    context: rawInput.context,
    parts: rawInput.parts.map((part) => protocol.parsePart(part)),
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
  return input;
}

function createSubmission<CONTEXT, TOOLS extends ToolSet>(
  state: AgentRuntimeState<CONTEXT, TOOLS>,
  rawInput: AgentRuntimeInput,
  input: SubmittedInput,
  context: CONTEXT,
): Submission<CONTEXT> {
  const { config, generateId } = state;
  const key = config.runs?.key?.(input) ?? input.conversationId;
  const policy =
    typeof config.runs?.inputPolicy === 'function'
      ? config.runs.inputPolicy(input)
      : (config.runs?.inputPolicy ?? 'queue');
  const nowIso = state.now().toISOString();
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
  // Admission/result are alternative observations of the same refusal. A client
  // awaiting either must not leave the accepted projection unhandled.
  void outerAccepted.promise.catch(() => undefined);
  const outerAdmission = Promise.withResolvers<AgentRuntimeAdmission>();
  void outerAdmission.promise.catch(() => undefined);
  const outerResult = Promise.withResolvers<AgentRuntimeResult>();
  const reservation =
    config.runs?.coalescePending && policy !== 'interrupt-next'
      ? state.admissionLanes.reserve(key, runId)
      : undefined;
  const previousAcceptance = reservation?.lane.acceptanceTail ?? Promise.resolve();
  const acceptanceDone = Promise.withResolvers<void>();
  if (reservation) {
    reservation.lane.acceptanceTail = previousAcceptance
      .catch(() => undefined)
      .then(() => acceptanceDone.promise);
  }
  return {
    input,
    context,
    key,
    policy,
    runId,
    userMessage,
    queuedRun,
    ...(reservation && { reservation }),
    previousAcceptance,
    acceptanceDone,
    outerAccepted,
    outerAdmission,
    outerResult,
  };
}

function registerTicket<CONTEXT, TOOLS extends ToolSet>(
  state: AgentRuntimeState<CONTEXT, TOOLS>,
  submission: Submission<CONTEXT>,
  conversationTickets: Map<string, RuntimeTicket> | undefined,
): RuntimeTicket {
  const { input, key } = submission;
  const publicTicket = {
    accepted: submission.outerAccepted.promise,
    admission: submission.outerAdmission.promise,
    result: submission.outerResult.promise,
  };
  const currentConversationTickets = conversationTickets ?? new Map<string, RuntimeTicket>();
  currentConversationTickets.set(input.idempotencyKey, publicTicket);
  if (!conversationTickets) {
    state.tickets.set(input.conversationId, currentConversationTickets);
  }
  const forgetTicket = (): void => {
    // An offer outlives nothing: once this submission has a result there is
    // no run left that could usefully take it on, and an entry nobody
    // withdraws is an entry a much later run could absorb.
    if (submission.offeredRunId !== undefined) {
      state.injection?.withdraw(key, submission.offeredRunId);
    }
    if (currentConversationTickets.get(input.idempotencyKey) !== publicTicket) return;
    currentConversationTickets.delete(input.idempotencyKey);
    if (currentConversationTickets.size === 0) state.tickets.delete(input.conversationId);
  };
  void submission.outerResult.promise.then(forgetTicket, forgetTicket);
  return publicTicket;
}

/** Preflight, the durable write, the admission events, then the handoff — in that order. */
async function admitSubmission<CONTEXT, TOOLS extends ToolSet>(
  state: AgentRuntimeState<CONTEXT, TOOLS>,
  submission: Submission<CONTEXT>,
  handedOff: () => void,
): Promise<void> {
  const { config } = state;
  const { input, reservation, key } = submission;
  try {
    await submission.previousAcceptance.catch(() => undefined);
    await config.models.preflight?.({
      context: submission.context,
      conversationId: input.conversationId,
    });
    // Re-checked HERE, not only at the entry: preflight is a network call
    // to a provider, and a close arriving inside it would otherwise be
    // followed by this write.
    if (state.gate.closed) throw closedError();
    const acceptance = await config.store.acceptInputAndAssignRun({
      idempotencyKey: input.idempotencyKey,
      input: submission.userMessage,
      run: submission.queuedRun,
      ...(reservation &&
        !reservation.shouldSchedule && {
          coalesceIntoRunId: reservation.admission.runId,
        }),
    });
    const admission = projectAdmission(submission, acceptance);
    submission.outerAdmission.resolve(admission);
    await publishAdmission(state, admission);
    submission.outerAccepted.resolve();
    if (acceptance.outcome === 'duplicate') {
      settleDuplicate(state, submission, admission, acceptance.assistant);
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
    if (submission.policy === 'inject') {
      submission.offeredRunId = admission.run.id;
      state.injection?.offer(key, { runId: admission.run.id, input: admission.input });
    }
    if (reservation && !reservation.shouldSchedule) {
      void reservation.admission.completion.promise.then(
        submission.outerResult.resolve,
        submission.outerResult.reject,
      );
      return;
    }
    handOffToCoordinator(state, submission, admission.run);
  } catch (error) {
    submission.outerAccepted.reject(error);
    submission.outerAdmission.reject(error);
    submission.outerResult.reject(error);
    if (reservation?.shouldSchedule) {
      reservation.admission.completion.reject(error);
      state.admissionLanes.settle(key, reservation.admission);
    }
  } finally {
    submission.acceptanceDone.resolve();
    handedOff();
  }
}

/** What the store accepted, as the caller sees it: the assigned run, not the proposed one. */
function projectAdmission<CONTEXT>(
  submission: Submission<CONTEXT>,
  acceptance: AgentStoreMutationResult,
): AgentRuntimeAdmission {
  const acceptedSnapshot = appliedSnapshot(acceptance, 'input acceptance');
  const assignedRunId =
    acceptance.outcome === 'duplicate'
      ? acceptance.runId
      : (submission.reservation?.admission.runId ?? submission.runId);
  const acceptedRun =
    acceptance.outcome === 'duplicate'
      ? acceptance.run
      : findRun(acceptedSnapshot.runs, assignedRunId);
  const actualInputMessageId =
    acceptance.outcome === 'duplicate' ? acceptance.inputMessageId : submission.userMessage.id;
  const acceptedInput =
    acceptance.outcome === 'duplicate'
      ? acceptance.input
      : acceptedSnapshot.messages.find((candidate) => candidate.id === actualInputMessageId);
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
  return {
    inputMessageId: acceptedInput.id,
    runId: acceptedRun.id,
    assistantMessageId: assistantPlaceholder.id,
    input: acceptedInput,
    run: acceptedRun,
    assistant: acceptedAssistant,
    snapshotVersion: acceptedSnapshot.version,
  };
}

async function publishAdmission<CONTEXT, TOOLS extends ToolSet>(
  state: AgentRuntimeState<CONTEXT, TOOLS>,
  admission: AgentRuntimeAdmission,
): Promise<void> {
  const { run, snapshotVersion } = admission;
  await state.publish({
    type: 'admission',
    eventId: agentDurableEventId('admission', run.id, snapshotVersion),
    conversationId: run.conversationId,
    runId: run.id,
    snapshotVersion,
    input: admission.input,
    run,
    assistant: admission.assistant,
    emittedAt: state.now().toISOString(),
  });
  await state.publish({
    type: 'run-state',
    eventId: agentDurableEventId('run-state', run.id, snapshotVersion),
    conversationId: run.conversationId,
    runId: run.id,
    snapshotVersion,
    state: run.state,
    emittedAt: state.now().toISOString(),
  });
}

/** A duplicate input answers from the durable record; it never schedules a run. */
function settleDuplicate<CONTEXT, TOOLS extends ToolSet>(
  state: AgentRuntimeState<CONTEXT, TOOLS>,
  submission: Submission<CONTEXT>,
  admission: AgentRuntimeAdmission,
  retainedAssistant: AgentMessage | undefined,
): void {
  const { reservation, key, outerResult } = submission;
  const acceptedRun = admission.run;
  const refuseDuplicate = (error: Error): void => {
    outerResult.reject(error);
    if (reservation?.shouldSchedule) {
      reservation.admission.completion.reject(error);
      state.admissionLanes.settle(key, reservation.admission);
    }
  };
  if (!acceptedRun.terminalReason) {
    refuseDuplicate(
      new Error('Duplicate input is already owned by another runtime execution'),
    );
    return;
  }
  const message = retainedAssistant;
  if (!message) {
    refuseDuplicate(
      new Error('Duplicate terminal admission has no retained canonical assistant'),
    );
    return;
  }
  outerResult.resolve({
    run: acceptedRun,
    message,
    reason: acceptedRun.terminalReason,
    snapshotVersion: admission.snapshotVersion,
    ...(acceptedRun.terminalPolicyName && {
      policyName: acceptedRun.terminalPolicyName,
    }),
  });
  if (reservation?.shouldSchedule) {
    reservation.admission.completion.reject(
      new Error('Reserved run resolved to a duplicate durable input'),
    );
    state.admissionLanes.settle(key, reservation.admission);
  }
}

function handOffToCoordinator<CONTEXT, TOOLS extends ToolSet>(
  state: AgentRuntimeState<CONTEXT, TOOLS>,
  submission: Submission<CONTEXT>,
  acceptedRun: AgentRun,
): void {
  const { reservation, key, context, outerResult } = submission;
  const ticket = state.coordinator.submit({
    key,
    policy: submission.policy,
    create: async (signal) => {
      if (reservation) await state.admissionLanes.waitForAcceptances(reservation.lane);
      return {
        runId: acceptedRun.id,
        execute: () => state.executeRun({ acceptedRun, context, signal, key }),
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
        state.admissionLanes.settle(key, reservation.admission);
        outerResult.resolve(value);
      },
      (error) => {
        state.admissionLanes.settle(key, reservation.admission);
        outerResult.reject(error);
      },
    );
  } else {
    void ticket.result.then(outerResult.resolve, outerResult.reject);
  }
}
