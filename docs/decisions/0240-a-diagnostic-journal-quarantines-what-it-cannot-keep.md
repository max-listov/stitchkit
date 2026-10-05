# 0240 — A diagnostic journal quarantines what it cannot keep, and its recovery status is a wire shape

**Status:** Accepted
**Date:** 2026-10-05

Amends ADR 0219. Invariants I8, I9, I10 and I13.

## Context

ADR 0219 made opening a journal refuse when it could not preserve evidence in place: a torn
active file with `maxFiles: 1`, a retained generation that is not a regular file, and a retained
file the writer cannot read. Each refusal kept the bytes and released the lock, and each one
stopped the process from starting.

A diagnostic journal is usually a dependency of the resources that write to it. One damaged or
unreadable archive of diagnostics then keeps the whole application down until an operator
intervenes, and nothing about the damage can be recorded, because the recorder is what refused.
Damage is not hypothetical: an unclean shutdown can leave a generation ending in hundreds of NUL
bytes. ADR 0219 rejected a quarantine because a sidecar registry adds its own lifecycle; it did not
weigh that cost against a refused start.

The recovery status is also read outside the process. A consuming project embeds
`DiagnosticJournalRecoveryStatusSchema` in its own local protocol, so the shape of that schema is
part of someone else's wire format.

## Decision

`createDiagnosticJournal` takes `onStartupRefusal: 'quarantine' | 'fail'`, default `quarantine`.

- `quarantine` renames the file to `<file>.quarantined-<epoch>` in the same directory, where
  `<epoch>` is the opening process's epoch from `getStatus().epoch`, and the journal starts. A link
  is renamed itself, never its target. Nothing is deleted and no registry is kept: the name is the
  record, it falls outside the generation pattern, so retention never reads, rotates or removes
  it, and removing it is the operator's call.
- Every open lists every `<file>.quarantined-*` beside the journal (the active file's and each
  generation's) in `getStatus().recovery.quarantined`, until the operator removes it. Files moved
  by this open come first with their `reason` and, for `unreadable`, the system error `code`;
  files earlier opens left follow by name with neither — their name carries the epoch of the
  open that moved them, and that open's status gave the reason. The list comes from the same
  directory listing that finds the generations and holds at most 32 entries;
  `quarantinedUnlisted` counts the rest. A quarantine that is named only once would let files pile
  up unseen after the first restart, and an unbounded list would let a directory of thousands of
  them grow every status.
- `fail` throws `DiagnosticJournalRecoveryError` and moves nothing. It is the choice for a journal
  that is a source of truth rather than diagnostics, whose damage must stop the process.
- When the rename itself fails, the refusal stands under either policy (`quarantineFailed: true`,
  both errors in an `AggregateError` cause): a file that can neither be kept in place nor moved
  aside is not silently ignored.

Every startup refusal is the one typed error with a `reason` from
`DiagnosticJournalStartupRefusalReasonSchema` (`torn-without-retention-slot`,
`not-a-regular-file`, `unreadable`) and the `file`, so a caller branches on a value, not a message.
Refusals that are not about retained evidence — the lock is held, the path is not absolute, the
active path is not a regular file, the directory cannot be listed — still throw as before; they are
configuration or environment faults, and a journal that started over them would not write.

The default is `quarantine` because it is the safe choice for a diagnostic tool: it removes no
bytes, it starts, and it says what it moved. `fail` is the safe choice only where losing the
ability to start is cheaper than writing past damage.

**No journal-level `degraded` mode.** The application kernel has a degraded path —
`reportHealth('degraded')` — but only for a resource declared `required: false`, and a required
resource cannot depend on an optional one. A journal that the application's required resources
depend on can therefore not be degraded without making them optional too. A quarantining journal
is not degraded anyway: it writes. Its resource reports `healthy`, and the dependants read what was
moved from the value they already hold, `journal.getStatus().recovery`. A journal that starts but
does not write would be a third, silent outcome beside "writes" and "refused"; an application that
wants it catches the typed refusal in its own optional resource and reports `degraded` there.

**`DiagnosticJournalRecoveryStatusSchema` is a wire shape.** It follows the maturity of
`stitchkit/application` (evolving). It is `.strict()`, so a reader that parses with an older copy
refuses a status carrying a key it does not know. Every change to its shape — an added optional
field included — is therefore listed under `⚠️ Breaking changes` with the entrypoint
`stitchkit/application`, so a consumer that embeds it in its own protocol learns of it before its
readers do. The `quarantined` and `quarantinedUnlisted` fields added by this decision are the
first such item.

## Alternatives

- Keep the refusal and let each consumer catch it: every consumer re-implements the same move
  aside, and the ones that do not stay down.
- Truncate or delete the damaged file: destroys the evidence the journal exists to keep.
- A `degraded` value on `onStartupRefusal`: needs a non-writing journal state and a health report
  from code that is not a managed resource, and cannot reach a required dependency (above).
- A quarantine directory or index file: a second store with its own lifecycle, which ADR 0219
  rejected for good reason; a recognisable sibling name needs neither.
- Report a quarantined file only on the open that moved it: the next start is silent, and files
  accumulate with nothing pointing at them.
- Delete quarantined files after an age or a count: the quarantine is the evidence; only the
  operator knows when it has been read.
- Relax the schema to `.passthrough()` so additions are non-breaking: hides an unknown field from
  a reader that validates on purpose; declaring the shape and listing each change is the honest
  contract.

## Verification

`packages/core/tests/diagnostic-journal-quarantine.test.ts` covers, on real files: a torn
single-slot file quarantined by default with its bytes preserved and a fresh active file written;
the same under `fail` throwing the typed refusal with its inspection and moving nothing; a
directory and a symlink in generation slots moved aside (the link, not its target) or refused; an
unreadable archive (`EACCES`, as an unprivileged user, with a readable control) quarantined with
its code or refused; a failed rename keeping the refusal with both causes; a later open naming the
quarantined file again without a reason and no longer naming it once the operator removed it; 40
earlier quarantined files beside a new move listed as the move first, then 31 by name, with
`quarantinedUnlisted: 9`, none removed by retention; and a required journal resource starting
over a damaged file with its dependant reading `recovery.quarantined`.
