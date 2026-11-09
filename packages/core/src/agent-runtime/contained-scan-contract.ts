import { z } from 'zod';

export const ScanStopReasonSchema = z.enum([
  'max-files',
  'max-depth',
  'max-directories',
  'max-entries',
  'max-bytes',
  'max-results',
  'max-output-bytes',
  'cancelled',
  'timeout',
  'denied',
  'unreadable',
  'max-file-bytes',
  'max-line-bytes',
]);
export type ScanStopReason = z.infer<typeof ScanStopReasonSchema>;

export const DiscoveryCoverageSchema = z
  .object({
    complete: z.boolean(),
    reasons: z.array(ScanStopReasonSchema),
    scope: z
      .object({
        path: z.string(),
        include: z.string(),
        excludedDirectories: z.enum(['default', 'configured']),
        symlinks: z.enum(['skip', 'list']),
      })
      .strict(),
    visitedDirectories: z.int().nonnegative(),
    visitedEntries: z.int().nonnegative(),
    readBytes: z.int().nonnegative(),
    elapsedMs: z.number().nonnegative(),
  })
  .strict();
