import { describe, expect, test } from 'bun:test';
import { RepositoryVisibility } from '@app/db';
import { RepositoryVisibilitySchema } from '@app/shared';
import {
  GitHubRepositoryCache,
  type RepositorySnapshotStore,
  type SnapshotRecord,
} from './github-cache';

function repositoryResponse(): Response {
  return Response.json({
    full_name: 'max-listov/stitchkit',
    description: 'Contract-first framework',
    html_url: 'https://github.com/max-listov/stitchkit',
    language: 'TypeScript',
    visibility: 'public',
    stargazers_count: 42,
    forks_count: 7,
    open_issues_count: 1,
  });
}

function commitsResponse(): Response {
  return Response.json(
    [
      {
        sha: 'abcdef123456',
        commit: {
          message: 'Ship the starter\n\nDetails',
          author: { date: '2026-08-08T00:00:00Z' },
          committer: { date: '2026-08-08T00:00:00Z' },
        },
      },
    ],
    {
      headers: {
        link: '<https://api.github.com/repositories/1/commits?per_page=1&page=314>; rel="last"',
      },
    },
  );
}

describe('GitHubRepositoryCache', () => {
  test('keeps the shared wire enum aligned with the database enum', () => {
    expect([...RepositoryVisibilitySchema.options].sort()).toEqual(
      Object.values(RepositoryVisibility).sort(),
    );
  });

  test('deduplicates refreshes and persists an exact repository snapshot', async () => {
    const requests: URL[] = [];
    const fetcher = async (url: URL) => {
      requests.push(url);
      return url.pathname.endsWith('/commits') ? commitsResponse() : repositoryResponse();
    };
    let stored: SnapshotRecord | null = null;
    const store: RepositorySnapshotStore = {
      read: async () => stored,
      write: async (snapshot) => {
        stored = snapshot;
        return snapshot;
      },
    };

    const cache = new GitHubRepositoryCache(fetcher, store);
    const [first, concurrent] = await Promise.all([cache.read(), cache.read()]);

    expect(first).toEqual(concurrent);
    expect(first.fullName).toBe('max-listov/stitchkit');
    expect(first.visibility).toBe('PUBLIC');
    expect(first.commitCount).toBe(314);
    expect(first.latestCommit?.message).toBe('Ship the starter');
    expect(first.cache.state).toBe('revalidated');
    expect(requests).toHaveLength(2);

    const cached = await cache.read();
    expect(cached.cache.state).toBe('fresh');
    expect(requests).toHaveLength(2);
  });
});
