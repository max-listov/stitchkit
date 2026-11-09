import { z } from 'zod';
import { MAX_TIMER_MS } from '../internal/timers';

// The native directory reader accepts a signed C int, independently of timer limits.
const MAX_DIRECTORY_ENTRIES = 0x7fffffff;

export const AgentCodingSearchLimitsSchema = z
  .object({
    maxSearchResults: z.int().positive(),
    maxSearchFiles: z.int().positive(),
    maxSearchDepth: z.int().nonnegative(),
    maxSearchDirectories: z.int().positive(),
    maxSearchEntries: z.int().positive().max(MAX_DIRECTORY_ENTRIES),
    maxSearchBytes: z.int().positive(),
    maxSearchOutputBytes: z.int().min(1_024),
    searchTimeoutMs: z.int().positive().max(MAX_TIMER_MS),
  })
  .strict();
export type AgentCodingSearchLimits = z.infer<typeof AgentCodingSearchLimitsSchema>;
