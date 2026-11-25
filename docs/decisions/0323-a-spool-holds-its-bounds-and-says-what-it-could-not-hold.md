---
title: "ADR 0323 — A spool holds its bounds and says what it could not hold"
description: "The local spool behind createSpooledSink and createSpooledSpendStore keeps a finite memory and file bound; a record past it is refused to its writer with SPOOL_UNSPOOLED, a debt past it at recover goes to a .overflow file beside the spool, and a file that cannot be read is an unknown debt, never zero."
type: decision
status: accepted
amends: ["0184", "0317"]
created: 2026-11-25
updated: 2026-11-25
---

# ADR 0323 — A spool holds its bounds and says what it could not hold

Invariant I10, with I13. Amends [ADR 0184](0184-audit-machinery-not-audit-policy.md), which made
`createSpooledSink` at-least-once with no bound, and [ADR 0317](0317-spend-gateway-records-before-the-call.md),
whose spend ledger shares the same spool core. Authorises, under rule 6 of
[ADR 0198](0198-stable-is-earned-and-kept-on-a-budget.md), the breaking entry of the stable
`stitchkit/observability` that changes what `createSpooledSink` does at its bounds.

## Context

Up to 0.126 the spool had no bound. Each record went to the file while the store was down, and
`recover()` read the whole file into memory. An outage of hours grew the file without limit, and a
large enough file made the next start hold it all in memory. That is the unbounded retained state
I10 forbids: the spool exists to survive a store outage, and an outage is exactly when it grows.

0.127 bounds it: `maxPendingEntries` (default 10 000) undelivered records held in memory — the
spool keeps each one there to deliver a group in order — and `maxFileBytes` (default 64 MiB) on
disk. A bound needs an answer for what does not fit. Three places reach it: a new record while
the spool is full, a file over the bound at `recover()` (one 0.126 left, or one whose bound was
lowered), and a file `recover()` cannot read at all. Before this record, a record past the bound
reached its writer as the store's own error — the same error a record safely on disk gets — and
an unreadable file answered `{ replayed: 0, failed: 0 }`. Both told the caller nothing was wrong.

## Decision

1. **The bounds are finite and declared.** Memory holds at most `maxPendingEntries` undelivered
   records; the file holds at most `maxFileBytes`. `recover()` and compaction read the file line by
   line and keep at most those two bounds of it in memory, whatever the file's size.
2. **A record the spool cannot hold is refused to its writer, never dropped quietly.** The record
   is still offered to the store. When the store refuses it too, it is kept nowhere, and the writer
   is told so: `createSpooledSink().write` rejects with code `SPOOL_UNSPOOLED`, the store's refusal
   as `cause`, distinct from a row that is on disk and was refused (which rejects with the store's
   error, and `recover` offers it again). `onSpoolError` reports `SPOOL_FULL` with the bound
   (`entries` or `bytes`) and the record. `createSpooledSpendStore` rejects the same way, so the
   gateway refuses a call nothing would account for.
3. **A debt past the bound at `recover()` goes beside the file, not over it.** What the file still
   owes, when it does not fit, moves to `<path>.<milliseconds>.overflow`; `SpoolRecovery.quarantined`
   names it, `onSpoolError` reports `SPOOL_QUARANTINED`, and the spool goes on with an empty file so
   that new records are spooled rather than refused behind an old debt. The moved file is a spool of
   its own: one at its path with a bound it fits replays it. Records the replay offered and left owed
   are counted in `failed`; a file too large to read within the bound is moved whole and its records
   are not offered.
4. **An unreadable file is an unknown debt.** Any read failure but a missing file answers
   `unread: true` and reports `SPOOL_UNREADABLE` with the read error as `cause`; the file is left as
   it is.

## Alternatives

- **No bound, as in 0.126.** Rejected: it is I10's case, and it fails at the worst moment — a long
  outage — by exhausting disk or the memory of the next start.
- **Drop past the bound, report only through `onSpoolError`.** Rejected: an audit row lost with no
  sign at the call that wrote it is the one failure an audit layer may not have (I13). The writer
  must be able to keep the row, fail its request, or alert.
- **Block the writer until there is room.** Rejected: room comes only when the store recovers, so a
  request would wait on the outage it is reporting; a bound on wait is a second bound with the same
  question at its end.
- **Refuse new records while an old debt sits over the bound.** Rejected: it turns one outage that
  ended into a permanent loss of every new record. Moving the debt aside keeps both.

## Consequences

- At-least-once holds within the bounds. Past them the writer is told the row is kept nowhere; an
  application that must not lose one raises the bound for its outage budget, or keeps the row itself
  on `SPOOL_UNSPOOLED`.
- `recover()` results carry `quarantined` and `unread`; a startup check reads them together with
  `failed`. The migration is `spool-file-over-its-bound` in the upgrading guide.
- For the spend ledger, a quarantined debt holds attempts whose receipts may arrive later in the new
  file: the order "an attempt before its receipts" holds within each file, and the moved file is
  replayed before or beside the spool, as an operator does it.

## Limits

The bounds are per process and per file, like the spool (ADR 0184). The moved file is not replayed
by the spool that moved it; replaying it is owed work the result names.
