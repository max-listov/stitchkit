---
title: "ADR 0317: The spend gateway records the attempt before the call"
description: "Adds stitchkit/spend and stitchkit/spend/testing: one gateway fetch per paid provider records each attempt before the request is sent and closes it on every outcome, adds credentials only for the provider's origin, merges receipts by rank, spools the ledger to disk, and a token-level guard fails a project whose model calls go around it. Cost is the provider's word: pending and unknown never carry a number."
type: decision
status: accepted
amendedBy: ["0323"]
created: 2026-11-24
updated: 2026-11-25
---

# ADR 0317: The spend gateway records the attempt before the call

Serves **I7**, **I10** and **I12**. Relates to [ADR 0002](0002-generic-core.md).

## Context

Three consuming projects each wrote their own accounting of paid model calls, and
each lost calls in a different place: a record written after the response, so a
broken stream left none; a cost of `0` written where the provider had not said; a
model SDK imported in a new file that nobody routed through the ledger. The
records themselves were alike: who the call was for, what the provider reported,
and how it ended.

## Decision

- **One door per provider.** `createSpendGateway({ store, providers }).fetchFor(name)`
  is a `fetch` an SDK takes. Before the request is sent, `store.begin(attempt)`
  records it; a ledger that refuses stops the call. After it, exactly one
  `store.settle(receipt)` closes it — on success, an HTTP error, a broken stream,
  a cancelled read or a transport failure. A ledger failure after the call went
  out is reported, never thrown into the call.
- **Credentials stay with their origin (I12).** The provider's headers are added
  only to a URL on its `origin`; credential headers the caller set are dropped;
  redirects are refused; `x-request-id` carries the attempt id.
- **Attribution is required and generic.** A call outside
  `runWithSpendAttribution` with no `purpose` is refused. The record is free
  strings — `scope`, `purpose`, `operation`, `labels` — plus links to the agent
  runtime's run, invocation and step, filled by a `context` callback so
  `stitchkit/spend` never imports `agent-runtime` (ADR 0002, I15).
- **Cost is the provider's word.** `costUsd` exists only with `reported` or
  `free`; `pending` and `unknown` never carry a number, and `estimated` is never a
  fact. Receipts merge by rank (transport, reported usage, reconciler) with
  `mergeSpendReceipt`: monotone, so replays and late receipts converge.
- **The ledger survives its database (I10).** `createSpooledSpendStore` writes each
  record to a bounded `0o600` spool before the database; `recover` replays in file
  order and stops at the first refusal, so a receipt never reaches the store ahead
  of its attempt. (amended by ADR 0323: a debt past the spool's bounds at `recover`
  moves to a `.overflow` file beside it, and a record past them is refused with
  `SPOOL_UNSPOOLED`.) The spool core is shared with `observability`'s request-event
  sink.
- **Coverage is a test.** `stitchkit/spend/testing` scans tokens, not types: the
  installed TypeScript has no compiler API to depend on, and a peer-free scanner
  keeps the subpath optional-peer clean (I7). It is red on a listed SDK value
  import, key name or host outside the allowed files, on a stale allowance and on
  a scan of zero files.

## Consequences

- An application implements `SpendLedgerStore` once (two idempotent writes) and
  gets the recording order, the close on every path and the merge rule.
- A key or host assembled at run time is invisible to the guard; it is a guard
  against the ordinary mistake, not an adversary.
- Provider-specific reconciliation (OpenRouter's generation lookup) lives with the
  provider adapter, keyed by gateway name.
