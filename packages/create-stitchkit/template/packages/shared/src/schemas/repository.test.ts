import { describe, expect, test } from 'bun:test';
import { RepositorySnapshotSchema } from './repository';

describe('repository snapshot schema', () => {
  test('accepts a bounded GitHub snapshot', () => {
    const result = RepositorySnapshotSchema.safeParse({
      fullName: 'owner/repository',
      description: 'A repository',
      htmlUrl: 'https://github.com/owner/repository',
      language: 'TypeScript',
      visibility: 'PUBLIC',
      stars: 2,
      forks: 1,
      openIssues: 0,
      commitCount: 42,
      latestCommit: {
        sha: 'abc123',
        message: 'Ship the starter',
        committedAt: '2026-08-08T00:00:00Z',
      },
      cache: {
        state: 'fresh',
        fetchedAt: '2026-08-08T00:00:00Z',
        expiresAt: '2026-08-08T00:15:00Z',
      },
    });

    expect(result.success).toBe(true);
  });

  test('rejects repository visibility outside the database enum', () => {
    const result = RepositorySnapshotSchema.shape.visibility.safeParse('UNLISTED');

    expect(result.success).toBe(false);
  });
});
