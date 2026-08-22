import { z } from 'zod';
import {
  type AgentMessage,
  AgentMessageSchema,
  AgentRecordIdSchema,
  AgentRecordVersionSchema,
  type AgentRun,
  AgentRunSchema,
  type AgentSnapshot,
  AgentSnapshotSchema,
  AgentTerminalReasonSchema,
} from './schemas';

export const AgentStoreConflictSchema = z.object({
  outcome: z.literal('conflict'),
  actualVersion: AgentRecordVersionSchema,
});

export const AgentStoreNotFoundSchema = z.object({
  outcome: z.literal('not_found'),
});

export const AgentStoreAppliedSchema = z.object({
  outcome: z.literal('applied'),
  snapshot: AgentSnapshotSchema,
});

export const AgentStoreDuplicateSchema = z.object({
  outcome: z.literal('duplicate'),
  runId: AgentRecordIdSchema,
  snapshot: AgentSnapshotSchema,
});

export const AgentStoreMutationResultSchema = z.discriminatedUnion('outcome', [
  AgentStoreAppliedSchema,
  AgentStoreDuplicateSchema,
  AgentStoreConflictSchema,
  AgentStoreNotFoundSchema,
]);

export type AgentStoreMutationResult = z.infer<typeof AgentStoreMutationResultSchema>;

export const AcceptInputAndAssignRunSchema = z.object({
  idempotencyKey: z.string().min(1),
  expectedVersion: AgentRecordVersionSchema.optional(),
  input: AgentMessageSchema,
  run: AgentRunSchema,
  coalesceIntoRunId: AgentRecordIdSchema.optional(),
});

export const AcquireAgentRunSchema = z.object({
  conversationId: AgentRecordIdSchema,
  runId: AgentRecordIdSchema,
  expectedRevision: AgentRecordVersionSchema,
  ownerId: z.string().min(1),
});

export const CheckpointRunAssistantSchema = z.object({
  conversationId: AgentRecordIdSchema,
  runId: AgentRecordIdSchema,
  expectedRevision: AgentRecordVersionSchema,
  ownerId: z.string().min(1),
  assistant: AgentMessageSchema,
});

export const CommitRunTerminalSchema = z.object({
  conversationId: AgentRecordIdSchema,
  runId: AgentRecordIdSchema,
  expectedRevision: AgentRecordVersionSchema,
  ownerId: z.string().min(1),
  assistant: AgentMessageSchema,
  reason: AgentTerminalReasonSchema,
  policyName: z.string().min(1).optional(),
});

export const RequestRunInterruptSchema = z.object({
  conversationId: AgentRecordIdSchema,
  runId: AgentRecordIdSchema,
  expectedRevision: AgentRecordVersionSchema,
});

export const RecoverAgentRunSchema = z.object({
  conversationId: AgentRecordIdSchema,
  runId: AgentRecordIdSchema,
  expectedRevision: AgentRecordVersionSchema,
  action: z.enum(['requeue', 'abandon']),
  replaySafe: z.boolean().optional(),
});

export const ReplaceCompactedRangeSchema = z.object({
  conversationId: AgentRecordIdSchema,
  expectedVersion: AgentRecordVersionSchema,
  replacedMessageIds: z.array(AgentRecordIdSchema).min(1),
  summary: AgentMessageSchema,
});

export type AcceptInputAndAssignRun = z.infer<typeof AcceptInputAndAssignRunSchema>;
export type AcquireAgentRun = z.infer<typeof AcquireAgentRunSchema>;
export type CheckpointRunAssistant = z.infer<typeof CheckpointRunAssistantSchema>;
export type CommitRunTerminal = z.infer<typeof CommitRunTerminalSchema>;
export type RequestRunInterrupt = z.infer<typeof RequestRunInterruptSchema>;
export type RecoverAgentRun = z.infer<typeof RecoverAgentRunSchema>;
export type ReplaceCompactedRange = z.infer<typeof ReplaceCompactedRangeSchema>;

export interface AgentRuntimeStore {
  loadSnapshot(conversationId: string): Promise<AgentSnapshot>;
  acceptInputAndAssignRun(input: AcceptInputAndAssignRun): Promise<AgentStoreMutationResult>;
  acquireRun(input: AcquireAgentRun): Promise<AgentStoreMutationResult>;
  checkpointRunAssistant(input: CheckpointRunAssistant): Promise<AgentStoreMutationResult>;
  requestRunInterrupt(input: RequestRunInterrupt): Promise<AgentStoreMutationResult>;
  recoverRun(input: RecoverAgentRun): Promise<AgentStoreMutationResult>;
  commitRunTerminal(input: CommitRunTerminal): Promise<AgentStoreMutationResult>;
  replaceCompactedRange(input: ReplaceCompactedRange): Promise<AgentStoreMutationResult>;
  scanRecoverable(): Promise<readonly AgentSnapshot[]>;
}

interface MemoryConversation {
  snapshot: AgentSnapshot;
  idempotency: Map<string, string>;
}

function emptySnapshot(conversationId: string): AgentSnapshot {
  return AgentSnapshotSchema.parse({
    schemaVersion: 1,
    conversationId,
    version: 0,
    messages: [],
    runs: [],
  });
}

function cloneSnapshot(snapshot: AgentSnapshot): AgentSnapshot {
  return AgentSnapshotSchema.parse(structuredClone(snapshot));
}

function replaceRun(runs: readonly AgentRun[], next: AgentRun): AgentRun[] {
  return runs.map((run) => (run.id === next.id ? next : run));
}

function replaceMessage(
  messages: readonly AgentMessage[],
  next: AgentMessage,
): AgentMessage[] {
  const exists = messages.some((message) => message.id === next.id);
  if (!exists) return [...messages, next];
  return messages.map((message) => (message.id === next.id ? next : message));
}

function terminalState(reason: z.infer<typeof AgentTerminalReasonSchema>): AgentRun['state'] {
  if (reason === 'success' || reason === 'policy_stop') return 'completed';
  if (reason === 'interrupted') return 'interrupted';
  if (reason === 'cancelled' || reason === 'shutdown' || reason === 'timeout') {
    return 'cancelled';
  }
  if (reason === 'abandoned') return 'abandoned';
  return 'failed';
}

function terminalMessageStatus(
  reason: z.infer<typeof AgentTerminalReasonSchema>,
): AgentMessage['status'] {
  if (reason === 'success' || reason === 'policy_stop') return 'completed';
  if (reason === 'interrupted' || reason === 'cancelled' || reason === 'shutdown') {
    return 'interrupted';
  }
  return 'failed';
}

/** In-memory reference adapter. It is process-local and deliberately offers no lease guarantee. */
export function createMemoryAgentRuntimeStore(): AgentRuntimeStore {
  const conversations = new Map<string, MemoryConversation>();

  const get = (conversationId: string): MemoryConversation => {
    const existing = conversations.get(conversationId);
    if (existing) return existing;
    const created = { snapshot: emptySnapshot(conversationId), idempotency: new Map() };
    conversations.set(conversationId, created);
    return created;
  };

  const conflict = (actualVersion: number): AgentStoreMutationResult => ({
    outcome: 'conflict',
    actualVersion,
  });

  const apply = (
    entry: MemoryConversation,
    snapshot: AgentSnapshot,
  ): AgentStoreMutationResult => {
    entry.snapshot = AgentSnapshotSchema.parse(snapshot);
    return { outcome: 'applied', snapshot: cloneSnapshot(entry.snapshot) };
  };

  return {
    async loadSnapshot(conversationId) {
      return cloneSnapshot(get(conversationId).snapshot);
    },

    async acceptInputAndAssignRun(rawInput) {
      const input = AcceptInputAndAssignRunSchema.parse(rawInput);
      const entry = get(input.input.conversationId);
      const duplicateRunId = entry.idempotency.get(input.idempotencyKey);
      if (duplicateRunId !== undefined) {
        return {
          outcome: 'duplicate',
          runId: duplicateRunId,
          snapshot: cloneSnapshot(entry.snapshot),
        };
      }
      if (
        input.run.conversationId !== input.input.conversationId ||
        input.run.inputMessageIds.length !== 1 ||
        input.run.inputMessageIds[0] !== input.input.id ||
        input.run.state !== 'queued' ||
        input.run.revision !== 0 ||
        input.run.ownerId !== undefined ||
        input.run.terminalReason !== undefined ||
        input.run.terminalPolicyName !== undefined ||
        input.input.role !== 'user' ||
        input.input.status !== 'committed' ||
        input.input.runId !== undefined ||
        entry.snapshot.messages.some((message) => message.id === input.input.id) ||
        entry.snapshot.runs.some((candidate) => candidate.id === input.run.id)
      ) {
        throw new TypeError('Input and queued run do not form one valid assignment');
      }
      if (
        input.expectedVersion !== undefined &&
        input.expectedVersion !== entry.snapshot.version
      ) {
        return conflict(entry.snapshot.version);
      }
      const coalescedRun = input.coalesceIntoRunId
        ? entry.snapshot.runs.find((candidate) => candidate.id === input.coalesceIntoRunId)
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
      const assignedRun = coalescedRun
        ? AgentRunSchema.parse({
            ...coalescedRun,
            inputMessageIds: [...coalescedRun.inputMessageIds, input.input.id],
            revision: coalescedRun.revision + 1,
            updatedAt: new Date().toISOString(),
          })
        : input.run;
      const next = AgentSnapshotSchema.parse({
        ...entry.snapshot,
        version: entry.snapshot.version + 1,
        messages: [...entry.snapshot.messages, input.input],
        runs: coalescedRun
          ? replaceRun(entry.snapshot.runs, assignedRun)
          : [...entry.snapshot.runs, assignedRun],
      });
      entry.idempotency.set(input.idempotencyKey, assignedRun.id);
      return apply(entry, next);
    },

    async acquireRun(rawInput) {
      const input = AcquireAgentRunSchema.parse(rawInput);
      const entry = get(input.conversationId);
      const run = entry.snapshot.runs.find((candidate) => candidate.id === input.runId);
      if (!run) return { outcome: 'not_found' };
      if (run.revision !== input.expectedRevision || run.state !== 'queued') {
        return conflict(run.revision);
      }
      const nextRun = AgentRunSchema.parse({
        ...run,
        state: 'running',
        ownerId: input.ownerId,
        revision: run.revision + 1,
        updatedAt: new Date().toISOString(),
      });
      return apply(
        entry,
        AgentSnapshotSchema.parse({
          ...entry.snapshot,
          version: entry.snapshot.version + 1,
          runs: replaceRun(entry.snapshot.runs, nextRun),
        }),
      );
    },

    async checkpointRunAssistant(rawInput) {
      const input = CheckpointRunAssistantSchema.parse(rawInput);
      const entry = get(input.conversationId);
      const run = entry.snapshot.runs.find((candidate) => candidate.id === input.runId);
      if (!run) return { outcome: 'not_found' };
      if (
        run.revision !== input.expectedRevision ||
        run.state !== 'running' ||
        run.ownerId !== input.ownerId ||
        input.assistant.runId !== run.id ||
        input.assistant.id !== run.assistantMessageId ||
        input.assistant.conversationId !== run.conversationId ||
        input.assistant.role !== 'assistant' ||
        input.assistant.status !== 'streaming'
      ) {
        return conflict(run.revision);
      }
      const nextRun = AgentRunSchema.parse({
        ...run,
        revision: run.revision + 1,
        updatedAt: new Date().toISOString(),
      });
      return apply(
        entry,
        AgentSnapshotSchema.parse({
          ...entry.snapshot,
          version: entry.snapshot.version + 1,
          messages: replaceMessage(entry.snapshot.messages, input.assistant),
          runs: replaceRun(entry.snapshot.runs, nextRun),
        }),
      );
    },

    async requestRunInterrupt(rawInput) {
      const input = RequestRunInterruptSchema.parse(rawInput);
      const entry = get(input.conversationId);
      const run = entry.snapshot.runs.find((candidate) => candidate.id === input.runId);
      if (!run) return { outcome: 'not_found' };
      if (run.revision !== input.expectedRevision || run.state !== 'running') {
        return conflict(run.revision);
      }
      const nextRun = AgentRunSchema.parse({
        ...run,
        state: 'interrupt_requested',
        revision: run.revision + 1,
        updatedAt: new Date().toISOString(),
      });
      return apply(
        entry,
        AgentSnapshotSchema.parse({
          ...entry.snapshot,
          version: entry.snapshot.version + 1,
          runs: replaceRun(entry.snapshot.runs, nextRun),
        }),
      );
    },

    async recoverRun(rawInput) {
      const input = RecoverAgentRunSchema.parse(rawInput);
      const entry = get(input.conversationId);
      const run = entry.snapshot.runs.find((candidate) => candidate.id === input.runId);
      if (!run) return { outcome: 'not_found' };
      if (
        run.revision !== input.expectedRevision ||
        !['queued', 'running', 'interrupt_requested'].includes(run.state)
      ) {
        return conflict(run.revision);
      }
      if (input.action === 'requeue' && run.state !== 'queued' && input.replaySafe !== true) {
        throw new TypeError(
          'Recovering an acquired run requires explicit replaySafe evidence',
        );
      }
      const nextRun = AgentRunSchema.parse({
        schemaVersion: 1,
        id: run.id,
        conversationId: run.conversationId,
        inputMessageIds: run.inputMessageIds,
        assistantMessageId: run.assistantMessageId,
        state: input.action === 'requeue' ? 'queued' : 'abandoned',
        revision: run.revision + 1,
        ...(input.action === 'abandon' && { terminalReason: 'abandoned' }),
        createdAt: run.createdAt,
        updatedAt: new Date().toISOString(),
      });
      return apply(
        entry,
        AgentSnapshotSchema.parse({
          ...entry.snapshot,
          version: entry.snapshot.version + 1,
          runs: replaceRun(entry.snapshot.runs, nextRun),
        }),
      );
    },

    async commitRunTerminal(rawInput) {
      const input = CommitRunTerminalSchema.parse(rawInput);
      const entry = get(input.conversationId);
      const run = entry.snapshot.runs.find((candidate) => candidate.id === input.runId);
      if (!run) return { outcome: 'not_found' };
      if (
        run.revision !== input.expectedRevision ||
        (run.state !== 'running' && run.state !== 'interrupt_requested') ||
        run.ownerId !== input.ownerId ||
        input.assistant.runId !== run.id ||
        input.assistant.id !== run.assistantMessageId ||
        input.assistant.conversationId !== run.conversationId ||
        input.assistant.role !== 'assistant' ||
        input.assistant.status !== terminalMessageStatus(input.reason)
      ) {
        return conflict(run.revision);
      }
      const nextRun = AgentRunSchema.parse({
        ...run,
        state: terminalState(input.reason),
        terminalReason: input.reason,
        ...(input.policyName && { terminalPolicyName: input.policyName }),
        revision: run.revision + 1,
        updatedAt: new Date().toISOString(),
      });
      return apply(
        entry,
        AgentSnapshotSchema.parse({
          ...entry.snapshot,
          version: entry.snapshot.version + 1,
          messages: replaceMessage(entry.snapshot.messages, input.assistant),
          runs: replaceRun(entry.snapshot.runs, nextRun),
        }),
      );
    },

    async replaceCompactedRange(rawInput) {
      const input = ReplaceCompactedRangeSchema.parse(rawInput);
      const entry = get(input.conversationId);
      if (entry.snapshot.version !== input.expectedVersion) {
        return conflict(entry.snapshot.version);
      }
      const replaced = new Set(input.replacedMessageIds);
      if (
        !input.replacedMessageIds.every((id) =>
          entry.snapshot.messages.some((m) => m.id === id),
        )
      ) {
        return { outcome: 'not_found' };
      }
      const positions = entry.snapshot.messages
        .map((message, index) => (replaced.has(message.id) ? index : undefined))
        .filter((index) => index !== undefined);
      const first = positions[0];
      if (
        first === undefined ||
        positions.some((position, offset) => position !== first + offset) ||
        input.summary.conversationId !== input.conversationId ||
        input.summary.runId !== undefined ||
        input.summary.role !== 'summary' ||
        input.summary.status !== 'committed'
      ) {
        throw new TypeError(
          'Compaction replacement must be one valid contiguous history range',
        );
      }
      const before = entry.snapshot.messages.slice(0, first);
      const after = entry.snapshot.messages.slice(first + positions.length);
      return apply(
        entry,
        AgentSnapshotSchema.parse({
          ...entry.snapshot,
          version: entry.snapshot.version + 1,
          messages: [...before, input.summary, ...after],
        }),
      );
    },

    async scanRecoverable() {
      return [...conversations.values()]
        .filter((entry) =>
          entry.snapshot.runs.some((run) =>
            ['queued', 'running', 'interrupt_requested'].includes(run.state),
          ),
        )
        .map((entry) => cloneSnapshot(entry.snapshot));
    },
  };
}
