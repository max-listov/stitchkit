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
  runStateForTerminalReason,
} from './schemas';
import {
  type AcceptInputAndAssignRun,
  AcceptInputAndAssignRunSchema,
  type AcquireAgentRun,
  AcquireAgentRunSchema,
  type AgentRuntimeStore,
  type AgentRunView,
  AgentRunViewSchema,
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
  /**
   * Plural because one mutation can settle two runs.
   *
   * A terminal commit that absorbs a queued successor writes both records, and
   * it must write them in one transaction or the absorption is exactly the
   * split-brain the 0.63.0 design shipped.
   */
  runRecords?: readonly AgentStoredRun[];
  admissionReceipt?: AgentAdmissionReceipt;
  historyMutations?: readonly AgentHistoryMutation[];
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

function orderRuns(messages: readonly AgentMessage[], runs: readonly AgentRun[]): AgentRun[] {
  const positionOf = historyPositions(messages);
  return [...runs].sort(
    (left, right) =>
      left.createdAt.localeCompare(right.createdAt) ||
      positionOf(left) - positionOf(right) ||
      left.id.localeCompare(right.id),
  );
}

/**
 * Put every run-owned message into durable causal order without moving
 * unowned history anchors such as summaries and system records.
 *
 * Admissions are durable before execution, so storage naturally appends a
 * queued successor's user message before the predecessor writes its assistant.
 * Replacing only the owned slots keeps storage codecs append-friendly while a
 * snapshot consistently reads as input(s) → answer, then successor input(s).
 */
function orderRunMessages(
  messages: readonly AgentMessage[],
  runs: readonly AgentRun[],
): AgentMessage[] {
  const byId = new Map(messages.map((message) => [message.id, message]));
  const ownedIds = new Set(
    runs.flatMap((run) => [...run.inputMessageIds, run.assistantMessageId]),
  );
  const orderedOwned = runs.flatMap((run) =>
    [...run.inputMessageIds, run.assistantMessageId].flatMap((id) => {
      const message = byId.get(id);
      return message ? [message] : [];
    }),
  );
  let ownedIndex = 0;
  return messages.map((message) => {
    if (!ownedIds.has(message.id)) return message;
    const ordered = orderedOwned[ownedIndex];
    if (!ordered) throw new TypeError('Stored agent history lost a run-owned message');
    ownedIndex += 1;
    return ordered;
  });
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
  const runs = orderRuns(
    messages,
    records.map((record) => record.run),
  );
  return AgentSnapshotSchema.parse({
    schemaVersion: 1,
    conversationId: head.conversationId,
    version: head.version,
    messages: orderRunMessages(messages, runs),
    runs,
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

/**
 * The run states a recovery pass and an active listing must consider.
 *
 * Exported because a driver author needs it: `runs.listActive` and
 * `scanRecoverable` are driver members, so this list crossed the public
 * boundary as a literal every adapter had to guess and hardcode — the reference
 * adapter repeats it three times. Adding a run state silently broke every
 * deployed driver. Same reasoning as `isSpeakableAssistantStatus`, applied to
 * the enum that a consumer implements against rather than reads.
 */
export const ACTIVE_AGENT_RUN_STATES: readonly AgentRun['state'][] = [
  'queued',
  'running',
  'interrupt_requested',
];

function isActiveRunState(state: AgentRun['state']): boolean {
  return ACTIVE_AGENT_RUN_STATES.includes(state);
}

function conflict(actualVersion: number): {
  outcome: 'conflict';
  actualVersion: number;
} {
  return { outcome: 'conflict', actualVersion };
}

function applied(
  current: AgentSnapshot,
  input: { runs?: readonly AgentRun[]; messages?: readonly AgentMessage[] },
  effects?: {
    runRecords?: readonly AgentStoredRun[];
    admissionReceipt?: AgentAdmissionReceipt;
    historyMutations?: readonly AgentHistoryMutation[];
  },
): ReducedApplied {
  const runs = input.runs ?? current.runs;
  const messages = input.messages ?? current.messages;
  return {
    outcome: 'applied',
    snapshot: AgentSnapshotSchema.parse({
      ...current,
      version: current.version + 1,
      runs,
      messages: orderRunMessages(messages, runs),
    }),
    ...(effects?.runRecords?.length && { runRecords: effects.runRecords }),
    ...(effects?.admissionReceipt && { admissionReceipt: effects.admissionReceipt }),
    ...(effects?.historyMutations?.length && { historyMutations: effects.historyMutations }),
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
        runRecords: [AgentStoredRunSchema.parse({ schemaVersion: 1, run: assignedRun })],
        admissionReceipt,
        historyMutations: [{ type: 'admit', input: input.input }],
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
        runRecords: [AgentStoredRunSchema.parse({ schemaVersion: 1, run: next })],
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
      ...(input.usage && { usage: input.usage }),
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
        runRecords: [AgentStoredRunSchema.parse({ schemaVersion: 1, run: next })],
        historyMutations: [{ type: 'upsert-assistant', message: input.assistant }],
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
        runRecords: [AgentStoredRunSchema.parse({ schemaVersion: 1, run: next })],
      },
    );
  }

  if (operation.type === 'recover' && run) {
    const input = operation.input;
    if (run.revision !== input.expectedRevision || !isActiveRunState(run.state)) {
      return conflict(run.revision);
    }
    if (input.action === 'requeue' && run.state !== 'queued' && input.replaySafe !== true) {
      throw new TypeError('Recovering an acquired run requires explicit replaySafe evidence');
    }
    // Carry the record forward and override what recovery changes, rather than
    // rebuilding it from a list of fields. The list was the defect: it silently
    // dropped every field added to `AgentRun` after it was written, and two of
    // them mattered. `usage` is what a crashed attempt already spent — the
    // figure this whole durable field exists to preserve, deleted by the one
    // path that exists to recover from a crash. `fencingToken` is documented as
    // monotonic so a distributed adapter can reject an old owner *even if an
    // owner label is reused*, and resetting it to undefined made the next
    // acquisition mint token 1 again — defeating precisely the named scenario.
    //
    // `ownerId` is the one field recovery really does clear: the lease is
    // released, and that is the point of recovering.
    const { ownerId: _released, ...carried } = run;
    const next = AgentRunSchema.parse({
      ...carried,
      state: input.action === 'requeue' ? 'queued' : 'abandoned',
      revision: run.revision + 1,
      ...(input.action === 'abandon' && { terminalReason: 'abandoned' }),
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
          runRecords: [
            AgentStoredRunSchema.parse({
              schemaVersion: 1,
              run: next,
              terminalAssistant: assistant,
            }),
          ],
          historyMutations: [{ type: 'upsert-assistant', message: assistant }],
        },
      );
    }
    return applied(
      current,
      { runs: replaceRun(current.runs, next) },
      {
        runRecords: [AgentStoredRunSchema.parse({ schemaVersion: 1, run: next })],
      },
    );
  }

  if (operation.type === 'terminal' && run) {
    const input = operation.input;
    // `absorbed` is never an operation's own reason. It is written onto the
    // *other* run of an absorbing commit, below, and a caller passing it here
    // would be terminalizing a run whose answer lives somewhere else.
    if (input.reason === 'absorbed') {
      throw new TypeError('A run is absorbed by another run, never terminalized as absorbed');
    }
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
    // Only a run that finished may claim to have answered somebody else's
    // input. An interrupted or failed run took the input into its prompt and
    // then stopped, so the successor stays queued and answers itself.
    if (input.absorb && runStateForTerminalReason(input.reason) !== 'completed') {
      throw new TypeError('Only a completing run may absorb a queued successor');
    }
    // Refused, not dropped — neither of these is a race, and dropping them
    // would hide a caller that has lost track of which run it is committing.
    const named = new Set((input.absorb ?? []).map((entry) => entry.runId));
    if (named.size !== (input.absorb ?? []).length || named.has(run.id)) {
      throw new TypeError(
        'An absorption names each successor once, and never the absorbing run',
      );
    }
    // Dropped rather than refused: a successor that is no longer queued has
    // been taken over by something else, and failing the commit over it would
    // lose the answer this run has already produced. The dropped successor runs
    // on its own, which is the behaviour it would have had anyway.
    const absorbable = (input.absorb ?? []).filter((entry) => {
      const candidate = current.runs.find((item) => item.id === entry.runId);
      return (
        candidate !== undefined &&
        candidate.id !== run.id &&
        candidate.state === 'queued' &&
        candidate.conversationId === run.conversationId &&
        candidate.inputMessageIds.length === entry.inputMessageIds.length &&
        candidate.inputMessageIds.every((id, index) => id === entry.inputMessageIds[index])
      );
    });
    const absorbedIds = new Set(absorbable.flatMap((entry) => entry.inputMessageIds));
    const next = AgentRunSchema.parse({
      ...run,
      state: runStateForTerminalReason(input.reason),
      terminalReason: input.reason,
      ...(input.policyName && { terminalPolicyName: input.policyName }),
      ...(input.usage && { usage: input.usage }),
      // The absorbed inputs are inputs this run answered, so they belong to its
      // record. Order is admission order, and the absorbed ones came last.
      ...(absorbedIds.size > 0 && {
        inputMessageIds: [
          ...run.inputMessageIds,
          ...[...absorbedIds].filter((id) => !run.inputMessageIds.includes(id)),
        ],
      }),
      revision: run.revision + 1,
      updatedAt: new Date().toISOString(),
    });
    // No assistant message for an absorbed run, deliberately. It produced
    // nothing; the answer is on `next`, and inventing an empty message here
    // would be a record saying this run answered when it did not. Its reserved
    // assistant identity simply stays unused.
    const absorbedRuns = absorbable.map((entry) => {
      const candidate = current.runs.find((item) => item.id === entry.runId);
      if (!candidate) throw new TypeError('Absorbed run disappeared inside the reducer');
      return AgentRunSchema.parse({
        ...candidate,
        state: runStateForTerminalReason('absorbed'),
        terminalReason: 'absorbed',
        absorbedIntoRunId: next.id,
        revision: candidate.revision + 1,
        updatedAt: new Date().toISOString(),
      });
    });
    const runs = absorbedRuns.reduce(
      (accumulated, absorbed) => replaceRun(accumulated, absorbed),
      replaceRun(current.runs, next),
    );
    return applied(
      current,
      {
        runs,
        messages: replaceMessage(current.messages, input.assistant),
      },
      {
        runRecords: [
          AgentStoredRunSchema.parse({
            schemaVersion: 1,
            run: next,
            terminalAssistant: input.assistant,
          }),
          ...absorbedRuns.map((absorbed) =>
            AgentStoredRunSchema.parse({ schemaVersion: 1, run: absorbed }),
          ),
        ],
        historyMutations: [{ type: 'upsert-assistant', message: input.assistant }],
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

  /**
   * `loadRun` reads one run and the head. `listActiveRuns` also reads history:
   * active recovery order must use the same causal tie-break as a snapshot,
   * because same-millisecond identifiers are not queue positions. Neither
   * needs a new driver member; both compose the normalized boundaries already
   * present here.
   */
  const loadRun = (input: {
    conversationId: string;
    runId: string;
  }): Promise<AgentRunView | undefined> =>
    driver.transaction(async (transaction) => {
      const [stored, record] = await Promise.all([
        driver.head.load(transaction, input.conversationId),
        driver.runs.load(transaction, input),
      ]);
      if (!record) return undefined;
      const parsed = AgentStoredRunSchema.parse(record);
      if (
        parsed.run.conversationId !== input.conversationId ||
        parsed.run.id !== input.runId
      ) {
        throw new TypeError('Stored run does not match the identity it was loaded by');
      }
      const head = AgentRuntimeHeadSchema.parse(stored ?? emptyHead(input.conversationId));
      return AgentRunViewSchema.parse({
        snapshotVersion: head.version,
        run: parsed.run,
        ...(parsed.terminalAssistant && { assistant: parsed.terminalAssistant }),
      });
    });

  const listActiveRuns = (conversationId: string): Promise<readonly AgentRun[]> =>
    driver.transaction(async (transaction) => {
      const [records, messages] = await Promise.all([
        driver.runs.listActive(transaction, conversationId),
        driver.history.load(transaction, conversationId),
      ]);
      const runs = records.map((record) => AgentStoredRunSchema.parse(record).run);
      for (const run of runs) {
        if (run.conversationId !== conversationId) {
          throw new TypeError('Active run belongs to another conversation');
        }
        if (!isActiveRunState(run.state)) {
          throw new TypeError('Active run listing returned a terminal run');
        }
      }
      return orderRuns(messages, runs);
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
        // An absorbed run has no answer of its own — the run that took its
        // input on has it. Following the pointer here is what makes a retry of
        // the original idempotency key return the answer, across a restart and
        // for as long as both records exist. Without it the key would resolve
        // to an empty terminal record forever, which is exactly the case
        // idempotency keys exist for.
        const answering = duplicateRecord.run.absorbedIntoRunId
          ? await driver.runs.load(transaction, {
              conversationId,
              runId: duplicateRecord.run.absorbedIntoRunId,
            })
          : undefined;
        if (duplicateRecord.run.absorbedIntoRunId && !answering) {
          throw new TypeError('Absorbed run points to a missing absorbing run');
        }
        const canonical = answering ?? duplicateRecord;
        return {
          outcome: 'duplicate',
          input: duplicateReceipt.input,
          inputMessageId: duplicateReceipt.input.id,
          runId: canonical.run.id,
          assistantMessageId: canonical.run.assistantMessageId,
          run: canonical.run,
          ...(canonical.terminalAssistant && {
            assistant: canonical.terminalAssistant,
          }),
          snapshot: snapshotOf(
            head,
            messages,
            mergeRunRecords(records, [duplicateRecord], answering ? [answering] : []),
          ),
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
      for (const record of reduced.runRecords ?? []) {
        await driver.runs.save(transaction, record);
      }
      if (reduced.admissionReceipt) {
        await driver.admissions.create(transaction, reduced.admissionReceipt);
      }
      for (const mutation of reduced.historyMutations ?? []) {
        await driver.history.apply(transaction, mutation);
      }
      return { outcome: 'applied', snapshot: reduced.snapshot };
    });

  return {
    loadSnapshot,
    loadRun,
    listActiveRuns,
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
          .filter((record) => isActiveRunState(record.run.state))
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
            .filter((record) => isActiveRunState(record.run.state))
            .map((record) => ({ conversationId, run: record.run })),
        )
        .sort(
          (left, right) =>
            left.conversationId.localeCompare(right.conversationId) ||
            left.run.id.localeCompare(right.run.id),
        );
      const cursorTuple = input.cursor ? parseRecoverableCursor(input.cursor) : undefined;
      // Keyset, not "the index after the cursor". Looking the cursor up by
      // identity returns -1 the moment that run stops being recoverable — which
      // is the *normal* outcome of a recovery pass, since recovering a run is
      // what takes it out of the set — and `-1 + 1` restarted the scan at the
      // beginning. A pass then re-visited conversations it had handled and
      // burned its budget without reaching the tail. This is the reference
      // implementation adapter authors copy.
      const start = cursorTuple
        ? descriptors.findIndex(
            (item) =>
              item.conversationId.localeCompare(cursorTuple[0]) > 0 ||
              (item.conversationId === cursorTuple[0] &&
                item.run.id.localeCompare(cursorTuple[1]) > 0),
          )
        : 0;
      if (start === -1) {
        return AgentRecoverablePageSchema.parse({ items: [] });
      }
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
