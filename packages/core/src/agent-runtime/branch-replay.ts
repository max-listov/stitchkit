import { createHash } from 'node:crypto';
import { z } from 'zod';
import type { AgentStoreEventEnvelope } from '../durability/events';
import { AgentConversationBranchReceiptSchema } from './branch-contract';
import {
  type AgentMessage,
  AgentMessageSchema,
  type AgentSnapshot,
  AgentSnapshotSchema,
  AgentUsageSchema,
} from './schemas';
import {
  AgentAdmissionReceiptSchema,
  AgentRuntimeHeadSchema,
  AgentStoredRunSchema,
} from './store-driver-contract';
import { AgentStoreTransitionSchema, canonicalAgentJson } from './store-events';
import type { ReducedApplied, StoreOperation } from './store-reduce-shared';
import { reduceStore } from './store-reducer';
import { snapshotOf } from './store-snapshot';

export const BranchBaselineSchema = z
  .object({
    migratedAt: z.iso.datetime({ offset: true }),
    asOf: z.iso.datetime({ offset: true }).optional(),
    head: AgentRuntimeHeadSchema,
    messages: z.array(AgentMessageSchema),
    compacted: z.array(z.string().min(1)).optional(),
    runs: z.array(AgentStoredRunSchema),
    admissions: z.array(AgentAdmissionReceiptSchema),
  })
  .strict();

const CheckpointRecordSchema = z
  .object({
    type: z.literal('checkpoint'),
    input: z
      .object({
        conversationId: z.string().min(1),
        runId: z.string().min(1),
        expectedRevision: z.int().nonnegative(),
        ownerId: z.string().min(1),
        fencingToken: z.int().nonnegative().optional(),
        assistant: z
          .object({
            id: z.string().min(1),
            status: z.literal('streaming'),
            sha256: z
              .string()
              .regex(/^[a-f0-9]{64}$/)
              .optional(),
            sourceSha256: z
              .string()
              .regex(/^[a-f0-9]{64}$/)
              .optional(),
            parts: z.int().nonnegative(),
            bytes: z.int().nonnegative(),
          })
          .strict(),
        usage: AgentUsageSchema.optional(),
      })
      .strict(),
  })
  .strict()
  .refine(
    (value) =>
      Boolean(value.input.assistant.sha256) !== Boolean(value.input.assistant.sourceSha256),
  );

export function branchTransition(event: AgentStoreEventEnvelope): StoreOperation {
  const checkpoint = CheckpointRecordSchema.safeParse(event.payload);
  if (!checkpoint.success) return AgentStoreTransitionSchema.parse(event.payload);
  const input = checkpoint.data.input;
  if (canonicalAgentJson(checkpoint.data) !== canonicalAgentJson(event.payload))
    throw new TypeError('Branch checkpoint contains an unknown opaque field');
  // A hash-only checkpoint is a revision fact, not recoverable draft content.
  // Only a later full terminal message can make this prefix branchable.
  return AgentStoreTransitionSchema.parse({
    type: 'checkpoint',
    input: {
      ...input,
      assistant: {
        schemaVersion: 1,
        id: input.assistant.id,
        conversationId: input.conversationId,
        runId: input.runId,
        role: 'assistant',
        status: 'streaming',
        parts: [],
        createdAt: event.occurredAt,
        updatedAt: event.occurredAt,
      },
    },
  });
}

export interface BranchReplay {
  snapshot: AgentSnapshot;
  effects: Omit<ReducedApplied, 'outcome' | 'snapshot'>[];
  baseline?: z.infer<typeof BranchBaselineSchema>;
  /** Abandoning a hash-only draft cannot recreate the text that was lost. */
  unresolvedDrafts: Set<string>;
  retainedMessages: Map<string, AgentMessage>;
}

export function replayBranchEvents(
  conversationId: string,
  events: readonly AgentStoreEventEnvelope[],
  retainedSnapshot?: AgentSnapshot,
): BranchReplay {
  const result: BranchReplay = {
    snapshot: AgentSnapshotSchema.parse({
      schemaVersion: 1,
      conversationId,
      version: 0,
      messages: [],
      runs: [],
    }),
    effects: [],
    unresolvedDrafts: new Set(),
    retainedMessages: new Map(),
  };
  for (const event of events) {
    if (event.kind === 'runtime/baseline') {
      if (event.seq !== 1 || result.snapshot.version !== 0)
        throw new TypeError('Branch baseline must be the first event');
      const baseline = BranchBaselineSchema.parse(event.payload);
      if (baseline.head.conversationId !== conversationId)
        throw new TypeError('Branch baseline has a foreign conversation');
      const compacted = new Set(baseline.compacted);
      snapshotOf(baseline.head, baseline.messages, baseline.runs);
      const keys = new Set<string>();
      for (const record of baseline.runs) {
        if (
          record.run.inputMessageIds.some(
            (id) => !baseline.messages.some((message) => message.id === id),
          )
        )
          throw new TypeError('Branch baseline run references missing input');
      }
      for (const admission of baseline.admissions) {
        const run = baseline.runs.find((record) => record.run.id === admission.runId)?.run;
        if (
          keys.has(admission.idempotencyKey) ||
          admission.conversationId !== conversationId ||
          admission.input.conversationId !== conversationId ||
          !run ||
          !run.inputMessageIds.includes(admission.input.id) ||
          run.assistantMessageId !== admission.assistantMessageId ||
          !baseline.messages.some(
            (message) =>
              message.id === admission.input.id &&
              canonicalAgentJson(message) === canonicalAgentJson(admission.input),
          )
        )
          throw new TypeError('Branch baseline admission is inconsistent');
        keys.add(admission.idempotencyKey);
      }
      if (
        compacted.size !== (baseline.compacted?.length ?? 0) ||
        [...compacted].some((id) => !baseline.messages.some((m) => m.id === id))
      )
        throw new TypeError('Branch baseline compacted identities are inconsistent');
      result.snapshot = snapshotOf(
        baseline.head,
        baseline.messages.filter((m) => !compacted.has(m.id)),
        baseline.runs,
      );
      result.baseline = baseline;
      continue;
    }
    if (event.kind === 'runtime/branched') {
      const receipt = AgentConversationBranchReceiptSchema.parse(event.payload);
      if (receipt.conversationId !== conversationId)
        throw new TypeError('Branch receipt has a foreign conversation');
      result.snapshot = {
        ...result.snapshot,
        runs: result.snapshot.runs.map(
          ({ ownerId: _owner, fencingToken: _fence, ...run }) => run,
        ),
      };
      continue;
    }
    if (event.kind !== 'runtime/transition') continue;
    let operation = branchTransition(event);
    if (operation.type === 'checkpoint' && retainedSnapshot) {
      const record = CheckpointRecordSchema.safeParse(event.payload);
      const assistantId = operation.input.assistant.id;
      const retained = retainedSnapshot.messages.find((message) => message.id === assistantId);
      if (
        record.success &&
        retained &&
        record.data.input.assistant.sha256 ===
          createHash('sha256').update(canonicalAgentJson(retained)).digest('hex')
      ) {
        operation = { ...operation, input: { ...operation.input, assistant: retained } };
        result.retainedMessages.set(event.eventId, retained);
      }
    }
    if (
      operation.type === 'recover' &&
      operation.input.action === 'abandon' &&
      !operation.assistant &&
      retainedSnapshot
    ) {
      const runId = operation.input.runId;
      const run = result.snapshot.runs.find((run) => run.id === runId);
      const retained = retainedSnapshot.messages.find(
        (message) =>
          message.id === run?.assistantMessageId &&
          message.runId === runId &&
          message.role === 'assistant' &&
          message.status === 'failed',
      );
      if (retained) operation = { ...operation, assistant: retained };
    }
    if (
      operation.type === 'recover' &&
      operation.input.action === 'abandon' &&
      !operation.assistant
    )
      throw new TypeError('Branch archive has no exact retained abandoned assistant');
    const inputConversation =
      operation.type === 'accept'
        ? operation.input.input.conversationId
        : operation.input.conversationId;
    if (inputConversation !== conversationId)
      throw new TypeError('Branch transition has a foreign conversation');
    const reduced = reduceStore(result.snapshot, operation);
    if (reduced.outcome !== 'applied')
      throw new TypeError(
        `Branch transition at sequence ${event.seq} is inconsistent: ${reduced.outcome}`,
      );
    // A reducer uses the current wall clock; archive replay uses its recorded event time.
    const runRecords = reduced.runRecords?.map((record) => ({
      ...record,
      run: { ...record.run, updatedAt: event.occurredAt },
    }));
    result.snapshot = {
      ...reduced.snapshot,
      runs: reduced.snapshot.runs.map(
        (run) => runRecords?.find((record) => record.run.id === run.id)?.run ?? run,
      ),
    };
    const { snapshot: _snapshot, outcome: _outcome, ...effects } = reduced;
    result.effects.push({ ...effects, ...(runRecords && { runRecords }) });
    if (operation.type === 'recover' && operation.input.action === 'abandon') {
      const runId = operation.input.runId;
      const assistant = reduced.runRecords?.find(
        (record) => record.run.id === runId,
      )?.terminalAssistant;
      if (assistant) result.retainedMessages.set(event.eventId, assistant);
      if (operation.assistant) result.unresolvedDrafts.delete(runId);
    }
    if (
      operation.type === 'checkpoint' &&
      CheckpointRecordSchema.safeParse(event.payload).success
    )
      result.unresolvedDrafts.add(operation.input.runId);
    if (operation.type === 'terminal') result.unresolvedDrafts.delete(operation.input.runId);
  }
  return result;
}
