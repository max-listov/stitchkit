import { createMutation, createQuery } from 'react-query-kit';
import { repositoryApi } from './client';

export const useRepository = createQuery({
  queryKey: ['repository'],
  fetcher: () => repositoryApi.read(),
});

export const useRefreshRepository = createMutation({
  mutationFn: () => repositoryApi.refresh(),
});
