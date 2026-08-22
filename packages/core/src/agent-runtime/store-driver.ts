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

export const AgentAdmissionIdentitySchema = z.object({
  idempotencyKey: z.string().min(1),
  inputMessageId: AgentRecordIdSchema,
  runId: AgentRecordIdSchema,
  assistantMessageId: AgentRecordIdSchema,
});

export const AgentStoredStateSchema = z.object({
  schemaVersion: z.literal(1),
  conversationId: AgentRecordIdSchema,
  version: AgentRecordVersionSchema,
  runs: z.array(AgentRunSchema),
  admissions: z.array(AgentAdmissionIdentitySchema),
});

export type AgentAdmissionIdentity = z.infer<typeof AgentAdmissionIdentitySchema>;
export type AgentStoredState = z.infer<typeof AgentStoredStateSchema>;

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
  state: {
    load(
      transaction: TRANSACTION,
      conversationId: string,
    ): Promise<AgentStoredState | undefined>;
    compareAndSwap(
      transaction: TRANSACTION,
      input: {
        conversationId: string;
        expectedVersion: number;
        next: AgentStoredState;
        recoverable: readonly AgentRecoverableDescriptor[];
      },
    ): Promise<AgentStoreCompareAndSwapResult>;
  };
  history: {
    load(transaction: TRANSACTION, conversationId: string): Promise<readonly AgentMessage[]>;
    loadById(
      transaction: TRANSACTION,
      input: { conversationId: string; messageId: string },
    ): Promise<AgentMessage | undefined>;
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
  admissions: readonly AgentAdmissionIdentity[];
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
      snapshot: AgentSnapshot;
    };

function emptyState(conversationId: string): AgentStoredState {
  return AgentStoredStateSchema.parse({
    schemaVersion: 1,
    conversationId,
    version: 0,
    runs: [],
    admissions: [],
  });
}

function snapshotOf(
  state: AgentStoredState,
  messages: readonly AgentMessage[],
): AgentSnapshot {
  validateAggregate(state, messages);
  return AgentSnapshotSchema.parse({
    schemaVersion: 1,
    conversationId: state.conversationId,
    version: state.version,
    messages,
    runs: state.runs,
  });
}

function validateAggregate(state: AgentStoredState, messages: readonly AgentMessage[]): void {
  const runIds = new Set<string>();
  const assistantIds = new Set<string>();
  const messageIds = new Set<string>();
  const idempotencyKeys = new Set<string>();
  const admittedInputIds = new Set<string>();
  for (const run of state.runs) {
    if (
      run.conversationId !== state.conversationId ||
      runIds.has(run.id) ||
      assistantIds.has(run.assistantMessageId)
    ) {
      throw new TypeError('Stored agent state contains inconsistent run identities');
    }
    runIds.add(run.id);
    assistantIds.add(run.assistantMessageId);
  }
  for (const message of messages) {
    if (message.conversationId !== state.conversationId || messageIds.has(message.id)) {
      throw new TypeError('Stored agent history contains inconsistent message identities');
    }
    messageIds.add(message.id);
    if (assistantIds.has(message.id) && message.runId === undefined) {
      throw new TypeError('Stored history occupies a reserved assistant identity');
    }
    if (message.runId !== undefined) {
      const run = state.runs.find((candidate) => candidate.id === message.runId);
      if (!run || message.role !== 'assistant' || run.assistantMessageId !== message.id) {
        throw new TypeError(
          'Stored assistant history does not match its reserved run identity',
        );
      }
    }
  }
  for (const admission of state.admissions) {
    const run = state.runs.find((candidate) => candidate.id === admission.runId);
    if (
      idempotencyKeys.has(admission.idempotencyKey) ||
      admittedInputIds.has(admission.inputMessageId) ||
      !run ||
      run.assistantMessageId !== admission.assistantMessageId ||
      !run.inputMessageIds.includes(admission.inputMessageId)
    ) {
      throw new TypeError('Stored admission identity is inconsistent with its assigned run');
    }
    idempotencyKeys.add(admission.idempotencyKey);
    admittedInputIds.add(admission.inputMessageId);
  }
}

function recoverableDescriptors(state: AgentStoredState): AgentRecoverableDescriptor[] {
  return state.runs
    .filter((run) => ['queued', 'running', 'interrupt_requested'].includes(run.state))
    .map((run) => ({ conversationId: state.conversationId, run }));
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

function terminalMessageStatus(
  reason: z.infer<typeof AgentTerminalReasonSchema>,
): AgentMessage['status'] {
  if (reason === 'success' || reason === 'policy_stop') return 'completed';
  if (reason === 'interrupted' || reason === 'cancelled' || reason === 'shutdown') {
    return 'interrupted';
  }
  return 'failed';
}

function applied(
  current: AgentSnapshot,
  admissions: readonly AgentAdmissionIdentity[],
  input: { runs?: readonly AgentRun[]; messages?: readonly AgentMessage[] },
  historyMutation?: AgentHistoryMutation,
): ReducedApplied {
  return {
    outcome: 'applied',
    snapshot: AgentSnapshotSchema.parse({
      ...current,
      version: current.version + 1,
      runs: input.runs ?? current.runs,
      messages: input.messages ?? current.messages,
    }),
    admissions,
    ...(historyMutation && { historyMutation }),
  };
}

function reduceStore(
  current: AgentSnapshot,
  currentAdmissions: readonly AgentAdmissionIdentity[],
  operation: StoreOperation,
  duplicateInput?: AgentMessage,
): ReducedMutation {
  if (operation.type === 'accept') {
    const input = operation.input;
    const duplicate = currentAdmissions.find(
      (candidate) => candidate.idempotencyKey === input.idempotencyKey,
    );
    if (duplicate) {
      if (!duplicateInput) {
        throw new Error('Duplicate admission input is unavailable from canonical history');
      }
      return {
        outcome: 'duplicate',
        input: duplicateInput,
        inputMessageId: duplicate.inputMessageId,
        runId: duplicate.runId,
        assistantMessageId: duplicate.assistantMessageId,
        snapshot: current,
      };
    }
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
    const admission = AgentAdmissionIdentitySchema.parse({
      idempotencyKey: input.idempotencyKey,
      inputMessageId: input.input.id,
      runId: assignedRun.id,
      assistantMessageId: assignedRun.assistantMessageId,
    });
    return applied(
      current,
      [...currentAdmissions, admission],
      {
        messages: [...current.messages, input.input],
        runs: coalescedRun
          ? replaceRun(current.runs, assignedRun)
          : [...current.runs, assignedRun],
      },
      { type: 'admit', input: input.input },
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
    return applied(current, currentAdmissions, {
      runs: replaceRun(current.runs, next),
    });
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
      currentAdmissions,
      {
        runs: replaceRun(current.runs, next),
        messages: replaceMessage(current.messages, input.assistant),
      },
      { type: 'upsert-assistant', message: input.assistant },
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
    return applied(current, currentAdmissions, {
      runs: replaceRun(current.runs, next),
    });
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
        currentAdmissions,
        {
          runs: replaceRun(current.runs, next),
          messages: replaceMessage(current.messages, assistant),
        },
        { type: 'upsert-assistant', message: assistant },
      );
    }
    return applied(current, currentAdmissions, {
      runs: replaceRun(current.runs, next),
    });
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
      input.assistant.status !== terminalMessageStatus(input.reason)
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
      currentAdmissions,
      {
        runs: replaceRun(current.runs, next),
        messages: replaceMessage(current.messages, input.assistant),
      },
      { type: 'upsert-assistant', message: input.assistant },
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
      currentAdmissions,
      { messages },
      {
        type: 'replace-compacted-range',
        replacedMessageIds: input.replacedMessageIds,
        summary: input.summary,
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

export function createAgentRuntimeStore<TRANSACTION>(
  driver: AgentRuntimeStoreDriver<TRANSACTION>,
): AgentRuntimeStore {
  const loadSnapshot = (conversationId: string): Promise<AgentSnapshot> =>
    driver.transaction(async (transaction) => {
      const [stored, messages] = await Promise.all([
        driver.state.load(transaction, conversationId),
        driver.history.load(transaction, conversationId),
      ]);
      return snapshotOf(stored ?? emptyState(conversationId), messages);
    });

  const mutate = (operation: StoreOperation): Promise<AgentStoreMutationResult> =>
    driver.transaction(async (transaction) => {
      const conversationId = operationConversationId(operation);
      const [stored, messages] = await Promise.all([
        driver.state.load(transaction, conversationId),
        driver.history.load(transaction, conversationId),
      ]);
      const state = AgentStoredStateSchema.parse(stored ?? emptyState(conversationId));
      const current = snapshotOf(state, messages);
      const duplicateIdentity =
        operation.type === 'accept'
          ? state.admissions.find(
              (candidate) => candidate.idempotencyKey === operation.input.idempotencyKey,
            )
          : undefined;
      const duplicateInput = duplicateIdentity
        ? await driver.history.loadById(transaction, {
            conversationId,
            messageId: duplicateIdentity.inputMessageId,
          })
        : undefined;
      if (
        duplicateIdentity &&
        duplicateInput &&
        (duplicateInput.id !== duplicateIdentity.inputMessageId ||
          duplicateInput.conversationId !== conversationId ||
          duplicateInput.role !== 'user' ||
          duplicateInput.status !== 'committed' ||
          duplicateInput.runId !== undefined)
      ) {
        throw new TypeError('Canonical duplicate input does not match its admission identity');
      }
      const reduced = reduceStore(current, state.admissions, operation, duplicateInput);
      if (reduced.outcome !== 'applied') return reduced;
      const nextState = AgentStoredStateSchema.parse({
        schemaVersion: 1,
        conversationId,
        version: reduced.snapshot.version,
        runs: reduced.snapshot.runs,
        admissions: reduced.admissions,
      });
      const outcome = await driver.state.compareAndSwap(transaction, {
        conversationId,
        expectedVersion: current.version,
        next: nextState,
        recoverable: recoverableDescriptors(nextState),
      });
      if (outcome.outcome === 'conflict') return conflict(outcome.actualVersion);
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
    async scanRecoverable() {
      const snapshots: AgentSnapshot[] = [];
      const seenConversationIds = new Set<string>();
      let cursor: string | undefined;
      do {
        const page = AgentRecoverablePageSchema.parse(
          await driver.scanRecoverable({
            ...(cursor && { cursor }),
            limit: 100,
          }),
        );
        const conversationIds = [
          ...new Set(page.items.map((item) => item.conversationId)),
        ].filter((conversationId) => !seenConversationIds.has(conversationId));
        for (const conversationId of conversationIds) seenConversationIds.add(conversationId);
        snapshots.push(...(await Promise.all(conversationIds.map(loadSnapshot))));
        cursor = page.nextCursor;
      } while (cursor !== undefined);
      return snapshots;
    },
    async scanRecoverablePage(input) {
      const parsed = AgentRecoverableScanInputSchema.parse(input);
      return AgentRecoverablePageSchema.parse(await driver.scanRecoverable(parsed));
    },
  };
}

interface MemoryTransaction {
  states: Map<string, AgentStoredState>;
  histories: Map<string, AgentMessage[]>;
  archivedMessages: Map<string, Map<string, AgentMessage>>;
}

function cloneStateMap(source: ReadonlyMap<string, AgentStoredState>) {
  return new Map(
    [...source].map(([key, value]) => [
      key,
      AgentStoredStateSchema.parse(structuredClone(value)),
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
  let states = new Map<string, AgentStoredState>();
  let histories = new Map<string, AgentMessage[]>();
  let archivedMessages = new Map<string, Map<string, AgentMessage>>();
  let transactionTail = Promise.resolve();

  const driver: AgentRuntimeStoreDriver<MemoryTransaction> = {
    async transaction(work) {
      const previous = transactionTail;
      const release = Promise.withResolvers<void>();
      transactionTail = previous.catch(() => undefined).then(() => release.promise);
      await previous.catch(() => undefined);
      const transaction = {
        states: cloneStateMap(states),
        histories: cloneHistoryMap(histories),
        archivedMessages: new Map(
          [...archivedMessages].map(([conversationId, messages]) => [
            conversationId,
            new Map(
              [...messages].map(([messageId, message]) => [
                messageId,
                AgentMessageSchema.parse(structuredClone(message)),
              ]),
            ),
          ]),
        ),
      };
      try {
        const result = await work(transaction);
        states = transaction.states;
        histories = transaction.histories;
        archivedMessages = transaction.archivedMessages;
        return result;
      } finally {
        release.resolve();
      }
    },
    state: {
      async load(transaction, conversationId) {
        const state = transaction.states.get(conversationId);
        return state ? AgentStoredStateSchema.parse(structuredClone(state)) : undefined;
      },
      async compareAndSwap(transaction, input) {
        const current = transaction.states.get(input.conversationId);
        const actualVersion = current?.version ?? 0;
        if (actualVersion !== input.expectedVersion) {
          return { outcome: 'conflict', actualVersion };
        }
        transaction.states.set(
          input.conversationId,
          AgentStoredStateSchema.parse(structuredClone(input.next)),
        );
        return { outcome: 'applied' };
      },
    },
    history: {
      async load(transaction, conversationId) {
        return (transaction.histories.get(conversationId) ?? []).map((message) =>
          AgentMessageSchema.parse(structuredClone(message)),
        );
      },
      async loadById(transaction, input) {
        const active = (transaction.histories.get(input.conversationId) ?? []).find(
          (message) => message.id === input.messageId,
        );
        const message =
          active ??
          transaction.archivedMessages.get(input.conversationId)?.get(input.messageId);
        return message ? AgentMessageSchema.parse(structuredClone(message)) : undefined;
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
        const archive = transaction.archivedMessages.get(conversationId) ?? new Map();
        for (const message of current.filter((candidate) => replaced.has(candidate.id))) {
          archive.set(message.id, AgentMessageSchema.parse(structuredClone(message)));
        }
        transaction.archivedMessages.set(conversationId, archive);
        transaction.histories.set(conversationId, [
          ...current.slice(0, first),
          mutation.summary,
          ...current.slice(first + positions.length),
        ]);
      },
    },
    async scanRecoverable(input) {
      const descriptors = [...states.values()]
        .flatMap((state) =>
          state.runs
            .filter((run) => ['queued', 'running', 'interrupt_requested'].includes(run.state))
            .map((run) => ({ conversationId: state.conversationId, run })),
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
