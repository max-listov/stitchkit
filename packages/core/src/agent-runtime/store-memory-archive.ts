import { z } from 'zod';
import {
  type ArchiveProjection,
  ArchiveProjectionSchema,
  isRuntimeSnapshotEntry,
} from './archive-projection';
import { type ArchiveSpill, ArchiveSpillSchema } from './archive-spill';
import type { AgentRuntimeStoreDriver } from './store-driver-contract';

interface MemoryArchiveTransaction {
  spills: Map<string, ArchiveSpill[]>;
  projections: Map<string, ArchiveProjection[]>;
}

export const memoryArchive: NonNullable<
  AgentRuntimeStoreDriver<MemoryArchiveTransaction>['archive']
> = {
  async export(transaction, conversationId) {
    return {
      projections: z
        .array(z.json())
        .parse(structuredClone(transaction.projections.get(conversationId) ?? [])),
      spills: z
        .array(z.json())
        .parse(structuredClone(transaction.spills.get(conversationId) ?? [])),
    };
  },
  async import(transaction, archive) {
    const spills = archive.spills.map((value) => ArchiveSpillSchema.parse(value));
    const occupied = new Set(
      [...transaction.spills.values()].flatMap((entries) =>
        entries.map((spill) => spill.reference),
      ),
    );
    for (const spill of spills) {
      if (occupied.has(spill.reference))
        throw new TypeError('Conversation archive spill identity is already present');
      occupied.add(spill.reference);
    }
    transaction.spills.set(archive.conversationId, structuredClone(spills));
    // The runtime snapshot is the store's own state, not a companion: only the others are kept.
    const companions = archive.projections
      .filter((entry) => !isRuntimeSnapshotEntry(entry))
      .map((entry) => ArchiveProjectionSchema.parse(entry));
    // One row per name, as a durable store's key on (conversation, name) has it.
    if (new Set(companions.map((entry) => entry.name)).size !== companions.length)
      throw new TypeError('Conversation archive projection name is repeated');
    if (companions.length > 0)
      transaction.projections.set(
        archive.conversationId,
        structuredClone(companions).sort((left, right) =>
          left.name < right.name ? -1 : left.name > right.name ? 1 : 0,
        ),
      );
  },
};
