import { z } from 'zod';
import { type ArchiveSpill, ArchiveSpillSchema } from './archive-spill';
import type { AgentRuntimeStoreDriver } from './store-driver-contract';

interface MemoryArchiveTransaction {
  spills: Map<string, ArchiveSpill[]>;
}

export const memoryArchive: NonNullable<
  AgentRuntimeStoreDriver<MemoryArchiveTransaction>['archive']
> = {
  async export(transaction, conversationId) {
    return {
      projections: [],
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
  },
};
