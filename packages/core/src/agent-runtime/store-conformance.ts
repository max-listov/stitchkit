import { z } from 'zod';
import type { AgentRuntimeStore } from './store';
import { branchConformance } from './store-conformance-branch';
import {
  archiveCapabilityScenario,
  historyRestoreCapabilityScenario,
} from './store-conformance-capabilities';
import { eventOnceScenario } from './store-conformance-event-once';
import {
  admissionPhase,
  boundedReadsPhase,
  fencingPhase,
  interruptPhase,
} from './store-conformance-lifecycle';
import {
  assertAbsorptionIsAtomic,
  assertActiveRunCausalOrder,
  assertCausalHistoryOrder,
  assertInterruptPriorityOrder,
} from './store-conformance-ordering';
import { seedScenario } from './store-conformance-seed';
import { queuedRun, requireOutcome, userMessage } from './store-conformance-support';
import { abandonPhase, terminalPhase } from './store-conformance-terminal';
import { decodeAgentConversationArchive } from './store-events';
import { createMemoryAgentRuntimeStore } from './store-memory';

/**
 * What the scenario is about to touch, handed over before the first mutation.
 *
 * The kit used to pick its conversation identities *after* `createStore()`
 * returned, which locked out exactly the adapters it exists to certify: a
 * durable store whose runtime rows hang off an application-owned conversation
 * row cannot serve the first admission, because nobody ever told it which
 * parent to provision. Running the kit against the memory reference store
 * instead proves the reducer — which is not the thing under test.
 */
export interface AgentStoreConformanceContext {
  /**
   * Every conversation the scenario mutates, in the order it first touches
   * them. Provision one parent per id before returning the store, and remove
   * them again in `cleanup`.
   */
  readonly conversationIds: readonly string[];
}

export interface AgentStoreConformanceConfig {
  /**
   * Build the store under test. The context arrives first so an adapter can
   * provision fixture state; a factory that needs none may ignore it, and an
   * existing zero-argument factory stays valid unchanged.
   */
  createStore(
    context: AgentStoreConformanceContext,
  ): AgentRuntimeStore | Promise<AgentRuntimeStore>;
  /**
   * Declare which optional store capabilities this adapter implements.
   *
   * Nothing is silently skipped: claiming `true` without implementing the
   * method, or claiming `false` while implementing it, fails conformance.
   */
  capabilities: AgentStoreConformanceCapabilities;
  /**
   * Make the next write transaction fail at `COMMIT` with the database's own
   * serialization conflict — so conformance proves the adapter retries it
   * (see `AgentRuntimeStoreDriver.transaction`) — or declare that the backing
   * engine cannot lose a commit because it has a single writer.
   */
  commitConflict:
    | {
        arm(): void | Promise<void>;
      }
    | {
        readonly impossible: 'single-writer';
      };
  /**
   * Remove whatever `createStore` provisioned.
   *
   * Runs exactly once, after the scenario, whether it passed or failed — a kit
   * that only cleans up on success leaks a row for every red run, which is the
   * shape that makes a failing suite un-rerunnable. A failure here never
   * replaces the scenario's own: the answer to "does this adapter conform" is
   * not overwritten by the answer to "did the teardown work".
   */
  cleanup?(context: AgentStoreConformanceContext): void | Promise<void>;
}

/**
 * The optional members an adapter declares: the two store methods, and the two driver
 * members the store reports on `store.capabilities`.
 */
export const AgentStoreConformanceCapabilitiesSchema = z.strictObject({
  branch: z.boolean(),
  planBranch: z.boolean(),
  archive: z.boolean(),
  historyRestore: z.boolean(),
});
/** The optional members an adapter declares to the conformance kit: branch, planBranch, archive, historyRestore. */
export type AgentStoreConformanceCapabilities = Readonly<
  z.infer<typeof AgentStoreConformanceCapabilitiesSchema>
>;

function validateConformanceConfig(config: AgentStoreConformanceConfig): void {
  if (!AgentStoreConformanceCapabilitiesSchema.safeParse(config.capabilities).success) {
    throw new TypeError(
      'runAgentStoreConformance requires capabilities: { branch: boolean, planBranch: boolean, archive: boolean, historyRestore: boolean }',
    );
  }
  const commitConflict: unknown = config.commitConflict;
  if (typeof commitConflict !== 'object' || commitConflict === null) {
    throw new TypeError(
      "runAgentStoreConformance requires commitConflict: { arm() } | { impossible: 'single-writer' }",
    );
  }
  const hasArm = typeof Reflect.get(commitConflict, 'arm') === 'function';
  const hasImpossible = Reflect.get(commitConflict, 'impossible') === 'single-writer';
  if (hasArm === hasImpossible) {
    throw new TypeError(
      "runAgentStoreConformance requires commitConflict: { arm() } | { impossible: 'single-writer' }",
    );
  }
}

function assertConformanceCapabilities(
  store: AgentRuntimeStore,
  capabilities: AgentStoreConformanceConfig['capabilities'],
): void {
  const hasBranch = typeof store.branchConversation === 'function';
  const hasPlanBranch = typeof store.planConversationBranch === 'function';
  if (capabilities.branch && !hasBranch) {
    throw new Error(
      'Agent store conformance: capabilities.branch is true, but store.branchConversation is missing',
    );
  }
  if (!capabilities.branch && hasBranch) {
    throw new Error(
      'Agent store conformance: capabilities.branch is false, but store.branchConversation is implemented',
    );
  }
  if (capabilities.planBranch && !capabilities.branch) {
    throw new Error(
      'Agent store conformance: capabilities.planBranch is true, but capabilities.branch is false',
    );
  }
  if (capabilities.planBranch && !hasPlanBranch) {
    throw new Error(
      'Agent store conformance: capabilities.planBranch is true, but store.planConversationBranch is missing',
    );
  }
  if (!capabilities.planBranch && hasPlanBranch) {
    throw new Error(
      'Agent store conformance: capabilities.planBranch is false, but store.planConversationBranch is implemented',
    );
  }
  const reported = store.capabilities;
  if (reported === undefined) {
    throw new Error(
      'Agent store conformance: store.capabilities is missing; build the store with createAgentRuntimeStore',
    );
  }
  for (const [declared, actual, member] of [
    [capabilities.archive, reported.archive, 'archive'],
    [capabilities.historyRestore, reported.historyRestore, 'historyRestore'],
  ] as const) {
    if (declared !== actual)
      throw new Error(
        `Agent store conformance: capabilities.${member} is ${declared}, but store.capabilities.${member} is ${actual}`,
      );
  }
}

/** Black-box contract shared by memory and third-party durable agent stores. */
export async function runAgentStoreConformance(
  config: AgentStoreConformanceConfig,
): Promise<void> {
  validateConformanceConfig(config);
  const run = `conformance-${crypto.randomUUID()}`;
  const context: AgentStoreConformanceContext = {
    conversationIds: [
      run,
      `${run}-recovery`,
      `${run}-absorb`,
      `${run}-causal-history`,
      `${run}-causal-active`,
      `${run}-interrupt-priority`,
      `${run}-ledger`,
      `${run}-archive`,
      `${run}-seed`,
      `${run}-branch-source`,
      `${run}-branch`,
      `${run}-branch-restored`,
      `${run}-event-once`,
      `${run}-event-once-peer`,
      `${run}-capability-archive`,
      `${run}-capability-history-restore`,
      `${run}-commit-conflict`,
    ],
  };
  const store = await config.createStore(context);
  let failure: unknown;
  try {
    assertConformanceCapabilities(store, config.capabilities);
    await conformanceScenario(store, context.conversationIds, config.capabilities);
    await commitConflictScenario(store, context.conversationIds, config.commitConflict);
  } catch (error) {
    failure = error;
  }
  try {
    await config.cleanup?.(context);
  } catch (cleanupError) {
    if (failure === undefined) throw cleanupError;
    // Both failed. The scenario's message leads, so an assertion on it still
    // matches, and the teardown failure travels with it instead of replacing
    // it or vanishing.
    throw new AggregateError(
      [failure, cleanupError],
      `${failure instanceof Error ? failure.message : String(failure)} (cleanup also failed: ${
        cleanupError instanceof Error ? cleanupError.message : String(cleanupError)
      })`,
    );
  }
  if (failure !== undefined) throw failure;
}

async function commitConflictScenario(
  store: AgentRuntimeStore,
  conversationIds: readonly string[],
  commitConflict: AgentStoreConformanceConfig['commitConflict'],
): Promise<void> {
  if ('impossible' in commitConflict) return;
  const conversationId = conversationIds.at(-1);
  if (!conversationId) return;
  await commitConflict.arm();
  const accepted = await store.acceptInputAndAssignRun({
    idempotencyKey: 'commit-conflict',
    input: userMessage(conversationId, 'commit-conflict-input'),
    run: queuedRun(conversationId, 'commit-conflict-input', 'commit-conflict-run'),
  });
  requireOutcome(accepted, 'applied');
  const snapshot = await store.loadSnapshot(conversationId);
  if (snapshot.runs.length !== 1) {
    throw new Error('A commit conflict must leave its write applied exactly once');
  }
}

async function conformanceScenario(
  store: AgentRuntimeStore,
  conversationIds: readonly string[],
  capabilities: AgentStoreConformanceConfig['capabilities'],
): Promise<void> {
  const [
    conversationId,
    recoveryConversationId,
    absorbConversationId,
    causalHistoryConversationId,
    causalActiveConversationId,
    interruptPriorityConversationId,
    ledgerConversationId,
    archiveConversationId,
    seedConversationId,
    branchSourceId,
    branchDestinationId,
    branchRestoredId,
    eventOnceId,
    eventOncePeerId,
    capabilityArchiveId,
    capabilityRestoreId,
  ] = conversationIds;
  if (branchSourceId && branchDestinationId && branchRestoredId)
    await branchConformance(
      store,
      branchSourceId,
      branchDestinationId,
      branchRestoredId,
      capabilities,
    );
  if (seedConversationId) await seedScenario(store, seedConversationId);
  if (eventOnceId && eventOncePeerId)
    await eventOnceScenario(store, eventOnceId, eventOncePeerId);
  if (ledgerConversationId) await ledgerScenario(store, ledgerConversationId);
  if (archiveConversationId) await archiveScenario(store, archiveConversationId);
  if (capabilityArchiveId)
    await archiveCapabilityScenario(store, capabilityArchiveId, capabilities.archive);
  if (capabilityRestoreId)
    await historyRestoreCapabilityScenario(
      store,
      capabilityRestoreId,
      capabilities.historyRestore,
    );
  if (
    !conversationId ||
    !recoveryConversationId ||
    !absorbConversationId ||
    !causalHistoryConversationId ||
    !causalActiveConversationId ||
    !interruptPriorityConversationId
  ) {
    throw new Error('Agent store conformance requires six conversation identities');
  }
  /**
   * An identity the scenario asserts is ABSENT, and therefore deliberately not
   * in `conversationIds` — provisioning it would destroy the assertion.
   *
   * Generated rather than written out: the literal `'no-such-conversation'` it
   * used to be is a string a consumer's own database may legitimately contain,
   * and then a green adapter failed here for a reason that has nothing to do
   * with the contract.
   */
  const absentConversationId = `${conversationId}-absent`;
  const assigned = await admissionPhase(store, conversationId);
  const checkpointed = await fencingPhase(store, conversationId, assigned);
  await boundedReadsPhase(store, conversationId, absentConversationId, checkpointed);
  const interruptedRun = await interruptPhase(store, conversationId, checkpointed);
  await terminalPhase(store, conversationId, checkpointed, interruptedRun);
  await abandonPhase(store, recoveryConversationId);

  await assertCausalHistoryOrder(store, causalHistoryConversationId);
  await assertActiveRunCausalOrder(store, causalActiveConversationId);
  await assertInterruptPriorityOrder(store, interruptPriorityConversationId);
  await assertAbsorptionIsAtomic(store, absorbConversationId);
}

/**
 * The event ledger, as every store must keep it.
 *
 * Added when a driver's `events` became mandatory and no conformance scenario
 * exercised it: the Prisma example implemented `seq = max + 1` under a
 * transaction and nothing proved it held under concurrent appends.
 */
async function ledgerScenario(
  store: AgentRuntimeStore,
  conversationId: string,
): Promise<void> {
  const first = await store.appendEvent({
    conversationId,
    kind: 'state/set',
    payload: { n: 1 },
  });
  if (first.seq !== 1)
    throw new Error(`Agent store conformance expected seq 1, received ${first.seq}`);
  // Twenty concurrent appends: every seq unique and contiguous, none lost.
  const appended = await Promise.all(
    Array.from({ length: 20 }, (_, index) =>
      store.appendEvent({ conversationId, kind: 'state/set', payload: { n: index + 2 } }),
    ),
  );
  const seqs = [first.seq, ...appended.map((event) => event.seq)].sort((a, b) => a - b);
  for (let index = 0; index < seqs.length; index += 1) {
    if (seqs[index] !== index + 1) {
      throw new Error(
        `Agent store conformance expected contiguous seq, received ${seqs.join(',')}`,
      );
    }
  }
  const page = await store.readEvents({ conversationId, fromSeq: 5, toSeq: 9, limit: 3 });
  if (page.items.map((event) => event.seq).join(',') !== '5,6,7' || page.nextSeq !== 8) {
    throw new Error(
      `Agent store conformance expected events 5,6,7 then 8, received ${page.items
        .map((event) => event.seq)
        .join(',')} then ${page.nextSeq}`,
    );
  }
  const ignorable = await store.appendEvent({
    conversationId,
    kind: 'state/set',
    payload: { n: 'ignorable' },
    ignorable: true,
  });
  if (ignorable.ignorable !== true) {
    throw new Error('Agent store conformance expected the ignorable flag to persist');
  }
  // Import requires an empty conversation, so the round trip is proven by the
  // memory and SQLite suites on a second store; here the export itself must be
  // byte-stable and carry every event, ignorable included.
  const archive = await store.exportConversation(conversationId);
  const again = await store.exportConversation(conversationId);
  if (Buffer.compare(Buffer.from(archive), Buffer.from(again)) !== 0) {
    throw new Error(
      'Agent store conformance expected two exports of a quiet store to be byte-equal',
    );
  }
  const decoded = decodeAgentConversationArchive(archive);
  if (decoded.events.length !== 22) {
    throw new Error(
      `Agent store conformance expected 22 archived events, received ${decoded.events.length}`,
    );
  }
}

/**
 * A conversation that actually happened, carried into this adapter.
 *
 * The export half is checked beside the ledger; import needs a target whose
 * event log is empty, so the archive is produced by the reference store and
 * lands here on an identity nothing has written to. A conversation with a turn
 * in it is the whole point: an archive whose snapshot holds a run takes the
 * head compare-and-swap path, and a SQLite store that decided that swap by the
 * driver's `changes` refused every such archive while reporting the target
 * empty.
 */
async function archiveScenario(
  store: AgentRuntimeStore,
  conversationId: string,
): Promise<void> {
  const origin = createMemoryAgentRuntimeStore();
  const inputMessage = userMessage(conversationId, 'archived-input');
  const run = queuedRun(conversationId, inputMessage.id, 'archived-run');
  requireOutcome(
    await origin.acceptInputAndAssignRun({
      idempotencyKey: 'archived-request',
      input: inputMessage,
      run,
    }),
    'applied',
  );
  await origin.appendEvent({
    conversationId,
    kind: 'state/set',
    payload: { name: 'topic', value: 'archive' },
  });

  const imported = await store.importConversation(
    await origin.exportConversation(conversationId),
  );
  if (imported.conversationId !== conversationId || imported.events !== 2) {
    throw new Error(
      `Agent store conformance expected 2 imported events for ${conversationId}, received ${imported.events} for ${imported.conversationId}`,
    );
  }

  const restored = await store.loadSnapshot(conversationId);
  const expected = await origin.loadSnapshot(conversationId);
  if (
    restored.version !== expected.version ||
    restored.messages.map((message) => message.id).join(',') !==
      expected.messages.map((message) => message.id).join(',') ||
    restored.runs.map((entry) => `${entry.id}:${entry.state}`).join(',') !==
      expected.runs.map((entry) => `${entry.id}:${entry.state}`).join(',')
  ) {
    throw new Error(
      `Agent store conformance expected the imported snapshot to match its archive, received version ${restored.version} with ${restored.messages.length} messages and ${restored.runs.length} runs`,
    );
  }
  const events = await store.readEvents({ conversationId, limit: 10 });
  if (events.items.map((event) => event.kind).join(',') !== 'runtime/transition,state/set') {
    throw new Error(
      `Agent store conformance expected the imported ledger to keep its kinds, received ${events.items
        .map((event) => event.kind)
        .join(',')}`,
    );
  }
}
