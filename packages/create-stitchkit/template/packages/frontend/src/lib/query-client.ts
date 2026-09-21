import { cache } from 'react';
import { createQueryClientFactory } from 'stitchkit/react';

// One request-local server client and one browser singleton, both from the
// framework. The local construction this replaced was a second implementation
// of the same thing: it restated the dehydration policy and the mutation rule,
// and it spelled the query retry as a plain `1`, which retries an unauthorized
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
