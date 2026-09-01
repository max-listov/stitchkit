---
title: "ADR 0139: A coding-tool refusal is something a model can act on"
description: Ordinary outcomes of the Agent coding tools become typed refusals with instructive hints, constructed in the tool layer so the containment layer stays AppError-free and host causes stay scrubbed.
type: decision
status: accepted
created: 2026-09-01
updated: 2026-09-01
---

# ADR 0139 — A coding-tool refusal is something a model can act on

## Context

Every refusal the coding tools made was a plain `Error`. `toolResultFromError`
scrubs anything that is not an `AppError` down to a bare
`INTERNAL_SERVER_ERROR` — correct, because an internal cause must not leave the
process — so a missing file, an ambiguous snippet, a file that already exists
and a path outside the root all reached the model as the same empty failure.

Observed, not theorised: in a run of nine models on one task, a model met two of
these, concluded that writing files was unavailable to it, began writing
everything into the workspace root, and finally stopped writing code at all in
favour of prose about what it would have done.

The tools were unusable in a second way. `apply_patch` required a `baseSha256`
carried from the last read and defaulted to `dryRun: true`, so one edit was two
calls whose protocol the schema never showed. Half the models never managed an
edit; not finding a way to change a file, they rewrote whole files with
`write_file` and met its refusals too.

## Decision

**An ordinary outcome is a typed refusal; a host-level cause stays internal.**
The boundary is the layer, not the errno. A model is an operator inside the
workspace: a refusal phrased from a relative path and the facts of its own
request tells it nothing it could not read with `read_file`. So typed refusals
are constructed in the tool layer, from context that layer knows.
`contained-files.ts` — shared with harness resource discovery — stays
`AppError`-free, and everything it throws keeps being scrubbed. Default-deny:
a cause with no case in the tool layer is internal.

`ENOENT` on a path the model named is `NOT_FOUND`; `ENOENT` from a root that
vanished is not, and reaches nobody. `EACCES` and `ENOSPC` have no case and stay
generic. The artifact store returning an inconsistent `totalBytes` is a host
breaking its contract, not an outcome — also generic.

**The message travels inside the details it belongs to.** `toolResultFromError`
renders `details: appErr.details ?? { message }`, so structured details displace
the message entirely: the natural way to write an informative refusal — a count
plus a sentence — would have arrived as `{"occurrences":3}` with no sentence.
`codingRefusal` copies the message into the details, which makes that
unrepresentable rather than merely discouraged, and puts the *instruction* in
`hint`, where the Agent envelope carries it as `_hint`.

**`edit_file` replaces `apply_patch`.** One clean path, not two forms of one
mutation. The digest becomes optional — `oldText` is itself a freshness guard
for the region being changed — and `dryRun` defaults to off, so an edit is one
call. A caller wanting the whole-file guarantee still passes the digest
`read_file` returns, and `edit_file` returns the new one so the next edit chains
without re-reading.

Dropping the mandatory digest removed the check that made a stale computation
visible, so the window it guarded is closed rather than narrowed: the read, the
occurrence count and the construction of the new content all happen inside
`withCodingPathLock`. Without that, two concurrent edits of different snippets
in one file would each build a whole file from the same base and the second
write would erase the first. The lock is process-local — nine agents in one
process are covered; two processes over one workspace are not.

**`write_file` creates missing parents, and says what it created.** Every
mainstream tool set does, and the observed failure was that models do not read
refusals — they conclude. The walk that finds the missing directories runs
*before* authorization and reports them in the authorization payload, because a
host cannot authorize a mutation it has not been told about; the creation
happens after. Containment is unchanged: `mkdirat` has no `O_NOFOLLOW`, so the
guarantee comes from the `openDirectoryAt` that follows each create and refuses
a symlink. Auto-creation introduces one new risk — a typo becomes a successful
write into a tree nobody meant to make — so `createdDirectories` names what
appeared, which is the only signal by which a model catches its own `packags/`.

## Consequences

- The authorization union gains `edit`, `list` and `glob` and loses `patch`.
  The dangerous case is not the exhaustive matcher the compiler catches: a
  default-allow matcher silently authorizes operations the host never approved,
  and a default-deny one silently kills `edit_file`. The migration says so.
- `packages/core/tests/coding-tool-refusals.test.ts` enumerates the tools from
  `AGENT_CODING_TOOL_NAMES` and refuses one with no registered refusal, in the
  shape `option-effects` already uses. It asserts the *serialized* envelope, not
  the code alone — a gate checking only the code is green on exactly the
  message-displacement defect described above.
- The Darwin backend gains `createDirectoryAt`; it is the one part of this that
  cannot be proven on Linux, and the real-Darwin lane (→ ADR 0135) is where it
  is proven.
