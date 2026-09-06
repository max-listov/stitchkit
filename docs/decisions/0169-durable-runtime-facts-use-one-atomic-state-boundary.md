---
title: Durable runtime facts use one atomic state boundary
description: Lifecycle facts and notification delivery share an async atomic-update contract, while rendering and transport remain application-owned.
type: decision
status: accepted
created: 2026-09-06
updated: 2026-09-06
---

# 0169 — Durable runtime facts use one atomic state boundary

## Decision

`stitchkit/application` exposes an async `StateStore` with atomic `update`, a
bounded process-run ledger, and an at-least-once notification outbox. The Node
adapter in `stitchkit/server` serializes cross-process updates with an owned
lock and commits files by unique temporary write, fsync and rename.

Lifecycle transitions address a run by both `runId` and `pid`. Facts leave the
ledger through typed subscriptions and the managed resource value. The outbox
claims records with a lease, keeps a stable idempotency key across retries, and
applies declared retry and retention bounds.

## Why

Separate read-then-write helpers lose records during zero-downtime overlap.
Calling a delivery callback directly loses the notification when the process
dies between recording the fact and sending it. Both problems need the same
small persistence boundary; neither needs a database or a transport in core.

## Consequences

- Persistence can be a file, a database or a test fake, but atomic update is a
  semantic requirement rather than an adapter detail.
- Delivery is at-least-once; consumers deduplicate by the stable key.
- Message rendering, Telegram/email APIs and owner identity stay outside core.
- Corrupt or unreadable files are reported by policy rather than guessed clean.
- A run's termination says who recorded it: `clean` and `forced` by the process,
  `hot-reload` and `abnormal` by its successor. The ledger never rewrites a
  crash as a kill, and it does not decide alone whether two processes of one
  build overlapping is a crash — that is a deployment fact the application
  declares (`sameVersionOverlap`), defaulting to one process per build.
