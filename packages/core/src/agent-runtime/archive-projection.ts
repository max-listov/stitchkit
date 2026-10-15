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
