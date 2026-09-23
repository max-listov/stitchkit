import { AgentRunSchema, type AgentSnapshot } from './schemas';
import type {
  AcceptInputAndAssignRun,
  ReplaceCompactedRange,
  SeedConversationInput,
} from './store';
import {
  AgentAdmissionReceiptSchema,
  AgentSeedReceiptSchema,
  AgentStoredRunSchema,
  isActiveRunState,
} from './store-driver-contract';
import { applied, conflict, type ReducedMutation } from './store-reduce-shared';
import { replaceRun } from './store-snapshot';

/** Admit one input and assign it to a new queued run, or coalesce it into one. */
export function reduceAccept(
  current: AgentSnapshot,
  input: AcceptInputAndAssignRun,
): ReducedMutation {
  if (input.expectedVersion !== undefined && input.expectedVersion !== current.version) {
    return conflict(current.version);
  }
  const coalescedRun = input.coalesceIntoRunId
    ? current.runs.find((candidate) => candidate.id === input.coalesceIntoRunId)
    : undefined;
  if (
    input.coalesceIntoRunId !== undefined &&
    (!coalescedRun ||
      coalescedRun.conversationId !== input.input.conversationId ||
      coalescedRun.state !== 'queued' ||
      coalescedRun.ownerId !== undefined ||
      coalescedRun.terminalReason !== undefined)
  ) {
    return coalescedRun ? conflict(coalescedRun.revision) : { outcome: 'not_found' };
  }
  if (
    input.run.conversationId !== input.input.conversationId ||
    input.run.inputMessageIds.length !== 1 ||
    input.run.inputMessageIds[0] !== input.input.id ||
    input.run.state !== 'queued' ||
    input.run.revision !== 0 ||
    input.run.executionSequence !== undefined ||
    input.run.ownerId !== undefined ||
    input.run.terminalReason !== undefined ||
    input.run.terminalPolicyName !== undefined ||
    (input.input.role !== 'user' && input.input.role !== 'tool') ||
    input.input.status !== 'committed' ||
    input.input.runId !== undefined ||
    current.messages.some((message) => message.id === input.input.id) ||
    (coalescedRun !== undefined && input.input.id === coalescedRun.assistantMessageId) ||
    (!coalescedRun &&
      (input.run.assistantMessageId === input.input.id ||
        current.runs.some((candidate) => candidate.id === input.run.id) ||
        current.runs.some(
          (candidate) => candidate.assistantMessageId === input.run.assistantMessageId,
        ) ||
        current.messages.some((message) => message.id === input.run.assistantMessageId)))
  ) {
    throw new TypeError('Input and queued run do not form one valid assignment');
  }
  const assignedRun = coalescedRun
    ? AgentRunSchema.parse({
        ...coalescedRun,
        inputMessageIds: [...coalescedRun.inputMessageIds, input.input.id],
        revision: coalescedRun.revision + 1,
        updatedAt: new Date().toISOString(),
      })
    : input.run;
  const admissionReceipt = AgentAdmissionReceiptSchema.parse({
    schemaVersion: 1,
    conversationId: input.input.conversationId,
    idempotencyKey: input.idempotencyKey,
    input: input.input,
    runId: assignedRun.id,
    assistantMessageId: assignedRun.assistantMessageId,
  });
  return applied(
    current,
    {
      messages: [...current.messages, input.input],
      runs: coalescedRun
        ? replaceRun(current.runs, assignedRun)
        : [...current.runs, assignedRun],
    },
    {
      runRecords: [AgentStoredRunSchema.parse({ schemaVersion: 1, run: assignedRun })],
      admissionReceipt,
      historyMutations: [{ type: 'admit', input: input.input }],
    },
  );
}

/** Prepend a keyed user-instruction seed ahead of the conversation. */
export function reduceSeed(
  current: AgentSnapshot,
  input: SeedConversationInput,
): ReducedMutation {
  const conversationId = input.conversationId;
  if (current.conversationId !== conversationId) return { outcome: 'not_found' };
  for (const message of input.inputs) {
    if (
      message.conversationId !== conversationId ||
      message.role !== 'user' ||
      message.status !== 'committed' ||
      message.runId !== undefined
    ) {
      throw new TypeError('Seeded conversation input must be committed unowned user messages');
    }
  }
  // Prepend: user instructions lead the durable conversation they were seeded
  // ahead of, even though the first turn's input was admitted before the
  // prompt definitions existed to seed them.
  return applied(
    current,
    { messages: [...input.inputs, ...current.messages] },
    {
      seedReceipt: AgentSeedReceiptSchema.parse({
        schemaVersion: 1,
        conversationId,
        seedKey: input.seedKey,
        messageIds: input.inputs.map((message) => message.id),
      }),
      // Applied front-first, so the persisted order matches the snapshot:
      // each prepend lands ahead of the one before it.
      historyMutations: [...input.inputs].reverse().map((message) => ({
        type: 'seed' as const,
        message,
      })),
    },
  );
}

/** Replace one contiguous range of finished history with its summary. */
export function reduceCompact(
  current: AgentSnapshot,
  input: ReplaceCompactedRange,
): ReducedMutation {
  if (current.conversationId !== input.conversationId) return { outcome: 'not_found' };
  if (current.version !== input.expectedVersion) return conflict(current.version);
  const replaced = new Set(input.replacedMessageIds);
  if (!input.replacedMessageIds.every((id) => current.messages.some((m) => m.id === id))) {
    return { outcome: 'not_found' };
  }
  // A live run's assistant message is not history yet. Deleting it left the
  // summary claiming to contain a turn while the run's next checkpoint
  // re-appended the same message *after* the summary, with its user input
  // gone. `structuredCompaction` avoids this by refusing an unspeakable
  // turn, but `history.compact` is a supported callback and
  // `replaceCompactedRange` is a public store operation — neither refused it.
  const liveAssistant = current.runs.find(
    (candidate) =>
      isActiveRunState(candidate.state) && replaced.has(candidate.assistantMessageId),
  );
  if (liveAssistant) {
    throw new TypeError(
      `Compaction may not replace the assistant message of run ${liveAssistant.id}, which has not finished`,
    );
  }
  const positions = current.messages
    .map((message, index) => (replaced.has(message.id) ? index : undefined))
    .filter((index) => index !== undefined);
  const first = positions[0];
  if (
    first === undefined ||
    positions.some((position, offset) => position !== first + offset) ||
    input.summary.conversationId !== input.conversationId ||
    input.summary.runId !== undefined ||
    input.summary.role !== 'summary' ||
    input.summary.status !== 'committed' ||
    current.messages.some((message) => message.id === input.summary.id) ||
    current.runs.some((candidate) => candidate.assistantMessageId === input.summary.id)
  ) {
    throw new TypeError('Compaction replacement must be one valid contiguous history range');
  }
  const messages = [
    ...current.messages.slice(0, first),
    input.summary,
    ...current.messages.slice(first + positions.length),
  ];
  return applied(
    current,
    { messages },
    {
      historyMutations: [
        {
          type: 'replace-compacted-range',
          replacedMessageIds: input.replacedMessageIds,
          summary: input.summary,
        },
      ],
    },
  );
}
