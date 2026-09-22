# 0193 — An unchecked signature must be visible

**Status:** Accepted
**Date:** 2026-09-22

## Context

The distribution primitive proved delivery and could not prove authorship. An
asset digest says the bytes that arrived are the bytes the manifest named; the
manifest and the assets come from one origin, so whoever replaces one replaces
the other. Worse, the manifest schema was an ordinary object and stripped what
it did not know — a signature published in the very same document reached
nobody, and a signed install had to fetch that document a second time and parse
it twice to see its own proof.

## Decision

`signature` is part of the schema. Ed25519 over `{name, version, commit,
builtAt, assets[]}`, every asset contributing its target, compression, size and
digest.

**What is signed is everything that acts before the digest can disagree.**
`url` is deliberately out: where a file is served from is the publisher's
business, and moving it must not invalidate the proof of what it contains.
`compression` is deliberately in, and this was nearly missed: it decides how the
transferred bytes are expanded, expansion happens before any digest check, and
one unsigned byte turns a small download into a large allocation with the
signature still valid. The expansion is additionally bounded by the signed
`size`.

**Five verdicts, and `unenforced` is the one that earns its keep.** A build with
no pinned key must keep updating, and the fact that nothing was checked has to
be *visible* rather than assumed. A silent "fine" from a check that never ran is
the failure this whole file exists to remove. `missing`, `unknown-key` and
`invalid` are distinguished because they call for different answers: a key
someone forgot to pin is not a forged signature.

**A bad verdict is not a fifth status.** `outdated` is an instruction to
install, and a manifest that failed its signature has not established that there
is a newer build worth installing — only that a document claims one. The check
answers `unknown` with the verdict in its reason, which keeps every consumer's
exhaustive `switch` compiling and never reads as a network failure.

## Consequences

**The channel is not an argument of the framework, and will not become one.**
The consuming project raised it and withdrew it after reading the installer
renderer, and they were right: the framework has no model of how URLs are built
and should not acquire one. A channel is two documents at two addresses.
`assertCliPublishable` is therefore told about *all* of them rather than taught
the shape of any — with one argument and two tracks it is silently useless, and
the person who installed the beta is told they are current forever.

`applyCliUpdate` needs the manifest when given a trust root, because an asset
alone carries nothing to verify. That is a signature change, named in the
migration.

Nothing was adopted from the consuming project's own implementation: that file
is not in this tree and was not read. Their measurements of it remain theirs.

One shared primitive came out of this — `writeFileAtomic` — and it is used by
the binary replacement, the backup and the batch checkpoint. The eight other
places in `src` with their own staged-plus-rename were **not** migrated in this
pass; that is a separate change and doing it here would have meant touching
unrelated scope. The primitive stages under a random name and creates
exclusively, because a name built from pid and clock is guessable and an
ordinary write follows a symlink: anyone able to write to the directory could
otherwise redirect a binary replacement through a planted link.
