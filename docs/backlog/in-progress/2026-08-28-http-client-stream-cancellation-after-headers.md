---
title: Configured HTTP client drops streaming cancellation after response headers
description: Keep caller cancellation attached to response-body ownership for contract streams and raw responses.
type: task
status: in-progress
created: 2026-08-28
updated: 2026-08-28
priority: P1
---

## Problem and evidence

Published 0.68.3: a contract NDJSON client constructed with
`createClient(contract, createHttpClient({ baseUrl, unix }))` receives its baseline,
but aborting the caller signal and calling the iterator's `return()` leaves the
server-side source subscribed for more than five seconds (including heartbeat writes).
Two real Unix subscribers both remained registered. Unary contract calls passed.

The source in `packages/core/src/browser/http.ts` wraps `responseType: 'response'`
in `createRequestCancellation().run()`. The run finishes at headers; its finally
removes the caller abort listener. Later `OwnedContractStream.return()` aborts the
outer signal, no longer connected to the transport request. The source is also
present in the 0.68.4 checkout. Do not claim 0.68.4 runtime repro without testing it.

## Reproduction

1. Define a GET contract stream with a Zod item, NDJSON framing and a 2-second heartbeat.
2. Implement a source that emits one baseline, then waits; count registrations and
   unregister on its handler signal or generator finalization.
3. Serve it on a private Unix socket and subscribe using the configured HTTP adapter.
4. Await the baseline, abort the caller signal, then await iterator `return()`.
5. Assert the server source unregisters within a bounded interval. The observed count
   stayed at two after a five-second wait for two cancelled subscribers.

## Required result

- [x] Preserve bounded header deadlines independently of body cancellation lifetime.
- [x] Cover quiet pending `next()`, cancellation at a yielded item, iterator return
      before its first `next()`, normal end, error, and raw response-body cancellation.
- [x] Prove server admission and Unix connection slots are actually reusable, not
      merely that local iterators settle; test both client construction forms.
- [ ] Preserve existing retry, error and timeout semantics; publish a patch with
      package-level Bun and Node proofs. No consumer cancellation shim.

The separate public `createClient` Fetch-config form has a stream-owned signal path;
it must be included as the parity comparison, not used to mark this adapter fixed.
