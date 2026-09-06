---
title: React Query policy
description: One request-local server client, one browser singleton and explicit retry rules for Stitchkit API errors
type: guide
status: active
created: 2026-09-06
updated: 2026-09-06
---

# React Query policy

`stitchkit/react` contains policy adapters for TanStack Query. It does not own
application queries, cache keys or authentication.

## Query client per runtime

Create the getter once. On the server, pass React's `cache` so identity is local
to one render request. In the browser, the returned getter keeps one singleton
inside this factory only:

```ts
import { cache } from 'react'
import { createQueryClientFactory } from 'stitchkit/react'

export const getQueryClient = createQueryClientFactory({
  serverCache: cache,
  queryClient: {
    defaultOptions: { queries: { staleTime: 30_000 } },
  },
})
```

Pending queries are dehydrated so streaming SSR can resume them. Mutations do
not retry by default. Every TanStack default may still be supplied through
`queryClient`; a supplied query or mutation retry policy wins over the helper's
defaults.

## API error retries

`apiErrorRetry()` returns a TanStack retry predicate. The default retries one
network or `5xx` failure and refuses authorization, validation, abort and other
`4xx` errors:

```ts
const retry = apiErrorRetry({
  attempts: 2,
  never: ['UNAUTHORIZED', 'FORBIDDEN'],
  statusRanges: [[500, 599]],
})
```

Ranges are inclusive. The predicate uses `ApiError.is`, so it remains valid when
two bundles contain different copies of the class.

Authentication remains application-owned. Memoize the application's own
session query with `cache`; the generic starter does not invent a `getSession`
endpoint or cookie vocabulary.
