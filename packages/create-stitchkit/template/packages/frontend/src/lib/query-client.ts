import { cache } from 'react';
import { createQueryClientFactory } from 'stitchkit/react';

// One request-local server client and one browser singleton, both from the
// framework. The factory owns the dehydration policy, mutation rule and query
// retry. A plain retry count of `1` would retry an unauthorized
// or invalid request exactly as eagerly as a network blip. `apiErrorRetry` —
// the factory's default — retries what is worth retrying and nothing else.
// Project-specific cache configuration and mutation toasts belong in these
// options, never in a copy of the framework's retry predicate.
export const getQueryClient = createQueryClientFactory({
  serverCache: cache,
  queryClient: {
    defaultOptions: { queries: { staleTime: 30_000 } },
  },
});
