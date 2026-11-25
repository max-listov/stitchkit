import { z } from 'zod';

/** Derived companion cache, distinct from the authoritative runtime snapshot. */
export const ArchiveProjectionSchema = z
  .object({
    name: z.string(),
    version: z.int().positive(),
    uptoSeq: z.int().nonnegative(),
    value: z.json(),
    updatedAt: z.string(),
  })
  .strict();
export type ArchiveProjection = z.infer<typeof ArchiveProjectionSchema>;

/** The archive entry that carries the store's own snapshot rather than a companion projection. */
export function isRuntimeSnapshotEntry<E>(entry: E): entry is E & { snapshot: unknown } {
  return (
    typeof entry === 'object' &&
    entry !== null &&
    !Array.isArray(entry) &&
    Reflect.get(entry, 'archiveType') === 'runtime-snapshot' &&
    'snapshot' in entry
  );
}
