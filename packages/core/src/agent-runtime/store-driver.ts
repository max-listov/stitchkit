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
  type AgentTerminalReasonSchema,
} from './schemas';
import {
  type AcceptInputAndAssignRun,
  AcceptInputAndAssignRunSchema,
  type AcquireAgentRun,
  AcquireAgentRunSchema,
  type AgentRuntimeStore,
  type AgentStoreMutationResult,
  type CheckpointRunAssistant,
  CheckpointRunAssistantSchema,
  type CommitRunTerminal,
  CommitRunTerminalSchema,
  type RecoverAgentRun,
  RecoverAgentRunSchema,
  type ReplaceCompactedRange,
  ReplaceCompactedRangeSchema,
  type RequestRunInterrupt,
  RequestRunInterruptSchema,
} from './store';
import { assistantStatus } from './terminal-status';

export const AgentRuntimeHeadSchema = z.object({
  schemaVersion: z.literal(1),
  conversationId: AgentRecordIdSchema,
  version: AgentRecordVersionSchema,
});

export const AgentStoredRunSchema = z.object({
  schemaVersion: z.literal(1),
  run: AgentRunSchema,
  terminalAssistant: AgentMessageSchema.optional(),
});

export const AgentAdmissionReceiptSchema = z.object({
  schemaVersion: z.literal(1),
  conversationId: AgentRecordIdSchema,
  idempotencyKey: z.string().min(1),
  input: AgentMessageSchema,
  runId: AgentRecordIdSchema,
  assistantMessageId: AgentRecordIdSchema,
});

export type AgentRuntimeHead = z.infer<typeof AgentRuntimeHeadSchema>;
export type AgentStoredRun = z.infer<typeof AgentStoredRunSchema>;
export type AgentAdmissionReceipt = z.infer<typeof AgentAdmissionReceiptSchema>;

export const AgentHistoryMutationSchema = z.discriminatedUnion('type', [
  z.object({ type: z.literal('admit'), input: AgentMessageSchema }),
  z.object({
    type: z.literal('upsert-assistant'),
    message: AgentMessageSchema,
  }),
  z.object({
    type: z.literal('replace-compacted-range'),
    replacedMessageIds: z.array(AgentRecordIdSchema).min(1),
    summary: AgentMessageSchema,
  }),
]);

export type AgentHistoryMutation = z.infer<typeof AgentHistoryMutationSchema>;

export const AgentRecoverableDescriptorSchema = z.object({
  conversationId: AgentRecordIdSchema,
  run: AgentRunSchema,
});

export const AgentRecoverablePageSchema = z.object({
  items: z.array(AgentRecoverableDescriptorSchema),
  nextCursor: z.string().min(1).optional(),
});

const AgentRecoverableScanInputSchema = z.object({
  cursor: z.string().min(1).optional(),
  limit: z.number().int().min(1).max(1_000),
});

export type AgentRecoverableDescriptor = z.infer<typeof AgentRecoverableDescriptorSchema>;
export type AgentRecoverablePage = z.infer<typeof AgentRecoverablePageSchema>;

export type AgentStoreCompareAndSwapResult =
  | { outcome: 'applied' }
  | { outcome: 'conflict'; actualVersion: number };

export interface AgentRuntimeStoreDriver<TRANSACTION> {
  transaction<RESULT>(work: (transaction: TRANSACTION) => Promise<RESULT>): Promise<RESULT>;
  head: {
    load(
      transaction: TRANSACTION,
      conversationId: string,
    ): Promise<AgentRuntimeHead | undefined>;
    compareAndSwap(
      transaction: TRANSACTION,
      input: {
        conversationId: string;
        expectedVersion: number;
        next: AgentRuntimeHead;
      },
    ): Promise<AgentStoreCompareAndSwapResult>;
  };
  runs: {
    load(
      transaction: TRANSACTION,
      input: { conversationId: string; runId: string },
    ): Promise<AgentStoredRun | undefined>;
    loadByAssistantMessageId(
      transaction: TRANSACTION,
      input: { conversationId: string; assistantMessageId: string },
    ): Promise<AgentStoredRun | undefined>;
    loadMany(
      transaction: TRANSACTION,
      input: { conversationId: string; runIds: readonly string[] },
    ): Promise<readonly AgentStoredRun[]>;
    listActive(
      transaction: TRANSACTION,
      conversationId: string,
    ): Promise<readonly AgentStoredRun[]>;
    save(transaction: TRANSACTION, record: AgentStoredRun): Promise<void>;
  };
  admissions: {
    load(
      transaction: TRANSACTION,
      input: { conversationId: string; idempotencyKey: string },
    ): Promise<AgentAdmissionReceipt | undefined>;
    loadByInputMessageId(
      transaction: TRANSACTION,
      input: { conversationId: string; inputMessageId: string },
    ): Promise<AgentAdmissionReceipt | undefined>;
    create(transaction: TRANSACTION, receipt: AgentAdmissionReceipt): Promise<void>;
  };
  history: {
    load(transaction: TRANSACTION, conversationId: string): Promise<readonly AgentMessage[]>;
    apply(transaction: TRANSACTION, mutation: AgentHistoryMutation): Promise<void>;
  };
  scanRecoverable(input: { cursor?: string; limit: number }): Promise<AgentRecoverablePage>;
}

type StoreOperation =
  | { type: 'accept'; input: AcceptInputAndAssignRun }
  | { type: 'acquire'; input: AcquireAgentRun }
  | { type: 'checkpoint'; input: CheckpointRunAssistant }
  | { type: 'interrupt'; input: RequestRunInterrupt }
  | { type: 'recover'; input: RecoverAgentRun }
  | { type: 'terminal'; input: CommitRunTerminal }
  | { type: 'compact'; input: ReplaceCompactedRange };

interface ReducedApplied {
  outcome: 'applied';
  snapshot: AgentSnapshot;
  runRecord?: AgentStoredRun;
  admissionReceipt?: AgentAdmissionReceipt;
  historyMutation?: AgentHistoryMutation;
}

type ReducedMutation =
  | ReducedApplied
  | { outcome: 'conflict'; actualVersion: number }
  | { outcome: 'not_found' }
  | {
      outcome: 'duplicate';
      input: AgentMessage;
      inputMessageId: string;
      runId: string;
      assistantMessageId: string;
      run: AgentRun;
      assistant?: AgentMessage;
      snapshot: AgentSnapshot;
    };

function emptyHead(conversationId: string): AgentRuntimeHead {
  return AgentRuntimeHeadSchema.parse({
    schemaVersion: 1,
    conversationId,
    version: 0,
  });
}

/**
 * Where a run sits in the conversation's own history — the position of the
 * earliest message it owns.
 *
 * Runs the history cannot place (every message of theirs compacted away) get
 * no position, and keep whatever order their timestamps give them.
 */
function historyPositions(messages: readonly AgentMessage[]): (run: AgentRun) => number {
  const positions = new Map<string, number>();
  messages.forEach((message, index) => {
    if (!positions.has(message.id)) positions.set(message.id, index);
  });
  return (run) => {
    let earliest = Number.MAX_SAFE_INTEGER;
    for (const id of [...run.inputMessageIds, run.assistantMessageId]) {
      const position = positions.get(id);
      if (position !== undefined && position < earliest) earliest = position;
    }
    return earliest;
  };
}

function snapshotOf(
  head: AgentRuntimeHead,
  messages: readonly AgentMessage[],
  records: readonly AgentStoredRun[],
): AgentSnapshot {
  validateSnapshot(head, messages, records);
  // `createdAt` first, then history, then the identifier.
  //
  // The middle key is not decoration. Two runs of one conversation are
  // routinely created inside the same millisecond — a successor coalescing
  // behind an active run always is — and an ISO timestamp cannot separate
  // them. Breaking that tie on a random UUID is a coin toss wearing the shape
  // of an order: it put a correct runtime behind a red release gate, because a
  // test read position 1 as "the successor" and half the time got the run it
  // was queued behind. History is the causal record the runtime already keeps
  // in order for the prompt, so it is what decides.
  const positionOf = historyPositions(messages);
  return AgentSnapshotSchema.parse({
    schemaVersion: 1,
    conversationId: head.conversationId,
    version: head.version,
    messages,
    runs: records
      .map((record) => record.run)
      .sort(
        (left, right) =>
          left.createdAt.localeCompare(right.createdAt) ||
          positionOf(left) - positionOf(right) ||
          left.id.localeCompare(right.id),
      ),
  });
}

function validateSnapshot(
  head: AgentRuntimeHead,
  messages: readonly AgentMessage[],
  records: readonly AgentStoredRun[],
): void {
  const runIds = new Set<string>();
  const assistantIds = new Set<string>();
  const messageIds = new Set<string>();
  for (const record of records) {
    const run = record.run;
    if (
      run.conversationId !== head.conversationId ||
      runIds.has(run.id) ||
      assistantIds.has(run.assistantMessageId)
    ) {
      throw new TypeError('Stored agent runs contain inconsistent identities');
    }
    if (
      record.terminalAssistant &&
      (record.terminalAssistant.id !== run.assistantMessageId ||
        record.terminalAssistant.conversationId !== run.conversationId ||
        record.terminalAssistant.runId !== run.id ||
        record.terminalAssistant.role !== 'assistant' ||
        run.terminalReason === undefined)
    ) {
      throw new TypeError('Retained terminal assistant does not match its run');
    }
    runIds.add(run.id);
    assistantIds.add(run.assistantMessageId);
  }
  for (const message of messages) {
    if (message.conversationId !== head.conversationId || messageIds.has(message.id)) {
      throw new TypeError('Stored agent history contains inconsistent message identities');
    }
    messageIds.add(message.id);
    if (assistantIds.has(message.id) && message.runId === undefined) {
      throw new TypeError('Stored history occupies a reserved assistant identity');
    }
    if (message.runId !== undefined) {
      const run = records.find((candidate) => candidate.run.id === message.runId)?.run;
      if (!run || message.role !== 'assistant' || run.assistantMessageId !== message.id) {
        throw new TypeError(
          'Stored assistant history does not match its reserved run identity',
        );
      }
    }
  }
}

const RecoverableCursorSchema = z.tuple([AgentRecordIdSchema, AgentRecordIdSchema]);

function recoverableCursor(input: AgentRecoverableDescriptor): string {
  return JSON.stringify([input.conversationId, input.run.id]);
}

function parseRecoverableCursor(cursor: string): readonly [string, string] {
  return RecoverableCursorSchema.parse(JSON.parse(cursor));
}

function replaceRun(runs: readonly AgentRun[], next: AgentRun): AgentRun[] {
  return runs.map((run) => (run.id === next.id ? next : run));
}

function replaceMessage(
  messages: readonly AgentMessage[],
  next: AgentMessage,
): AgentMessage[] {
  return messages.some((message) => message.id === next.id)
    ? messages.map((message) => (message.id === next.id ? next : message))
    : [...messages, next];
}

function conflict(actualVersion: number): {
  outcome: 'conflict';
  actualVersion: number;
} {
  return { outcome: 'conflict', actualVersion };
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

function applied(
  current: AgentSnapshot,
  input: { runs?: readonly AgentRun[]; messages?: readonly AgentMessage[] },
  effects?: {
    runRecord?: AgentStoredRun;
    admissionReceipt?: AgentAdmissionReceipt;
    historyMutation?: AgentHistoryMutation;
  },
): ReducedApplied {
  return {
    outcome: 'applied',
    snapshot: AgentSnapshotSchema.parse({
      ...current,
      version: current.version + 1,
      runs: input.runs ?? current.runs,
      messages: input.messages ?? current.messages,
    }),
    ...(effects?.runRecord && { runRecord: effects.runRecord }),
    ...(effects?.admissionReceipt && { admissionReceipt: effects.admissionReceipt }),
    ...(effects?.historyMutation && { historyMutation: effects.historyMutation }),
  };
}

function reduceStore(current: AgentSnapshot, operation: StoreOperation): ReducedMutation {
  if (operation.type === 'accept') {
    const input = operation.input;
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
      input.run.ownerId !== undefined ||
      input.run.terminalReason !== undefined ||
      input.run.terminalPolicyName !== undefined ||
      input.input.role !== 'user' ||
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
        runRecord: AgentStoredRunSchema.parse({
          schemaVersion: 1,
          run: assignedRun,
        }),
        admissionReceipt,
        historyMutation: { type: 'admit', input: input.input },
      },
    );
  }

  const conversationId = operation.input.conversationId;
  const run =
    operation.type === 'compact'
      ? undefined
      : current.runs.find((candidate) => candidate.id === operation.input.runId);
  if (operation.type !== 'compact' && !run) return { outcome: 'not_found' };

  if (operation.type === 'acquire' && run) {
    const runPosition = current.runs.findIndex((candidate) => candidate.id === run.id);
    const acquisitionBlocked = current.runs.some(
      (candidate, index) =>
        candidate.id !== run.id &&
        (candidate.state === 'running' ||
          candidate.state === 'interrupt_requested' ||
          (index < runPosition && candidate.state === 'queued')),
    );
    if (
      run.revision !== operation.input.expectedRevision ||
      run.state !== 'queued' ||
      acquisitionBlocked
    ) {
      return conflict(run.revision);
    }
    const next = AgentRunSchema.parse({
      ...run,
      state: 'running',
      ownerId: operation.input.ownerId,
      fencingToken: (run.fencingToken ?? 0) + 1,
      revision: run.revision + 1,
      updatedAt: new Date().toISOString(),
    });
    return applied(
      current,
      { runs: replaceRun(current.runs, next) },
      {
        runRecord: AgentStoredRunSchema.parse({ schemaVersion: 1, run: next }),
      },
    );
  }

  if (operation.type === 'checkpoint' && run) {
    const input = operation.input;
    if (
      run.revision !== input.expectedRevision ||
      run.state !== 'running' ||
      run.ownerId !== input.ownerId ||
      (input.fencingToken !== undefined && run.fencingToken !== input.fencingToken) ||
      input.assistant.runId !== run.id ||
      input.assistant.id !== run.assistantMessageId ||
      input.assistant.conversationId !== run.conversationId ||
      input.assistant.role !== 'assistant' ||
      input.assistant.status !== 'streaming'
    ) {
      return conflict(run.revision);
    }
    const next = AgentRunSchema.parse({
      ...run,
      revision: run.revision + 1,
      updatedAt: new Date().toISOString(),
    });
    return applied(
      current,
      {
        runs: replaceRun(current.runs, next),
        messages: replaceMessage(current.messages, input.assistant),
      },
      {
        runRecord: AgentStoredRunSchema.parse({ schemaVersion: 1, run: next }),
        historyMutation: { type: 'upsert-assistant', message: input.assistant },
      },
    );
  }

  if (operation.type === 'interrupt' && run) {
    if (run.revision !== operation.input.expectedRevision || run.state !== 'running') {
      return conflict(run.revision);
    }
    const next = AgentRunSchema.parse({
      ...run,
      state: 'interrupt_requested',
      revision: run.revision + 1,
      updatedAt: new Date().toISOString(),
    });
    return applied(
      current,
      { runs: replaceRun(current.runs, next) },
      {
        runRecord: AgentStoredRunSchema.parse({ schemaVersion: 1, run: next }),
      },
    );
  }

  if (operation.type === 'recover' && run) {
    const input = operation.input;
    if (
      run.revision !== input.expectedRevision ||
      !['queued', 'running', 'interrupt_requested'].includes(run.state)
    ) {
      return conflict(run.revision);
    }
    if (input.action === 'requeue' && run.state !== 'queued' && input.replaySafe !== true) {
      throw new TypeError('Recovering an acquired run requires explicit replaySafe evidence');
    }
    const next = AgentRunSchema.parse({
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
    if (input.action === 'abandon') {
      const existingAssistant = current.messages.find(
        (message) => message.id === run.assistantMessageId,
      );
      const assistant = AgentMessageSchema.parse({
        ...(existingAssistant ?? {
          schemaVersion: 1,
          id: run.assistantMessageId,
          conversationId: run.conversationId,
          runId: run.id,
          role: 'assistant',
          parts: [],
          createdAt: run.createdAt,
        }),
        status: 'failed',
        updatedAt: new Date().toISOString(),
      });
      return applied(
        current,
        {
          runs: replaceRun(current.runs, next),
          messages: replaceMessage(current.messages, assistant),
        },
        {
          runRecord: AgentStoredRunSchema.parse({
            schemaVersion: 1,
            run: next,
            terminalAssistant: assistant,
          }),
          historyMutation: { type: 'upsert-assistant', message: assistant },
        },
      );
    }
    return applied(
      current,
      { runs: replaceRun(current.runs, next) },
      {
        runRecord: AgentStoredRunSchema.parse({ schemaVersion: 1, run: next }),
      },
    );
  }

  if (operation.type === 'terminal' && run) {
    const input = operation.input;
    if (
      run.revision !== input.expectedRevision ||
      (run.state !== 'running' && run.state !== 'interrupt_requested') ||
      run.ownerId !== input.ownerId ||
      (input.fencingToken !== undefined && run.fencingToken !== input.fencingToken) ||
      input.assistant.runId !== run.id ||
      input.assistant.id !== run.assistantMessageId ||
      input.assistant.conversationId !== run.conversationId ||
      input.assistant.role !== 'assistant' ||
      input.assistant.status !== assistantStatus(input.reason)
    ) {
      return conflict(run.revision);
    }
    const next = AgentRunSchema.parse({
      ...run,
      state: terminalState(input.reason),
      terminalReason: input.reason,
      ...(input.policyName && { terminalPolicyName: input.policyName }),
      revision: run.revision + 1,
      updatedAt: new Date().toISOString(),
    });
    return applied(
      current,
      {
        runs: replaceRun(current.runs, next),
        messages: replaceMessage(current.messages, input.assistant),
      },
      {
        runRecord: AgentStoredRunSchema.parse({
          schemaVersion: 1,
          run: next,
          terminalAssistant: input.assistant,
        }),
        historyMutation: { type: 'upsert-assistant', message: input.assistant },
      },
    );
  }

  if (operation.type === 'compact') {
    const input = operation.input;
    if (current.conversationId !== conversationId) return { outcome: 'not_found' };
    if (current.version !== input.expectedVersion) return conflict(current.version);
    const replaced = new Set(input.replacedMessageIds);
    if (!input.replacedMessageIds.every((id) => current.messages.some((m) => m.id === id))) {
      return { outcome: 'not_found' };
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
        historyMutation: {
          type: 'replace-compacted-range',
          replacedMessageIds: input.replacedMessageIds,
          summary: input.summary,
        },
      },
    );
  }

  return { outcome: 'not_found' };
}

function operationConversationId(operation: StoreOperation): string {
  return operation.type === 'accept'
    ? operation.input.input.conversationId
    : operation.input.conversationId;
}

function mergeRunRecords(...groups: readonly (readonly AgentStoredRun[])[]): AgentStoredRun[] {
  const records = new Map<string, AgentStoredRun>();
  for (const group of groups) {
    for (const rawRecord of group) {
      const record = AgentStoredRunSchema.parse(rawRecord);
      const previous = records.get(record.run.id);
      if (previous && previous.run.assistantMessageId !== record.run.assistantMessageId) {
        throw new TypeError('Stored agent run identity changed across normalized records');
      }
      records.set(record.run.id, record);
    }
  }
  return [...records.values()];
}

function referencedRunIds(messages: readonly AgentMessage[]): string[] {
  return [...new Set(messages.flatMap((message) => (message.runId ? [message.runId] : [])))];
}

function validateAdmissionReceipt(
  receipt: AgentAdmissionReceipt,
  record: AgentStoredRun,
  conversationId: string,
): void {
  const input = receipt.input;
  const run = record.run;
  if (
    receipt.conversationId !== conversationId ||
    input.conversationId !== conversationId ||
    input.role !== 'user' ||
    input.status !== 'committed' ||
    input.runId !== undefined ||
    receipt.runId !== run.id ||
    receipt.assistantMessageId !== run.assistantMessageId ||
    !run.inputMessageIds.includes(input.id)
  ) {
    throw new TypeError('Admission receipt does not match its canonical run assignment');
  }
}

export function createAgentRuntimeStore<TRANSACTION>(
  driver: AgentRuntimeStoreDriver<TRANSACTION>,
): AgentRuntimeStore {
  const loadSnapshot = (conversationId: string): Promise<AgentSnapshot> =>
    driver.transaction(async (transaction) => {
      const [stored, messages, activeRecords] = await Promise.all([
        driver.head.load(transaction, conversationId),
        driver.history.load(transaction, conversationId),
        driver.runs.listActive(transaction, conversationId),
      ]);
      const head = AgentRuntimeHeadSchema.parse(stored ?? emptyHead(conversationId));
      const referencedRecords = await driver.runs.loadMany(transaction, {
        conversationId,
        runIds: referencedRunIds(messages),
      });
      return snapshotOf(head, messages, mergeRunRecords(activeRecords, referencedRecords));
    });

  const mutate = (operation: StoreOperation): Promise<AgentStoreMutationResult> =>
    driver.transaction(async (transaction) => {
      const conversationId = operationConversationId(operation);
      const operationRunId =
        operation.type === 'accept'
          ? operation.input.coalesceIntoRunId
          : operation.type === 'compact'
            ? undefined
            : operation.input.runId;
      const [stored, messages, activeRecords, operationRecord, duplicateReceipt] =
        await Promise.all([
          driver.head.load(transaction, conversationId),
          driver.history.load(transaction, conversationId),
          driver.runs.listActive(transaction, conversationId),
          operationRunId
            ? driver.runs.load(transaction, { conversationId, runId: operationRunId })
            : undefined,
          operation.type === 'accept'
            ? driver.admissions.load(transaction, {
                conversationId,
                idempotencyKey: operation.input.idempotencyKey,
              })
            : undefined,
        ]);
      const head = AgentRuntimeHeadSchema.parse(stored ?? emptyHead(conversationId));
      const referencedRecords = await driver.runs.loadMany(transaction, {
        conversationId,
        runIds: referencedRunIds(messages),
      });
      const records = mergeRunRecords(
        activeRecords,
        referencedRecords,
        operationRecord ? [operationRecord] : [],
      );
      const current = snapshotOf(head, messages, records);
      if (duplicateReceipt) {
        const duplicateRecord = await driver.runs.load(transaction, {
          conversationId,
          runId: duplicateReceipt.runId,
        });
        if (!duplicateRecord) {
          throw new TypeError('Admission receipt points to a missing canonical run');
        }
        validateAdmissionReceipt(duplicateReceipt, duplicateRecord, conversationId);
        return {
          outcome: 'duplicate',
          input: duplicateReceipt.input,
          inputMessageId: duplicateReceipt.input.id,
          runId: duplicateReceipt.runId,
          assistantMessageId: duplicateReceipt.assistantMessageId,
          run: duplicateRecord.run,
          ...(duplicateRecord.terminalAssistant && {
            assistant: duplicateRecord.terminalAssistant,
          }),
          snapshot: snapshotOf(head, messages, mergeRunRecords(records, [duplicateRecord])),
        };
      }

      if (operation.type === 'accept') {
        const inputCollision = await driver.admissions.loadByInputMessageId(transaction, {
          conversationId,
          inputMessageId: operation.input.input.id,
        });
        if (inputCollision) {
          throw new TypeError('Input message identity is already assigned to an admission');
        }
        if (!operation.input.coalesceIntoRunId) {
          const [runCollision, assistantCollision] = await Promise.all([
            driver.runs.load(transaction, {
              conversationId,
              runId: operation.input.run.id,
            }),
            driver.runs.loadByAssistantMessageId(transaction, {
              conversationId,
              assistantMessageId: operation.input.run.assistantMessageId,
            }),
          ]);
          if (runCollision || assistantCollision) {
            throw new TypeError('Queued run identities are already reserved');
          }
        }
      }

      const reduced = reduceStore(current, operation);
      if (reduced.outcome !== 'applied') return reduced;
      const nextHead = AgentRuntimeHeadSchema.parse({
        schemaVersion: 1,
        conversationId,
        version: reduced.snapshot.version,
      });
      const outcome = await driver.head.compareAndSwap(transaction, {
        conversationId,
        expectedVersion: current.version,
        next: nextHead,
      });
      if (outcome.outcome === 'conflict') return conflict(outcome.actualVersion);
      if (reduced.runRecord) await driver.runs.save(transaction, reduced.runRecord);
      if (reduced.admissionReceipt) {
        await driver.admissions.create(transaction, reduced.admissionReceipt);
      }
      if (reduced.historyMutation) {
        await driver.history.apply(transaction, reduced.historyMutation);
      }
      return { outcome: 'applied', snapshot: reduced.snapshot };
    });

  return {
    loadSnapshot,
    acceptInputAndAssignRun: (input) =>
      mutate({
        type: 'accept',
        input: AcceptInputAndAssignRunSchema.parse(input),
      }),
    acquireRun: (input) =>
      mutate({ type: 'acquire', input: AcquireAgentRunSchema.parse(input) }),
    checkpointRunAssistant: (input) =>
      mutate({
        type: 'checkpoint',
        input: CheckpointRunAssistantSchema.parse(input),
      }),
    requestRunInterrupt: (input) =>
      mutate({
        type: 'interrupt',
        input: RequestRunInterruptSchema.parse(input),
      }),
    recoverRun: (input) =>
      mutate({ type: 'recover', input: RecoverAgentRunSchema.parse(input) }),
    commitRunTerminal: (input) =>
      mutate({ type: 'terminal', input: CommitRunTerminalSchema.parse(input) }),
    replaceCompactedRange: (input) =>
      mutate({
        type: 'compact',
        input: ReplaceCompactedRangeSchema.parse(input),
      }),
    async scanRecoverable(input) {
      const parsed = AgentRecoverableScanInputSchema.parse(input);
      return AgentRecoverablePageSchema.parse(await driver.scanRecoverable(parsed));
    },
  };
}

interface MemoryTransaction {
  heads: Map<string, AgentRuntimeHead>;
  runs: Map<string, Map<string, AgentStoredRun>>;
  admissions: Map<string, Map<string, AgentAdmissionReceipt>>;
  histories: Map<string, AgentMessage[]>;
}

function cloneHeadMap(source: ReadonlyMap<string, AgentRuntimeHead>) {
  return new Map(
    [...source].map(([key, value]) => [
      key,
      AgentRuntimeHeadSchema.parse(structuredClone(value)),
    ]),
  );
}

function cloneNestedMap<VALUE>(
  source: ReadonlyMap<string, ReadonlyMap<string, VALUE>>,
  clone: (value: VALUE) => VALUE,
): Map<string, Map<string, VALUE>> {
  return new Map(
    [...source].map(([outerKey, values]) => [
      outerKey,
      new Map([...values].map(([innerKey, value]) => [innerKey, clone(value)])),
    ]),
  );
}

function cloneHistoryMap(source: ReadonlyMap<string, readonly AgentMessage[]>) {
  return new Map(
    [...source].map(([key, value]) => [
      key,
      value.map((message) => AgentMessageSchema.parse(structuredClone(message))),
    ]),
  );
}

/** In-memory reference adapter backed by the same reducer and driver contract as durable stores. */
export function createMemoryAgentRuntimeStore(): AgentRuntimeStore {
  let heads = new Map<string, AgentRuntimeHead>();
  let runs = new Map<string, Map<string, AgentStoredRun>>();
  let admissions = new Map<string, Map<string, AgentAdmissionReceipt>>();
  let histories = new Map<string, AgentMessage[]>();
  let transactionTail = Promise.resolve();

  const driver: AgentRuntimeStoreDriver<MemoryTransaction> = {
    async transaction(work) {
      const previous = transactionTail;
      const release = Promise.withResolvers<void>();
      transactionTail = previous.catch(() => undefined).then(() => release.promise);
      await previous.catch(() => undefined);
      const transaction = {
        heads: cloneHeadMap(heads),
        runs: cloneNestedMap(runs, (record) =>
          AgentStoredRunSchema.parse(structuredClone(record)),
        ),
        admissions: cloneNestedMap(admissions, (receipt) =>
          AgentAdmissionReceiptSchema.parse(structuredClone(receipt)),
        ),
        histories: cloneHistoryMap(histories),
      };
      try {
        const result = await work(transaction);
        heads = transaction.heads;
        runs = transaction.runs;
        admissions = transaction.admissions;
        histories = transaction.histories;
        return result;
      } finally {
        release.resolve();
      }
    },
    head: {
      async load(transaction, conversationId) {
        const head = transaction.heads.get(conversationId);
        return head ? AgentRuntimeHeadSchema.parse(structuredClone(head)) : undefined;
      },
      async compareAndSwap(transaction, input) {
        const current = transaction.heads.get(input.conversationId);
        const actualVersion = current?.version ?? 0;
        if (actualVersion !== input.expectedVersion) {
          return { outcome: 'conflict', actualVersion };
        }
        transaction.heads.set(
          input.conversationId,
          AgentRuntimeHeadSchema.parse(structuredClone(input.next)),
        );
        return { outcome: 'applied' };
      },
    },
    runs: {
      async load(transaction, input) {
        const record = transaction.runs.get(input.conversationId)?.get(input.runId);
        return record ? AgentStoredRunSchema.parse(structuredClone(record)) : undefined;
      },
      async loadByAssistantMessageId(transaction, input) {
        const record = [...(transaction.runs.get(input.conversationId)?.values() ?? [])].find(
          (candidate) => candidate.run.assistantMessageId === input.assistantMessageId,
        );
        return record ? AgentStoredRunSchema.parse(structuredClone(record)) : undefined;
      },
      async loadMany(transaction, input) {
        const records = transaction.runs.get(input.conversationId);
        return input.runIds.flatMap((runId) => {
          const record = records?.get(runId);
          return record ? [AgentStoredRunSchema.parse(structuredClone(record))] : [];
        });
      },
      async listActive(transaction, conversationId) {
        return [...(transaction.runs.get(conversationId)?.values() ?? [])]
          .filter((record) =>
            ['queued', 'running', 'interrupt_requested'].includes(record.run.state),
          )
          .map((record) => AgentStoredRunSchema.parse(structuredClone(record)));
      },
      async save(transaction, rawRecord) {
        const record = AgentStoredRunSchema.parse(structuredClone(rawRecord));
        const conversationRuns = transaction.runs.get(record.run.conversationId) ?? new Map();
        const collision = [...conversationRuns.values()].find(
          (candidate) =>
            candidate.run.id !== record.run.id &&
            candidate.run.assistantMessageId === record.run.assistantMessageId,
        );
        if (collision) throw new TypeError('Assistant message identity is already reserved');
        conversationRuns.set(record.run.id, record);
        transaction.runs.set(record.run.conversationId, conversationRuns);
      },
    },
    admissions: {
      async load(transaction, input) {
        const receipt = transaction.admissions
          .get(input.conversationId)
          ?.get(input.idempotencyKey);
        return receipt
          ? AgentAdmissionReceiptSchema.parse(structuredClone(receipt))
          : undefined;
      },
      async loadByInputMessageId(transaction, input) {
        const receipt = [
          ...(transaction.admissions.get(input.conversationId)?.values() ?? []),
        ].find((candidate) => candidate.input.id === input.inputMessageId);
        return receipt
          ? AgentAdmissionReceiptSchema.parse(structuredClone(receipt))
          : undefined;
      },
      async create(transaction, rawReceipt) {
        const receipt = AgentAdmissionReceiptSchema.parse(structuredClone(rawReceipt));
        const conversationAdmissions =
          transaction.admissions.get(receipt.conversationId) ?? new Map();
        if (
          conversationAdmissions.has(receipt.idempotencyKey) ||
          [...conversationAdmissions.values()].some(
            (candidate) => candidate.input.id === receipt.input.id,
          )
        ) {
          throw new TypeError('Admission identity is already reserved');
        }
        conversationAdmissions.set(receipt.idempotencyKey, receipt);
        transaction.admissions.set(receipt.conversationId, conversationAdmissions);
      },
    },
    history: {
      async load(transaction, conversationId) {
        return (transaction.histories.get(conversationId) ?? []).map((message) =>
          AgentMessageSchema.parse(structuredClone(message)),
        );
      },
      async apply(transaction, rawMutation) {
        const mutation = AgentHistoryMutationSchema.parse(rawMutation);
        const conversationId =
          mutation.type === 'admit'
            ? mutation.input.conversationId
            : mutation.type === 'upsert-assistant'
              ? mutation.message.conversationId
              : mutation.summary.conversationId;
        const current = transaction.histories.get(conversationId) ?? [];
        if (mutation.type === 'admit') {
          transaction.histories.set(conversationId, [...current, mutation.input]);
          return;
        }
        if (mutation.type === 'upsert-assistant') {
          transaction.histories.set(conversationId, replaceMessage(current, mutation.message));
          return;
        }
        const replaced = new Set(mutation.replacedMessageIds);
        const positions = current
          .map((message, index) => (replaced.has(message.id) ? index : undefined))
          .filter((index) => index !== undefined);
        const first = positions[0];
        if (first === undefined) throw new Error('Compaction history range disappeared');
        transaction.histories.set(conversationId, [
          ...current.slice(0, first),
          mutation.summary,
          ...current.slice(first + positions.length),
        ]);
      },
    },
    async scanRecoverable(input) {
      const descriptors = [...runs]
        .flatMap(([conversationId, conversationRuns]) =>
          [...conversationRuns.values()]
            .filter((record) =>
              ['queued', 'running', 'interrupt_requested'].includes(record.run.state),
            )
            .map((record) => ({ conversationId, run: record.run })),
        )
        .sort(
          (left, right) =>
            left.conversationId.localeCompare(right.conversationId) ||
            left.run.id.localeCompare(right.run.id),
        );
      const cursorTuple = input.cursor ? parseRecoverableCursor(input.cursor) : undefined;
      const start = cursorTuple
        ? descriptors.findIndex(
            (item) => item.conversationId === cursorTuple[0] && item.run.id === cursorTuple[1],
          ) + 1
        : 0;
      const items = descriptors.slice(start, start + input.limit);
      const last = items.at(-1);
      const hasMore = start + items.length < descriptors.length;
      return AgentRecoverablePageSchema.parse({
        items,
        ...(hasMore && last && { nextCursor: recoverableCursor(last) }),
      });
    },
  };
  return createAgentRuntimeStore(driver);
}
