import { z } from 'zod';
import { AgentConversationPurgedError } from './purge';
import type { AgentMessage, AgentSnapshot } from './schemas';
import type {
  AcceptInputAndAssignRun,
  AgentStoreMutationResult,
  SeedConversationInput,
} from './store';
import {
  type AgentAdmissionReceipt,
  type AgentRuntimeHead,
  AgentRuntimeHeadSchema,
  type AgentRuntimeStoreDriver,
  AgentSeedReceiptSchema,
  type AgentStoredRun,
  emptyHead,
} from './store-driver-contract';
import { agentStoreEventDraft } from './store-events';
import { conflict, type ReducedApplied, type StoreOperation } from './store-reduce-shared';
import { operationConversationId, reduceStore, transitionRecord } from './store-reducer';
import { mergeRunRecords, referencedRunIds, snapshotOf } from './store-snapshot';

/** What one mutation transaction read before it reduced anything. */
interface MutationRead {
  readonly conversationId: string;
  readonly head: AgentRuntimeHead;
  readonly messages: readonly AgentMessage[];
  readonly records: readonly AgentStoredRun[];
  readonly current: AgentSnapshot;
  readonly duplicateReceipt: AgentAdmissionReceipt | undefined;
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

/** Load the conversation as this mutation will see it, inside its transaction. */
async function readForMutation<TRANSACTION>(
  driver: AgentRuntimeStoreDriver<TRANSACTION>,
  transaction: TRANSACTION,
  operation: StoreOperation,
): Promise<MutationRead> {
  const conversationId = operationConversationId(operation);
  if (await driver.conversations?.isPurged(transaction, conversationId)) {
    throw new AgentConversationPurgedError();
  }
  const operationRunId =
    operation.type === 'accept'
      ? operation.input.coalesceIntoRunId
      : operation.type === 'compact' || operation.type === 'seed'
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
  return { conversationId, head, messages, records, current, duplicateReceipt };
}

/**
 * A seed that has already happened, answered without reducing anything.
 *
 * `undefined` means the seed is new and goes to the reducer like any other
 * mutation.
 */
async function settledSeed<TRANSACTION>(
  driver: AgentRuntimeStoreDriver<TRANSACTION>,
  transaction: TRANSACTION,
  read: MutationRead,
  input: SeedConversationInput,
): Promise<AgentStoreMutationResult | undefined> {
  const { conversationId, current } = read;
  // Exactly once. The receipt is the durable "already seeded" fact and it
  // outlives history replacement; the message-identity check covers an
  // imported conversation whose receipts were not restored, including a
  // seed whose message survives only as a compacted row that the active
  // view no longer shows. Both are read and acted on inside one
  // transaction, so concurrent admission cannot write the seed twice.
  const existing = await driver.seeds.load(transaction, {
    conversationId,
    seedKey: input.seedKey,
  });
  if (existing) return { outcome: 'applied', snapshot: current };
  let collisions = 0;
  for (const message of input.inputs) {
    if (
      current.messages.some((candidate) => candidate.id === message.id) ||
      (driver.history.hasMessage &&
        (await driver.history.hasMessage(transaction, {
          conversationId,
          messageId: message.id,
        })))
    )
      collisions++;
  }
  if (collisions > 0 && collisions < input.inputs.length) {
    throw new TypeError(
      'Partial instruction seed collision: restore the complete seed before retrying',
    );
  }
  if (collisions > 0) {
    await driver.seeds.create(
      transaction,
      AgentSeedReceiptSchema.parse({
        schemaVersion: 1,
        conversationId,
        seedKey: input.seedKey,
        messageIds: input.inputs.map((message) => message.id),
      }),
    );
    return { outcome: 'applied', snapshot: current };
  }
  return undefined;
}

/** The answer a retried idempotency key gets: the run its first admission made. */
async function duplicateAdmission<TRANSACTION>(
  driver: AgentRuntimeStoreDriver<TRANSACTION>,
  transaction: TRANSACTION,
  read: MutationRead,
  duplicateReceipt: AgentAdmissionReceipt,
): Promise<AgentStoreMutationResult> {
  const { conversationId, head, messages, records } = read;
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

/** Refuse an admission whose input or run identities are already stored. */
async function assertAdmissionIdentitiesFree<TRANSACTION>(
  driver: AgentRuntimeStoreDriver<TRANSACTION>,
  transaction: TRANSACTION,
  conversationId: string,
  input: AcceptInputAndAssignRun,
): Promise<void> {
  const inputCollision = await driver.admissions.loadByInputMessageId(transaction, {
    conversationId,
    inputMessageId: input.input.id,
  });
  if (inputCollision) {
    throw new TypeError('Input message identity is already assigned to an admission');
  }
  if (!input.coalesceIntoRunId) {
    const [runCollision, assistantCollision] = await Promise.all([
      driver.runs.load(transaction, {
        conversationId,
        runId: input.run.id,
      }),
      driver.runs.loadByAssistantMessageId(transaction, {
        conversationId,
        assistantMessageId: input.run.assistantMessageId,
      }),
    ]);
    if (runCollision || assistantCollision) {
      throw new TypeError('Queued run identities are already reserved');
    }
  }
}

/** Write an applied reduction: head first, then every normalized effect, then the ledger. */
async function persistApplied<TRANSACTION>(
  driver: AgentRuntimeStoreDriver<TRANSACTION>,
  transaction: TRANSACTION,
  read: MutationRead,
  operation: StoreOperation,
  reduced: ReducedApplied,
): Promise<AgentStoreMutationResult> {
  const { conversationId, current } = read;
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
  if (reduced.seedReceipt) {
    await driver.seeds.create(transaction, reduced.seedReceipt);
  }
  for (const mutation of reduced.historyMutations ?? []) {
    await driver.history.apply(transaction, mutation);
  }
  await driver.events.append(
    transaction,
    agentStoreEventDraft({
      conversationId,
      kind: 'runtime/transition',
      payload: z.json().parse(transitionRecord(operation)),
    }),
  );
  return { outcome: 'applied', snapshot: reduced.snapshot };
}

/**
 * One store mutation, in one driver transaction: read, reduce, persist.
 *
 * The reducer is pure and sees only a snapshot; everything that needs the
 * driver — purge refusal, seed and admission idempotency, identity collisions
 * the snapshot cannot show, and the compare-and-swap of the head — happens
 * here, around it.
 */
export function mutateStore<TRANSACTION>(
  driver: AgentRuntimeStoreDriver<TRANSACTION>,
  operation: StoreOperation,
): Promise<AgentStoreMutationResult> {
  return driver.transaction(async (transaction) => {
    const read = await readForMutation(driver, transaction, operation);
    if (operation.type === 'seed') {
      const settled = await settledSeed(driver, transaction, read, operation.input);
      if (settled) return settled;
    }
    if (read.duplicateReceipt) {
      return duplicateAdmission(driver, transaction, read, read.duplicateReceipt);
    }
    if (operation.type === 'accept') {
      await assertAdmissionIdentitiesFree(
        driver,
        transaction,
        read.conversationId,
        operation.input,
      );
    }
    const reduced = reduceStore(read.current, operation);
    if (reduced.outcome !== 'applied') return reduced;
    return persistApplied(driver, transaction, read, operation, reduced);
  });
}
