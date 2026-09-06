import {
  defaultShouldDehydrateQuery,
  environmentManager,
  QueryClient,
  type QueryClientConfig,
} from '@tanstack/react-query';
import { cache } from 'react';

// The template targets the published catalog release, so it cannot import
// `createQueryClientFactory` yet; the retry policy below is the part of that
// factory a released core already lets it state. UPGRADING names the cutover.
const config = {
  defaultOptions: {
    // One retry for queries, none for mutations — a mutation retried on a
    // timeout may run twice; a query only reads.
    queries: { staleTime: 30_000, retry: 1 },
    mutations: { retry: false },
    dehydrate: {
      shouldDehydrateQuery: (query) =>
        defaultShouldDehydrateQuery(query) || query.state.status === 'pending',
    },
  },
} satisfies QueryClientConfig;

function createQueryClient(): QueryClient {
  return new QueryClient(config);
}

const getServerQueryClient = cache(createQueryClient);
let browserQueryClient: QueryClient | undefined;

export function getQueryClient(): QueryClient {
  if (environmentManager.isServer()) return getServerQueryClient();
  browserQueryClient ??= createQueryClient();
  return browserQueryClient;
}
