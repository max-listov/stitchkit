import { createHash } from 'node:crypto';
import { z } from 'zod';
import type { AgentStoreEventEnvelope } from '../durability/events';
import {
  type AgentConversationBranchPlan,
  AgentConversationBranchPlanSchema,
  AgentConversationBranchReceiptSchema,
  type AgentConversationBranchResult,
  type BranchAgentConversationInput,
  BranchAgentConversationInputSchema,
} from './branch-contract';
import { rekeyBranchEvents } from './branch-events';
import { BranchIdentities } from './branch-identities';
import { AgentConversationBranchRefusedError } from './branch-refusal';
import { replayBranchEvents } from './branch-replay';
import { type BranchSource, branchHash, prepareBranchSource } from './branch-source';
import { AgentConversationPurgedError } from './purge';
import { exportConversationIn } from './store-archive';
import { assertSourceCapabilities } from './store-capabilities';
import type { AgentRuntimeStoreDriver } from './store-driver-contract';
import { agentStoreEventDraft } from './store-events';
import { persistRuntimeReplay } from './store-replay';

async function destinationEvents<T>(
  driver: AgentRuntimeStoreDriver<T>,
  tx: T,
  conversationId: string,
): Promise<AgentStoreEventEnvelope[]> {
  const events: AgentStoreEventEnvelope[] = [];
  let fromSeq: number | undefined;
  do {
    const page = await driver.events.list(tx, { conversationId, fromSeq, limit: 10_000 });
    events.push(...page.items);
    fromSeq = page.nextSeq;
  } while (fromSeq !== undefined);
  return events;
}

/** The request a host made, owned and fingerprinted; declarations are sets. */
function branchRequest(raw: BranchAgentConversationInput) {
  const parsed = BranchAgentConversationInputSchema.parse(raw);
  // Own binary input before the first await: the caller may reuse its buffer
  // while this request waits behind another transaction.
  const input = {
    ...parsed,
    source:
      parsed.source.kind === 'archive'
        ? { ...parsed.source, bytes: Uint8Array.from(parsed.source.bytes) }
        : parsed.source,
  };
  // The declarations are sets: the order a host lists them in is not part of the request.
  const fingerprint = branchHash({
    ...input,
    ...(input.applicationFiles && {
      applicationFiles: input.applicationFiles.toSorted((left, right) =>
        left.reference.localeCompare(right.reference),
      ),
    }),
    ...(input.applicationKeys && {
      applicationKeys: input.applicationKeys.toSorted((left, right) =>
        left.key.localeCompare(right.key),
      ),
    }),
    source:
      input.source.kind === 'archive'
        ? {
            kind: 'archive',
            digest: createHash('sha256').update(input.source.bytes).digest('hex'),
          }
        : input.source,
  });
  return { input, fingerprint };
}

type BranchRequest = ReturnType<typeof branchRequest>['input'];

/** The source archive's bytes, from the request or from the live conversation. */
async function sourceBytes<T>(
  driver: AgentRuntimeStoreDriver<T>,
  tx: T,
  input: BranchRequest,
): Promise<Uint8Array> {
  if (input.source.kind === 'archive') return input.source.bytes;
  if (await driver.conversations?.isPurged(tx, input.source.conversationId))
    throw new AgentConversationPurgedError();
  if (
    !(await driver.head.load(tx, input.source.conversationId)) &&
    (await driver.events.list(tx, { conversationId: input.source.conversationId, limit: 1 }))
      .items.length === 0
  )
    throw new TypeError('Branch source conversation was not found');
  return exportConversationIn(driver, tx, input.source.conversationId);
}

/** What the source needs of the driver; a plan and a branch refuse it the same way. */
function assertBranchDriverCapabilities<T>(
  driver: AgentRuntimeStoreDriver<T>,
  source: BranchSource,
): void {
  assertSourceCapabilities(driver, {
    spills: source.spills.length,
    projections: 0,
    compacted: source.replay.baseline?.compacted?.length ?? 0,
  });
}

/**
 * Everything the request refuses that a host lifts: the declarations the
 * source needs, and the fresh authorization its spills need. One list, so a
 * plan and a branch answer the same.
 */
function requestRefusal(input: BranchRequest, source: BranchSource) {
  const missingAuthorization = source.spills.length > 0 && !input.artifactAuthorization;
  if (!source.refused && !missingAuthorization) return undefined;
  return new AgentConversationBranchRefusedError(
    [
      ...(source.refused?.refusals ?? []),
      ...(missingAuthorization
        ? [
            {
              code: 'artifact-authorization-missing' as const,
              message: 'Branch spills require fresh destination artifact authorization',
            },
          ]
        : []),
    ],
    source.refused?.omittedRefusals ?? 0,
  );
}

/**
 * What a branch of this request would refuse, without writing anything: the
 * same planner, the same list, bound to the source it read by digest.
 */
export async function planConversationBranch<T>(
  driver: AgentRuntimeStoreDriver<T>,
  raw: BranchAgentConversationInput,
): Promise<AgentConversationBranchPlan> {
  const { input, fingerprint } = branchRequest(raw);
  return driver.transaction(
    async (tx) => {
      const bytes = await sourceBytes(driver, tx, input);
      const sourceArchiveDigest = createHash('sha256').update(bytes).digest('hex');
      let source: BranchSource;
      try {
        source = prepareBranchSource(bytes, input);
      } catch (error) {
        if (!(error instanceof AgentConversationBranchRefusedError)) throw error;
        return planOf(fingerprint, sourceArchiveDigest, error, []);
      }
      assertBranchDriverCapabilities(driver, source);
      return planOf(
        fingerprint,
        sourceArchiveDigest,
        requestRefusal(input, source),
        source.applicationFiles,
      );
      // A plan only reads: it must not hold the write lock a branch is waiting for.
    },
    { access: 'read' },
  );
}

function planOf(
  fingerprint: string,
  sourceArchiveDigest: string,
  refused: AgentConversationBranchRefusedError | undefined,
  applicationFiles: readonly string[],
): AgentConversationBranchPlan {
  const refusals = refused?.refusals ?? [];
  return AgentConversationBranchPlanSchema.parse({
    ready: refusals.length === 0,
    fingerprint,
    sourceArchiveDigest,
    refusals,
    omittedRefusals: refused?.omittedRefusals ?? 0,
    applicationFiles,
    undeclaredKeys: [
      ...new Set(
        refusals.flatMap((refusal) =>
          refusal.code === 'application-key-undeclared' && refusal.key ? [refusal.key] : [],
        ),
      ),
    ].sort(),
  });
}

/** Source read, validation, receipt and clone share one write transaction. */
export async function branchConversation<T>(
  driver: AgentRuntimeStoreDriver<T>,
  raw: BranchAgentConversationInput,
): Promise<AgentConversationBranchResult> {
  const { input, fingerprint } = branchRequest(raw);
  return driver.transaction(async (tx) => {
    if (await driver.conversations?.isPurged(tx, input.destinationConversationId))
      throw new AgentConversationPurgedError();
    const existing = await destinationEvents(driver, tx, input.destinationConversationId);
    const previous = existing.filter((event) => event.kind === 'runtime/branched').at(-1);
    if (previous) {
      const receipt = AgentConversationBranchReceiptSchema.parse(previous.payload);
      if (
        receipt.requestKey === input.requestKey &&
        receipt.fingerprint === fingerprint &&
        receipt.conversationId === input.destinationConversationId
      )
        return { outcome: 'duplicate', receipt };
      throw new TypeError('Branch request conflicts with the destination receipt');
    }
    if (
      (driver.conversations?.isEmpty &&
        !(await driver.conversations.isEmpty(tx, input.destinationConversationId))) ||
      existing.length > 0 ||
      (await driver.head.load(tx, input.destinationConversationId)) ||
      (await driver.history.load(tx, input.destinationConversationId)).length > 0
    )
      throw new TypeError('Branch destination must be empty');
    const bytes = await sourceBytes(driver, tx, input);
    const source = prepareBranchSource(bytes, input);
    if (source.conversationId === input.destinationConversationId)
      throw new TypeError('Branch requires a new conversation identity');
    assertBranchDriverCapabilities(driver, source);
    const refused = requestRefusal(input, source);
    if (refused) throw refused;
    const ids = new BranchIdentities(
      input.destinationConversationId,
      input.requestKey,
      source.conversationId,
    );
    for (const spill of source.spills) ids.define('spill', spill.reference);
    ids.declareApplicationFiles(input.applicationFiles ?? []);
    ids.declareApplicationKeys(input.applicationKeys ?? []);
    const events = rekeyBranchEvents(
      ids,
      source.conversationId,
      source.events,
      source.replay.retainedMessages,
    );
    const late = ids.refusedError();
    if (late) throw late;
    const replay = replayBranchEvents(input.destinationConversationId, events);
    const spills = source.spills.map(({ authorization: _sourceAuthority, ...spill }) => ({
      ...spill,
      reference: ids.reference('spill', spill.reference),
      ...(spill.runId && { runId: ids.reference('run', spill.runId) }),
      ...(spill.toolCallId && { toolCallId: ids.reference('call', spill.toolCallId) }),
      authorization: input.artifactAuthorization,
    }));
    const receipt = AgentConversationBranchReceiptSchema.parse({
      schemaVersion: 1,
      requestKey: input.requestKey,
      fingerprint,
      conversationId: input.destinationConversationId,
      sourceConversationId: source.conversationId,
      sourceKind: input.source.kind,
      ...(input.source.kind === 'conversation' &&
        input.source.throughRunId && { throughRunId: input.source.throughRunId }),
      sourceSeq: source.events.at(-1)?.seq ?? 0,
      sourceVersion: source.replay.snapshot.version,
      sourceDigest: source.digest,
      createdAt: new Date().toISOString(),
    });
    const next = {
      schemaVersion: 1,
      conversationId: input.destinationConversationId,
      version: replay.snapshot.version,
    } satisfies Parameters<typeof driver.head.compareAndSwap>[1]['next'];
    const cas = await driver.head.compareAndSwap(tx, {
      conversationId: input.destinationConversationId,
      expectedVersion: 0,
      next,
    });
    if (cas.outcome !== 'applied') throw new TypeError('Branch destination changed');
    await persistRuntimeReplay(driver, tx, replay);
    // Historical leases remain observations only; the normalized records carry none.
    for (const run of replay.snapshot.runs) {
      const stored = await driver.runs.load(tx, {
        conversationId: run.conversationId,
        runId: run.id,
      });
      if (!stored) throw new TypeError('Branch lost a normalized terminal record');
      const { ownerId: _owner, fencingToken: _fence, ...settled } = stored.run;
      await driver.runs.save(tx, { ...stored, run: settled });
    }

    for (const event of events) {
      const appended = await driver.events.append(tx, event);
      if (appended.seq !== event.seq) throw new TypeError('Branch event sequence changed');
    }
    await driver.archive?.import(tx, {
      format: 'stitchkit.agent-conversation',
      formatVersion: 1,
      conversationId: input.destinationConversationId,
      events: [],
      projections: [],
      spills: z.array(z.json()).parse(spills),
    });
    await driver.events.append(
      tx,
      agentStoreEventDraft({
        conversationId: input.destinationConversationId,
        kind: 'runtime/branched',
        payload: z.json().parse(receipt),
      }),
    );
    return { outcome: 'created', receipt };
  });
}
