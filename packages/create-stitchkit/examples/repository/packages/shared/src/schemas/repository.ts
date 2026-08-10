import { z } from 'zod';

export const RepositoryVisibilitySchema = z.enum(['PUBLIC', 'PRIVATE', 'INTERNAL']);
export type RepositoryVisibility = z.infer<typeof RepositoryVisibilitySchema>;

export const RepositorySnapshotSchema = z.object({
  fullName: z.string().min(1),
  description: z.string().nullable(),
  htmlUrl: z.url(),
  language: z.string().nullable(),
  visibility: RepositoryVisibilitySchema,
  stars: z.number().int().nonnegative(),
  forks: z.number().int().nonnegative(),
  openIssues: z.number().int().nonnegative(),
  commitCount: z.number().int().nonnegative(),
  latestCommit: z
    .object({
      sha: z.string().min(1),
      message: z.string().min(1),
      committedAt: z.iso.datetime(),
    })
    .nullable(),
  cache: z.object({
    state: z.enum(['fresh', 'revalidated', 'stale']),
    fetchedAt: z.iso.datetime(),
    expiresAt: z.iso.datetime(),
  }),
});

export type RepositorySnapshot = z.infer<typeof RepositorySnapshotSchema>;
