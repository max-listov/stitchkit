import { createHash } from 'node:crypto';
import { z } from 'zod';
import type { AgentStoreEventEnvelope } from '../durability/events';
import { ArchiveProjectionSchema } from './archive-projection';
import { ArchiveSpillSchema } from './archive-spill';
import type { BranchAgentConversationInput } from './branch-contract';
import { rekeyBranchEvents } from './branch-events';
import { BranchIdentities } from './branch-identities';
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

export interface BranchSource {
  conversationId: string;
  events: AgentStoreEventEnvelope[];
  spills: z.infer<typeof ArchiveSpillSchema>[];
  replay: BranchReplay;
  digest: string;
}

/** Validate the complete archive before selecting a prefix; a truncated tail never looks complete. */
export function prepareBranchSource(
  bytes: Uint8Array,
  source: BranchAgentConversationInput['source'],
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
  const full = replayBranchEvents(archive.conversationId, archive.events, expected);
  const validationIds = new BranchIdentities(
    'branch-validation',
    'branch-validation',
    archive.conversationId,
  );
  for (const spill of allSpills) validationIds.define('spill', spill.reference);
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
  rekeyBranchEvents(selectedIds, archive.conversationId, events, replay.retainedMessages);
  const references = selectedIds.referenced('spill');
  const spills = allSpills.filter((spill) => references.has(spill.reference));
  if (spills.length !== references.size)
    throw new TypeError('Branch source is missing a referenced spill');
  return {
    conversationId: archive.conversationId,
    events,
    spills,
    replay,
    digest: branchHash({
      conversationId: archive.conversationId,
      events,
      spills,
      snapshot: replay.snapshot,
    }),
  };
}
