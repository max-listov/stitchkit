import { env } from '@app/config';
import { RepositoryVisibility } from '@app/db';
import type { RepositorySnapshot } from '@app/shared';
import { z } from 'zod';
import { prisma } from '../../lib/db';
import { domainErrors } from '../errors';

const GitHubRepositoryResponseSchema = z.object({
  full_name: z.string(),
  description: z.string().nullable(),
  html_url: z.url(),
  language: z.string().nullable(),
  visibility: z.enum(['public', 'private', 'internal']),
  stargazers_count: z.number().int().nonnegative(),
  forks_count: z.number().int().nonnegative(),
  open_issues_count: z.number().int().nonnegative(),
});

const GitHubCommitResponseSchema = z.array(
  z.object({
    sha: z.string().min(1),
    commit: z.object({
      message: z.string().min(1),
      author: z.object({ date: z.iso.datetime().nullable() }).nullable(),
      committer: z.object({ date: z.iso.datetime().nullable() }).nullable(),
    }),
  }),
);

const RepositoryNameSchema = z
  .string()
  .regex(/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/, 'Expected owner/repository');

type RepositoryFetcher = (url: URL, init: RequestInit) => Promise<Response>;
export interface SnapshotRecord {
  fullName: string;
  description: string | null;
  htmlUrl: string;
  language: string | null;
  visibility: RepositoryVisibility;
  stars: number;
  forks: number;
  openIssues: number;
  commitCount: number;
  latestCommitSha: string | null;
  latestCommitMessage: string | null;
  latestCommittedAt: Date | null;
  fetchedAt: Date;
  expiresAt: Date;
}

function repositoryVisibility(
  visibility: z.infer<typeof GitHubRepositoryResponseSchema>['visibility'],
): RepositoryVisibility {
  switch (visibility) {
    case 'public':
      return RepositoryVisibility.PUBLIC;
    case 'private':
      return RepositoryVisibility.PRIVATE;
    case 'internal':
      return RepositoryVisibility.INTERNAL;
  }
}

export interface RepositorySnapshotStore {
  read(fullName: string): Promise<SnapshotRecord | null>;
  write(snapshot: SnapshotRecord): Promise<SnapshotRecord>;
}

const snapshotStore: RepositorySnapshotStore = {
  read: (fullName) => prisma.repositorySnapshot.findUnique({ where: { fullName } }),
  write: (snapshot) =>
    prisma.repositorySnapshot.upsert({
      where: { fullName: snapshot.fullName },
      create: snapshot,
      update: snapshot,
    }),
};

function githubHeaders(): Headers {
  const headers = new Headers({
    Accept: 'application/vnd.github+json',
    'User-Agent': 'stitchkit-starter',
    'X-GitHub-Api-Version': '2026-03-10',
  });
  if (env.GITHUB_TOKEN) headers.set('Authorization', `Bearer ${env.GITHUB_TOKEN}`);
  return headers;
}

function commitCount(response: Response, visibleCommits: number): number {
  const link = response.headers.get('link');
  const lastPage = link?.match(/<[^>]*[?&]page=(\d+)[^>]*>; rel="last"/)?.[1];
  return lastPage ? z.coerce.number().int().nonnegative().parse(lastPage) : visibleCommits;
}

function serialize(
  record: SnapshotRecord,
  state: RepositorySnapshot['cache']['state'],
): RepositorySnapshot {
  const latestCommit =
    record.latestCommitSha && record.latestCommitMessage && record.latestCommittedAt
      ? {
          sha: record.latestCommitSha,
          message: record.latestCommitMessage,
          committedAt: record.latestCommittedAt.toISOString(),
        }
      : null;

  return {
    fullName: record.fullName,
    description: record.description,
    htmlUrl: record.htmlUrl,
    language: record.language,
    visibility: record.visibility,
    stars: record.stars,
    forks: record.forks,
    openIssues: record.openIssues,
    commitCount: record.commitCount,
    latestCommit,
    cache: {
      state,
      fetchedAt: record.fetchedAt.toISOString(),
      expiresAt: record.expiresAt.toISOString(),
    },
  };
}

export class GitHubRepositoryCache {
  private refreshPromise?: Promise<RepositorySnapshot>;

  constructor(
    private readonly fetcher: RepositoryFetcher = (url, init) => fetch(url, init),
    private readonly store: RepositorySnapshotStore = snapshotStore,
  ) {}

  async read(): Promise<RepositorySnapshot> {
    const repository = RepositoryNameSchema.parse(env.GITHUB_REPOSITORY);
    const snapshot = await this.store.read(repository);
    if (snapshot && snapshot.expiresAt > new Date()) return serialize(snapshot, 'fresh');
    return this.refresh();
  }

  refresh(): Promise<RepositorySnapshot> {
    if (this.refreshPromise) return this.refreshPromise;
    this.refreshPromise = this.revalidate().finally(() => {
      this.refreshPromise = undefined;
    });
    return this.refreshPromise;
  }

  private async revalidate(): Promise<RepositorySnapshot> {
    const repositoryName = RepositoryNameSchema.parse(env.GITHUB_REPOSITORY);
    const previous = await this.store.read(repositoryName);

    try {
      const [repositoryResponse, commitsResponse] = await Promise.all([
        this.fetcher(new URL(`/repos/${repositoryName}`, 'https://api.github.com'), {
          headers: githubHeaders(),
          signal: AbortSignal.timeout(8_000),
        }),
        this.fetcher(
          new URL(`/repos/${repositoryName}/commits?per_page=1`, 'https://api.github.com'),
          { headers: githubHeaders(), signal: AbortSignal.timeout(8_000) },
        ),
      ]);
      if (!repositoryResponse.ok || !commitsResponse.ok) {
        throw new Error(
          `GitHub returned repository=${repositoryResponse.status}, commits=${commitsResponse.status}`,
        );
      }

      const repository = GitHubRepositoryResponseSchema.parse(await repositoryResponse.json());
      const commits = GitHubCommitResponseSchema.parse(await commitsResponse.json());
      const latest = commits[0];
      const committedAt = latest?.commit.author?.date ?? latest?.commit.committer?.date;
      if (latest && !committedAt) throw new Error('The latest GitHub commit has no timestamp');

      const fetchedAt = new Date();
      const snapshot = await this.store.write({
        fullName: repository.full_name,
        description: repository.description,
        htmlUrl: repository.html_url,
        language: repository.language,
        visibility: repositoryVisibility(repository.visibility),
        stars: repository.stargazers_count,
        forks: repository.forks_count,
        openIssues: repository.open_issues_count,
        commitCount: commitCount(commitsResponse, commits.length),
        latestCommitSha: latest?.sha ?? null,
        latestCommitMessage: latest?.commit.message.split('\n')[0] ?? null,
        latestCommittedAt: committedAt ? new Date(committedAt) : null,
        fetchedAt,
        expiresAt: new Date(fetchedAt.getTime() + env.GITHUB_CACHE_TTL_SECONDS * 1_000),
      });
      return serialize(snapshot, 'revalidated');
    } catch (error) {
      if (previous) return serialize(previous, 'stale');
      throw domainErrors.GITHUB_UNAVAILABLE({
        message: 'GitHub repository data is temporarily unavailable',
        details: { cause: error instanceof Error ? error.message : 'Unknown upstream error' },
        hint: 'Retry after the upstream service recovers',
      });
    }
  }
}
