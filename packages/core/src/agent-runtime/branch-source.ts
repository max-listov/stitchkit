import { createHash } from 'node:crypto';
import { z } from 'zod';
import type { AgentStoreEventEnvelope } from '../durability/events';
import { ArchiveProjectionSchema } from './archive-projection';
import { ArchiveSpillSchema } from './archive-spill';
import type { ParsedBranchAgentConversationInput } from './branch-contract';
import { rekeyBranchEvents } from './branch-events';
import { BranchIdentities } from './branch-identities';
import { BranchObservationSchema, SpillEventPayloadSchema } from './branch-observations';
import { AgentConversationBranchRefusedError } from './branch-refusal';
import { type BranchReplay, replayBranchEvents } from './branch-replay';
import { type AgentSnapshot, AgentSnapshotSchema } from './schemas';
import { isActiveRunState } from './store-driver-contract';
import { canonicalAgentJson, decodeAgentConversationArchive } from './store-events';

const SnapshotProjection = z
  .object({ archiveType: z.literal('runtime-snapshot'), snapshot: AgentSnapshotSchema })
  .strict();

export function branchHash(value: unknown): string {
  return createHash('sha256').update(canonicalAgentJson(value)).digest('hex');
}

function visibleSnapshot(snapshot: AgentSnapshot) {
  const referenced = new Set(
    snapshot.messages.flatMap((message) => (message.runId ? [message.runId] : [])),
  );
  return {
    ...snapshot,
    runs: snapshot.runs
      .filter((run) => referenced.has(run.id) || isActiveRunState(run.state))
      .map(({ updatedAt: _time, ...run }) => run)
      .sort((a, b) => a.id.localeCompare(b.id)),
  };
}

function boundary(
  events: readonly AgentStoreEventEnvelope[],
  throughRunId: string | undefined,
): number {
  if (!throughRunId) return events.length;
  for (const event of events) {
    if (event.kind !== 'runtime/transition') continue;
    const candidate = z
      .object({
        type: z.string(),
        input: z.object({
          runId: z.string().optional(),
          reason: z.string().optional(),
          action: z.string().optional(),
          absorb: z.array(z.object({ runId: z.string() })).optional(),
        }),
      })
      .safeParse(event.payload);
    if (!candidate.success) continue;
    const { type, input } = candidate.data;
    if (
      (type === 'terminal' &&
        (input.runId === throughRunId ||
          input.absorb?.some((entry) => entry.runId === throughRunId))) ||
      (type === 'recover' && input.action === 'abandon' && input.runId === throughRunId)
    )
      return event.seq;
  }
  throw new TypeError('Branch boundary run has no exact settled event');
}

export interface BranchExpiredSpillTail {
  reference: string;
  bytes: number;
  sha256?: string;
}

function integrityRefusal(
  message: string,
  address?: { seq: number; eventKind: string },
): AgentConversationBranchRefusedError {
  return new AgentConversationBranchRefusedError([
    { ...(address ?? {}), code: 'integrity', message },
  ]);
}

/**
 * Derive spills that legitimately expired via paired `spill/created` -> `spill/deleted`
 * events anywhere in the archive (including inherited `runtime/branch-observation` records).
 * Any orphaned, duplicated, out-of-order, mismatched, or still-live deleted spill refuses
 * with `integrity`.
 */
function collectExpiredSpills(
  events: readonly AgentStoreEventEnvelope[],
  liveSpills: readonly z.infer<typeof ArchiveSpillSchema>[],
): {
  expiredSpills: string[];
  deletedMeta: Map<string, { seq: number; bytes: number; sha256?: string }>;
} {
  const created = new Map<string, { seq: number; bytes: number; sha256?: string }>();
  const deleted = new Map<string, { seq: number; bytes: number; sha256?: string }>();
  for (const event of events) {
    let sourceKind: string = event.kind;
    let payload: unknown = event.payload;
    if (event.kind === 'runtime/branch-observation') {
      const obs = BranchObservationSchema.safeParse(event.payload);
      if (!obs.success) continue;
      sourceKind = obs.data.sourceKind;
      payload = obs.data.payload;
    }
    if (sourceKind !== 'spill/created' && sourceKind !== 'spill/deleted') continue;
    const parsed = SpillEventPayloadSchema.safeParse(payload);
    if (!parsed.success) {
      throw integrityRefusal(`Branch archive has malformed ${sourceKind} payload`, {
        seq: event.seq,
        eventKind: event.kind,
      });
    }
    const { reference, bytes, sha256 } = parsed.data;
    if (sourceKind === 'spill/created') {
      if (created.has(reference)) {
        throw integrityRefusal('Branch archive has duplicate spill/created event', {
          seq: event.seq,
          eventKind: event.kind,
        });
      }
      created.set(reference, { seq: event.seq, bytes, ...(sha256 ? { sha256 } : {}) });
    } else {
      if (deleted.has(reference)) {
        throw integrityRefusal('Branch archive has duplicate spill/deleted event', {
          seq: event.seq,
          eventKind: event.kind,
        });
      }
      const origin = created.get(reference);
      if (!origin || event.seq <= origin.seq) {
        throw integrityRefusal(
          'Branch archive has spill/deleted without prior spill/created',
          {
            seq: event.seq,
            eventKind: event.kind,
          },
        );
      }
      if (
        origin.bytes !== bytes ||
        (origin.sha256 !== undefined && sha256 !== undefined && origin.sha256 !== sha256)
      ) {
        throw integrityRefusal('Branch archive spill/deleted disagrees with spill/created', {
          seq: event.seq,
          eventKind: event.kind,
        });
      }
      deleted.set(reference, {
        seq: event.seq,
        bytes,
        ...(sha256 !== undefined
          ? { sha256 }
          : origin.sha256 !== undefined
            ? { sha256: origin.sha256 }
            : {}),
      });
    }
  }
  const liveSet = new Set(liveSpills.map((spill) => spill.reference));
  for (const [ref, meta] of deleted) {
    if (liveSet.has(ref)) {
      throw integrityRefusal('Branch archive has both a live spill and spill/deleted', {
        seq: meta.seq,
        eventKind: 'spill/deleted',
      });
    }
  }
  return {
    expiredSpills: [...deleted.keys()].sort(),
    deletedMeta: deleted,
  };
}

export interface BranchSource {
  conversationId: string;
  events: AgentStoreEventEnvelope[];
  spills: z.infer<typeof ArchiveSpillSchema>[];
  /** Spills referenced in the selected prefix that legitimately expired via `spill/deleted`. */
  expiredSpills: readonly string[];
  /**
   * Referenced expired spills whose `spill/deleted` occurred after the `throughRunId`
   * cutoff and must be recorded as synthetic observations so subsequent branches succeed.
   */
  tailDeletedSpills: readonly BranchExpiredSpillTail[];
  replay: BranchReplay;
  digest: string;
  /** What declarations would lift, collected over the whole archive; absent when nothing. */
  refused?: AgentConversationBranchRefusedError;
  /** Attachment references in the whole archive that are not spills: each needs a declaration. */
  applicationFiles: readonly string[];
}

/** Validate the complete archive before selecting a prefix; a truncated tail never looks complete. */
export function prepareBranchSource(
  bytes: Uint8Array,
  {
    source,
    applicationFiles = [],
    applicationKeys = [],
  }: Pick<
    ParsedBranchAgentConversationInput,
    'source' | 'applicationFiles' | 'applicationKeys'
  >,
): BranchSource {
  const archive = decodeAgentConversationArchive(bytes);
  if (source.kind === 'conversation' && source.conversationId !== archive.conversationId)
    throw new TypeError('Branch source identity changed');
  for (const [index, event] of archive.events.entries()) {
    if (event.seq !== index + 1)
      throw new TypeError('Branch source event sequence is incomplete');
  }
  const projections = archive.projections.map((value) =>
    z.union([SnapshotProjection, ArchiveProjectionSchema]).parse(value),
  );
  if (
    projections.some(
      (value, index) =>
        canonicalAgentJson(value) !== canonicalAgentJson(archive.projections[index]),
    )
  )
    throw new TypeError('Branch archive snapshot contains an unknown opaque field');
  const snapshots = projections.filter((value) => 'archiveType' in value);
  if (snapshots.length !== 1)
    throw new TypeError('Branch archive requires exactly one runtime snapshot');
  const names = new Set<string>();
  for (const projection of projections) {
    if (!('name' in projection)) continue;
    if (names.has(projection.name) || projection.uptoSeq > archive.events.length)
      throw new TypeError('Branch companion projection has an inconsistent checkpoint');
    names.add(projection.name);
  }
  // Companions are derived caches with application-defined values, never an
  // authority transfer codec. Rebuild them from the rekeyed destination ledger.
  const expected = snapshots[0]?.snapshot;
  if (!expected || expected.conversationId !== archive.conversationId)
    throw new TypeError('Branch archive has a foreign snapshot');
  const allSpills = archive.spills.map((value) => ArchiveSpillSchema.parse(value));
  if (new Set(allSpills.map((spill) => spill.reference)).size !== allSpills.length)
    throw new TypeError('Branch archive has duplicate spill identities');
  const { expiredSpills: allExpiredSpills, deletedMeta } = collectExpiredSpills(
    archive.events,
    allSpills,
  );
  const full = replayBranchEvents(archive.conversationId, archive.events, expected);
  const validationIds = new BranchIdentities(
    'branch-validation',
    'branch-validation',
    archive.conversationId,
  );
  for (const spill of allSpills) validationIds.define('spill', spill.reference);
  for (const expired of allExpiredSpills) validationIds.defineExpiredSpill(expired);
  validationIds.declareApplicationFiles(applicationFiles);
  validationIds.declareApplicationKeys(applicationKeys);
  // The complete supplied archive must be understood, including an unselected tail.
  // This is the same transfer planner used for the selected destination, without writes.
  rekeyBranchEvents(
    validationIds,
    archive.conversationId,
    archive.events,
    full.retainedMessages,
  );
  for (const spill of allSpills) {
    if (spill.runId) validationIds.reference('run', spill.runId);
    if (spill.toolCallId) validationIds.reference('call', spill.toolCallId);
  }
  // Collected over the whole archive: the selected prefix can only refuse less.
  const refused = validationIds.refusedError();
  if (
    canonicalAgentJson(visibleSnapshot(full.snapshot)) !==
    canonicalAgentJson(visibleSnapshot(expected))
  )
    throw new TypeError('Branch archive snapshot disagrees with its event log');
  const seq = boundary(
    archive.events,
    source.kind === 'conversation' ? source.throughRunId : undefined,
  );
  const events = archive.events.slice(0, seq);
  const replay =
    seq === archive.events.length
      ? full
      : replayBranchEvents(archive.conversationId, events, expected);
  if (replay.snapshot.runs.some((run) => isActiveRunState(run.state)))
    throw new TypeError('Branch boundary is not settled');
  if (replay.unresolvedDrafts.size > 0)
    throw new TypeError('Branch boundary has no full terminal content for a hashed draft');
  const selectedIds = new BranchIdentities(
    'branch-validation',
    'branch-validation',
    archive.conversationId,
  );
  for (const spill of allSpills) selectedIds.define('spill', spill.reference);
  for (const expired of allExpiredSpills) selectedIds.defineExpiredSpill(expired);
  selectedIds.declareApplicationFiles(applicationFiles);
  selectedIds.declareApplicationKeys(applicationKeys);
  rekeyBranchEvents(selectedIds, archive.conversationId, events, replay.retainedMessages);
  const references = selectedIds.referenced('spill');
  const spills = allSpills.filter((spill) => references.has(spill.reference));
  const expiredSpills = allExpiredSpills.filter((ref) => references.has(ref));
  if (spills.length + expiredSpills.length !== references.size)
    throw integrityRefusal('Branch source is missing a referenced spill');
  const tailDeletedSpills: BranchExpiredSpillTail[] = [];
  for (const ref of expiredSpills) {
    const meta = deletedMeta.get(ref);
    if (meta && meta.seq > seq) {
      tailDeletedSpills.push({
        reference: ref,
        bytes: meta.bytes,
        ...(meta.sha256 !== undefined && { sha256: meta.sha256 }),
      });
    }
  }
  return {
    conversationId: archive.conversationId,
    events,
    spills,
    expiredSpills,
    tailDeletedSpills,
    replay,
    ...(refused && { refused }),
    applicationFiles: validationIds.applicationFileReferences(),
    digest: branchHash({
      conversationId: archive.conversationId,
      events,
      spills,
      expiredSpills,
      snapshot: replay.snapshot,
    }),
  };
}
