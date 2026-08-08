import { isServer, QueryClient } from '@tanstack/react-query';
import { cache } from 'react';

function createQueryClient(): QueryClient {
  return new QueryClient({
    defaultOptions: {
      queries: { staleTime: 30_000, retry: 1 },
      dehydrate: { shouldDehydrateQuery: (query) => query.state.status === 'pending' },
    },
  });
}

const getServerQueryClient = cache(createQueryClient);
let browserQueryClient: QueryClient | undefined;

export function getQueryClient(): QueryClient {
  if (isServer) return getServerQueryClient();
  if (!browserQueryClient) browserQueryClient = createQueryClient();
  return browserQueryClient;
}
