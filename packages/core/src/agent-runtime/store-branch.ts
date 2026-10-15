import { createHash } from 'node:crypto';
import { z } from 'zod';
import type { AgentStoreEventEnvelope } from '../durability/events';
import {
  AgentConversationBranchReceiptSchema,
  type AgentConversationBranchResult,
  type BranchAgentConversationInput,
  BranchAgentConversationInputSchema,
} from './branch-contract';
import { rekeyBranchEvents } from './branch-events';
import { BranchIdentities } from './branch-identities';
import { type BranchReplay, replayBranchEvents } from './branch-replay';
import { branchHash, prepareBranchSource } from './branch-source';
import { AgentConversationPurgedError } from './purge';
import { exportConversationIn } from './store-archive';
import type { AgentRuntimeStoreDriver } from './store-driver-contract';
import { agentStoreEventDraft } from './store-events';

async function persistReplay<T>(
  driver: AgentRuntimeStoreDriver<T>,
  tx: T,
  replay: BranchReplay,
) {
  if (replay.baseline) {
    const baseline = replay.baseline;
    for (const record of baseline.runs) await driver.runs.save(tx, record);
    if (driver.history.restore)
      await driver.history.restore(tx, {
        conversationId: baseline.head.conversationId,
        messages: baseline.messages,
        compactedMessageIds: baseline.compacted ?? [],
      });
    else
      for (const message of baseline.messages)
        await driver.history.apply(tx, { type: 'admit', input: message });
    for (const receipt of baseline.admissions) await driver.admissions.create(tx, receipt);
  }
  for (const effect of replay.effects) {
    for (const record of effect.runRecords ?? []) await driver.runs.save(tx, record);
    if (effect.admissionReceipt) await driver.admissions.create(tx, effect.admissionReceipt);
    if (effect.seedReceipt) await driver.seeds.create(tx, effect.seedReceipt);
    for (const mutation of effect.historyMutations ?? [])
      await driver.history.apply(tx, mutation);
  }
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
}

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

/** Source read, validation, receipt and clone share one write transaction. */
export async function branchConversation<T>(
  driver: AgentRuntimeStoreDriver<T>,
  raw: BranchAgentConversationInput,
): Promise<AgentConversationBranchResult> {
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
  const fingerprint = branchHash({
    ...input,
    source:
      input.source.kind === 'archive'
        ? {
            kind: 'archive',
            digest: createHash('sha256').update(input.source.bytes).digest('hex'),
          }
        : input.source,
  });
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
    if (
      input.source.kind === 'conversation' &&
      (await driver.conversations?.isPurged(tx, input.source.conversationId))
    )
      throw new AgentConversationPurgedError();
    if (
      input.source.kind === 'conversation' &&
      !(await driver.head.load(tx, input.source.conversationId)) &&
      (await driver.events.list(tx, { conversationId: input.source.conversationId, limit: 1 }))
        .items.length === 0
    )
      throw new TypeError('Branch source conversation was not found');
    const bytes =
      input.source.kind === 'archive'
        ? input.source.bytes
        : await exportConversationIn(driver, tx, input.source.conversationId);
    const source = prepareBranchSource(bytes, input.source);
    if (source.conversationId === input.destinationConversationId)
      throw new TypeError('Branch requires a new conversation identity');
    if (source.spills.length > 0 && (!input.artifactAuthorization || !driver.archive))
      throw new TypeError(
        'Branch spills require an archive adapter and fresh destination artifact authorization',
      );
    const ids = new BranchIdentities(
      input.destinationConversationId,
      input.requestKey,
      source.conversationId,
    );
    for (const spill of source.spills) ids.define('spill', spill.reference);
    const events = rekeyBranchEvents(
      ids,
      source.conversationId,
      source.events,
      source.replay.retainedMessages,
    );
    const replay = replayBranchEvents(input.destinationConversationId, events);
    if (replay.baseline?.compacted?.length && !driver.history.restore)
      throw new TypeError('Branch baseline requires inactive history restoration support');
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
    await persistReplay(driver, tx, replay);
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
