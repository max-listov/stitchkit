import { z } from 'zod';
import { CodingDeniedEntrySchema } from './coding-tool-contract';
import { DiscoveryCoverageSchema } from './contained-scan-contract';

export const SearchInputSchema = z
  .object({
    query: z.string().min(1).max(8_192),
    mode: z.enum(['path', 'content']).default('content'),
    regex: z
      .boolean()
      .default(false)
      .describe(
        'Treat `query` as a JavaScript regular expression without flags, run in linear time: groups, alternation, classes, anchors, quantifiers and (?ims:) modifiers; no backreferences or lookaround.',
      ),
    context: z.int().nonnegative().max(10).default(0),
    include: z
      .string()
      .min(1)
      .max(4_096)
      .describe(
        'Anchored `**`/`*`/`?` pattern matched against the whole workspace-relative path. `*` does not cross `/`; use `**/` to include matching files in subdirectories.',
      )
      .optional(),
  })
  .strict();
export type SearchInput = z.infer<typeof SearchInputSchema>;

export const SearchMatchSchema = z
  .object({
    path: z.string().min(1),
    line: z.int().positive().optional(),
    text: z.string().optional(),
    before: z.array(z.string()).optional(),
    after: z.array(z.string()).optional(),
  })
  .strict();
export type SearchMatch = z.infer<typeof SearchMatchSchema>;

export const SearchOutputSchema = z
  .object({
    matches: z.array(SearchMatchSchema),
    truncated: z.boolean(),
    scannedFiles: z
      .int()
      .nonnegative()
      .describe(
        'Files admitted by include and host authorization that reached path or content comparison.',
      ),
    skippedDirectories: z.int().nonnegative(),
    skippedSymlinks: z.int().nonnegative(),
    denied: z.array(CodingDeniedEntrySchema).optional(),
    deniedTruncated: z.boolean().optional(),
    errors: z
      .array(z.object({ path: z.string(), operation: z.string(), code: z.string() }).strict())
      .optional(),
    errorsTruncated: z.boolean().optional(),
    hint: z.string().min(1).optional(),
    coverage: DiscoveryCoverageSchema,
  })
  .strict();
export type SearchOutput = z.infer<typeof SearchOutputSchema>;
