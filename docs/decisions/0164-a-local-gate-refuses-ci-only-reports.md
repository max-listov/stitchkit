---
title: A local gate refuses; CI only reports
description: The publication-privacy scan sat inside a memo whose key could not describe its input, so a push skipped it and published a real machine path. CI went red afterwards, which for a public repository is a report, not a refusal.
type: decision
status: active
created: 2026-09-05
updated: 2026-09-05
---

# 0164 — A local gate refuses; CI only reports

## Decision

The publication-privacy scan runs on **every** push, beside the release
metadata gate, outside the `verify` memo. It is not memoised, not conditional
and not part of the suite the memo can skip.

## The arithmetic

`verify` remembers a green run under a working-tree hash, and that hash is taken
with `git add --all .` into a scratch index — so it counts untracked files. The
scan reads the **real** index, so it does not. The two notions of "the tree"
agree everywhere except one transition:

| step | tree hash | what the scan sees |
| --- | --- | --- |
| write a new file | `H` | not there |
| run the gate | `H` — remembered green | not there |
| `git add` | `H` (no content changed) | **there** |
| push | `H` — memo hits, suite skipped | never asked |

Measured on a clone rather than argued: the same hash yields 30 findings before
`git add` and 31 after. The key does not move; the verdict does.

## What it cost

`920f7c3` put a real machine home path into a comment in
`packages/core/scripts/check-declarations-strict.mjs`, in a public repository.
It is not quoted here: this gate refused the first push of this very file for
containing it, which is a better demonstration than the quotation would have
been — and the file was new and untracked, so the memo would have skipped it.
The rule that matches it, `non-synthetic Linux home path`, fires on that exact
line; confirmed by calling `privateShapes` directly.

The scan was not blind. It was **late**. CI ran it and went red on that commit,
naming the file and line:

```
+ "packages/core/scripts/check-declarations-strict.mjs:111 non-synthetic Linux home path"
```

But a push to a public repository publishes at the moment of the push. CI
answers afterwards, so its red is a report about something the world can already
read. The path stayed public for a day and was scrubbed by hand in 0.80.1 —
which repaired the string and left the mechanism, so the next new file would
have gone the same way.

This is the distinction the pre-push hook exists for and the reason it is worth
its seconds: **a local gate can refuse, and CI can only report.** For anything
whose damage is done by publication rather than by being wrong, that is the
whole difference.

## Why not widen the memo key

The memo already carries two inputs a tree cannot show — the PostgreSQL server
version and the installed browser set — precisely because a key that does not
describe a gate's input is a key that lies. Trackedness is a third such input,
so folding the index into the key looks like the consistent move.

It is the wrong trade. `git add` would then invalidate every remembered run,
and a release push would re-spend thirteen minutes of heavy lanes — building
Next twice, driving three browsers, running a supervisor — to satisfy a check
that takes **367 milliseconds**. The expensive lanes read the working tree,
where nothing changed; only this one reads the index.

So the cheap gate leaves the memo instead of the expensive ones joining it.

## Consequence

- A file cannot enter history without the scan having looked at it.
- An untracked file is still not flagged: the scan's scope is deliberate, and
  a `.gitignore`d scratch file that no clone will receive stays unflagged —
  verified from both sides.
- `STITCHKIT_EXEMPTIONS` moved from the test into `publication-privacy.ts`. Two
  callers now need it, and of two copies the one that drifted would be the one
  deciding what reaches a public repository.
- `scripts/` is not in the published package, so this leak reached git and never
  npm. That was luck about which directory it landed in, not a property of the
  system.

## Related

- ADR 0161 — a gate that recognises one error is blind to every other.
- ADR 0162 — a gate that reddens from load teaches you to disbelieve red.
