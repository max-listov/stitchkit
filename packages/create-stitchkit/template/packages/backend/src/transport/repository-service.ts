import { repositoryContract } from '@app/shared';
import { implement } from 'stitchkit/server';
import { GitHubRepositoryCache } from '../domain/repository/github-cache';

export function createRepositoryService(
  onRefresh: (snapshot: Awaited<ReturnType<GitHubRepositoryCache['refresh']>>) => void,
) {
  const github = new GitHubRepositoryCache();

  return implement(repositoryContract, {
    read: () => github.read(),
    refresh: async () => {
      const snapshot = await github.refresh();
      onRefresh(snapshot);
      return snapshot;
    },
  });
}
