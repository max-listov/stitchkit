import { createMutation, createQuery } from 'react-query-kit';
import { repositoryApi } from './client';

// No parentheses: the client is a module constant, because a same-origin path
// needs no address. The cross-origin variant pays for its address with a lazy
// accessor — see `cross-origin.ts`.
export const useRepository = createQuery({
  queryKey: ['repository'],
  fetcher: () => repositoryApi.read(),
});

export const useRefreshRepository = createMutation({
  mutationFn: () => repositoryApi.refresh(),
});
