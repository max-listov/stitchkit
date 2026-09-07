---
title: A path policy runs before discovery or reading
description: One host-owned path admission callback gates direct file effects and omits denied paths from every discovery tool before content is opened.
type: decision
status: accepted
created: 2026-09-07
updated: 2026-09-07
---

# 0172 — A path policy runs before discovery or reading

## Decision

`createAgentCodingTools` accepts an optional async or synchronous `authorizePath({ path })`
callback. It is operation-independent: the same decision gates direct read, write and edit,
directory listing, glob and both search modes. Direct access to a denied path returns the ordinary
typed `FORBIDDEN` refusal; discovery omits the denied entry without revealing that it exists.

The contained walker asks the callback about a directory before descending and about a file before
opening it. A `search_files.include` matcher is part of that pre-read selection, so an excluded file
is not opened merely because filtering the result would later remove it. Descriptor-relative
containment remains the filesystem authority after admission, and symlinks remain refused or
skipped rather than becoming another policy resolution path.

The existing `authorize(operation)` callback stays responsible for the requested effect, query and
mutation facts. `authorizePath` answers the separate question that all file tools share: whether a
workspace-relative path may be disclosed or touched at all.

## Why

A single authorization for a broad search cannot authorize each file the scanner will encounter.
Filtering matches after a content scan is too late: every file has already been opened and read.
Directory-only exclusions are also not a credential policy, because protected files may live beside
ordinary source and direct read/write must agree with search.

Making every consumer copy the scanner would split containment, bounds and symlink behavior. Making
path admission another operation in the existing discriminated union would turn an additive policy
into a breaking exhaustive-match change. An optional callback adds the missing boundary without a
second file engine or a compatibility name.

## Consequences

- Hosts can express one `.env` or credential-path rule for every direct and broad file surface.
- A denied path is indistinguishable from an absent path in discovery output, while direct access is
  explicitly refused.
- The callback can use asynchronous policy state; traversal awaits each decision before opening the
  selected entry.
- `run_command` is unchanged: an allowed executable is not an OS sandbox and can only be constrained
  by process isolation and the executable contract.

## Amendment (0.84.0): denial is recursive, and the path has one spelling

The decision above said the callback is asked "about a directory before descending and about a
file before opening it". That described the walk, and the walk alone. Direct read, write and edit
asked only about the leaf, so one rule meant two things: `path !== 'credentials'` hid the directory
from `glob` and served `credentials/token.txt` to `read_file`, created files under it through
`write_file`, and rewrote it through `edit_file`. `list_directory` and `glob` given a base path
*inside* a denied directory disclosed it too, and disagreed with each other about the refusal shape.

Underneath that sat a defect older than this ADR. `contained-files` splits a relative path on
`[\\/]`, so `credentials\\token.txt` reaches `openat` as two segments — while every callback was
handed the string whole and read it as one name. That bypassed the **required**
`authorize({ operation, path })`, which every consumer has had since 0.70.0, for reads and for
writes alike: a rule denying `credentials/token.txt` refused that spelling and served, then
overwrote, the same file spelled with a backslash.

So two things are now part of the decision rather than of one implementation:

- **A path has one spelling.** A backslash in a requested path is refused, the way
  `isManagedFilePath` already refuses it for managed files. Refused rather than normalised: a
  backslash is a legal character in a Linux filename, and normalising would silently redefine which
  file the caller named — while the walk has read it as a separator all along, so such a file was
  never reachable through these tools.
- **`authorizePath` denial is recursive.** Direct access and discovery base paths ask about each
  ancestor of the path, outermost first, short-circuiting on the first refusal. Segment-wise, not by
  string prefix: denying `credentials` must not deny `credentials-backup`. The workspace root is not
  asked about — asking `.` on every direct access inverts every allow-list, which answers `false`
  for a root it never meant to deny. The required `authorize({ operation, path })` is unchanged and
  still answers once per operation; that asymmetry is the reason this callback exists, and it means
  a host relying on `authorize` alone has no per-file decision during `search_files` or `glob`.
  **The policy must therefore admit every directory on the way to a file**, the way POSIX needs
  `+x` on each directory in a path — a deny-list gets this for free, an allow-list must name the
  directories it leads through.

Consequences of the amendment:

- A path of depth N costs N+1 policy questions, and a host keeping an audit no longer sees the leaf
  once an ancestor has refused. Both are the price of one meaning instead of two.
- The refusal stays `FORBIDDEN` rather than `NOT_FOUND`. The policy runs before any filesystem
  access, so `FORBIDDEN` discloses the host's own rule to the host's own agent, not disk state — and
  an honest `NOT_FOUND` would require touching the disk under a denied ancestor, which is the one
  thing the policy exists to prevent.
- `run_command` remains outside the path policy: an executable needs process isolation, not path
  filtering. It is not outside the *shape* rule — `cwd` now goes through the same segment and
  separator validation as every file tool, because accepting spellings there that the file tools
  refuse was an asymmetry with no decision behind it.
