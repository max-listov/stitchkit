import { defaultShouldDehydrateQuery, isServer, QueryClient } from '@tanstack/react-query';
import { cache } from 'react';

function createQueryClient(): QueryClient {
  return new QueryClient({
    defaultOptions: {
      queries: { staleTime: 30_000, retry: 1 },
      dehydrate: {
        // `pending` queries dehydrate too: a server component may kick off a
        // prefetch without awaiting it, and streaming SSR hands the in-flight
        // promise to the client, which resumes it instead of refetching. The
        // default predicate would drop exactly those queries and reintroduce
        // the client-side loading flash.
        shouldDehydrateQuery: (query) =>
          defaultShouldDehydrateQuery(query) || query.state.status === 'pending',
      },
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
