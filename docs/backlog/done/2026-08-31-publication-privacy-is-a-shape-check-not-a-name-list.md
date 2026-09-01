---
title: Publication privacy is checked by shape, not by a list of names
description: Anonymisation at write time holds today, but nothing enforces it. A form-based gate over the tree and the packed artifact turns that discipline into a check without publishing a registry of the names it protects.
type: task
status: done
created: 2026-08-31
updated: 2026-08-31
completed: 2026-08-31 17:36 +00:00
---

## Зачем

This repository is public and its boundary is anonymisation **at write time**:
consumer pain is written as a reproducible technical case, never as "project X
asked for it". Measured today across `docs/`, `packages/`, `scripts/` and the
root markdown: zero occurrences of any private fleet project name. 481 closed
tasks disclose nothing, because by construction there is nothing in them to
disclose.

The weakness is not the boundary, it is that **nothing enforces it**. One
inattentive writer reintroduces a name and no gate notices.

The obvious fix is wrong. A gate that greps for a list of private project names
would have to keep that list in the public repository — publishing exactly what
it protects.

## Результат

A gate that checks **forms**, knowing no names:

- agent/session routing markers (`^responsible:`, `^target-repo:`, session
  vocabulary);
- non-public home paths on either Linux or macOS, with a whitelist of the
  synthetic user names fixtures use;
- fleet node identity — an all-caps host name suffixed with its environment;
- credentials embedded in a URL's userinfo, with an explicit whitelist of the
  placeholder pairs this repository writes on purpose.

Findings carry file/line/rule. A second layer runs the same scan over the
**unpacked published artifact** (`bun pm pack` → extract → scan), which catches
"the tree is clean but the tarball is not".

The value is that no registry of secrets is needed: the node-identity pattern
catches a machine that does not exist yet, and the home-path pattern catches a
project created tomorrow.

## What it deliberately does not catch

A private project named in prose with no path and no capitals. Only write-time
discipline covers that; the gate insures from the other side rather than
replacing it.

## Источник

A working implementation exists in a sibling private repository
(`scripts/publication-privacy.ts`, ~118 lines, plus a ~207-line packed-artifact
test layer). It is generic and was offered for direct reuse; adopt it rather
than re-deriving the patterns.

## Что сделано

### Scripts

- [x] `scripts/publication-privacy.ts` — the shape scanner, adopted from a working
      implementation in a sibling repository rather than re-derived. It knows no
      names: agent/session routing markers, non-synthetic home paths, fleet-style
      node identity, credentials in URLs.
- [x] `STITCHKIT_CONVENTIONS` — the names this repository writes on purpose,
      supplied rather than compiled in. Adopted with the upstream defaults it
      reported 31 findings here, of which one was real; the rest were another
      repository's naming.
- [x] `trackedPublicationBlobs` — every tracked text blob in **one**
      `git cat-file --batch` pass. Per-file `git show` was a thousand spawns and
      timed out at five seconds; this runs in ~300 ms.

### Два дефекта, найденных использованием, а не чтением

- [x] The adopted design read tracked **paths** and then the **working tree's**
      contents for them. That answers a different question than it claims: an
      uncommitted edit, a staged rename or a file deleted from the working tree
      all make the two disagree. Fixed by reading git's own copy.
- [x] Reading `HEAD` looked correct and was a hole — a **staged** leak was green,
      and would be reported one run later, after the commit that made it
      permanent. Found by falsification, not by review: the first attempt to
      stage a real leak did not turn the gate red. The scope now reads the
      INDEX, which is what the next commit will carry; on CI the index equals
      `HEAD`, so one implementation answers both "about to become history" and
      "already history".

### Tests

- [x] `scripts/publication-privacy.test.ts` — four tests: every shape fires on a
      line that should trip it; this repository's own conventions do not trip it,
      while a genuine credential still does; a stale exemption is refused; and
      what git carries has nothing private left unexplained.
- [x] The gate lives in `bun test scripts/*.test.ts`, which is part of `test` and
      therefore of the **fast** profile — every ordinary push runs it, with no
      new lane and no CI parity change.

### Findings

- [x] One real: a development host name in three lines of two `done/` documents.
      Exempted rather than redacted, with the reason written at the exemption —
      the repository is public and its objects are already published, so removing
      the name from `HEAD` would not unpublish it, and `done/` is immutable by
      rule. Redaction remains an owner decision; the exemption is the record of
      it, and removing the exemption is how it gets reversed.
- [x] Fifteen exemptions in total, each with its reason at the occurrence. Most
      are tests that feed the scanner's own shapes in *to prove they are
      refused* — a redaction test has to contain the thing it redacts.
- [x] `scripts/starter-database.ts` interpolates `${role}:${password}`. Not a
      credential: a value containing `${` is by construction not a secret. Left
      as an exemption rather than a scanner change, to keep this copy mergeable
      with upstream; reported there as a portable improvement.

### Что не сделано

- [x] The packed-artifact layer. Measured first rather than assumed: 604 built
      files across both packages, **zero** findings — the build embeds no path
      the source does not already carry. It remains worth having for the case it
      exists for (a future sourcemap carrying an absolute path), but it needs a
      new `verify` step plus a matching `gate-parity` entry, and it finds nothing
      today. Named here instead of silently skipped.
- [x] The working-tree/pre-commit layer. The scanner supports the scope; wiring
      it is a hook change, and the tracked layer already refuses the leak one
      moment later, before it can become permanent.
