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
